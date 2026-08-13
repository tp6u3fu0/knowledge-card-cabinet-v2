import json
import hashlib
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from secrets import compare_digest
from typing import Any

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row

from .config import settings
from .covers import COVER_VERSION, build_cover
from .embeddings import vector_literal


BACKUP_FORMAT_VERSION = 2
SCHEMA_VERSION = 3


def _checksum_payload(payload: dict[str, Any]) -> str:
    unsigned = {
        key: value
        for key, value in payload.items()
        if key not in {"checksum_sha256", "exported_at", "backup_reason", "backed_up_at", "conflict_strategy"}
    }
    canonical = json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _connect() -> psycopg.Connection:
    return psycopg.connect(settings.database_url, row_factory=dict_row)


def get_connection() -> psycopg.Connection:
    connection = _connect()
    register_vector(connection)
    return connection


def _existing_embedding_dimension() -> int | None:
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT format_type(attribute.atttypid, attribute.atttypmod) AS data_type
            FROM pg_attribute AS attribute
            JOIN pg_class AS table_ref ON table_ref.oid = attribute.attrelid
            JOIN pg_namespace AS namespace_ref ON namespace_ref.oid = table_ref.relnamespace
            WHERE table_ref.relname = 'cards'
              AND namespace_ref.nspname = current_schema()
              AND attribute.attname = 'embedding'
              AND NOT attribute.attisdropped
            """
        ).fetchone()
    if not row:
        return None
    match = re.search(r"vector\((\d+)\)", str(row["data_type"]))
    return int(match.group(1)) if match else None


def ensure_schema() -> bool:
    dimension = settings.embedding_dimensions
    existing_dimension = _existing_embedding_dimension()
    dimension_migrated = existing_dimension is not None and existing_dimension != dimension
    if dimension_migrated:
        # Preserve the old vectors before changing the pgvector typmod. The
        # card text remains intact, and startup reindexing will regenerate all
        # vectors using the new dimension.
        create_backup_file(settings.backup_dir, reason=f"vector-dimension-{existing_dimension}-to-{dimension}")
    with _connect() as connection:
        connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
        register_vector(connection)
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        migration_row = connection.execute(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
        ).fetchone()
        current_schema_version = int(migration_row["version"] if migration_row else 0)
        if current_schema_version < 1:
            # Version 1 is the original cards/runtime schema. Recording it
            # lets older databases enter the same upgrade path safely.
            connection.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (1, 'baseline') ON CONFLICT DO NOTHING"
            )
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS cards (
                id TEXT PRIMARY KEY,
                number TEXT NOT NULL,
                topic TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL,
                question TEXT NOT NULL,
                summary TEXT NOT NULL,
                analogy TEXT NOT NULL,
                detail TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT '',
                tags TEXT[] NOT NULL DEFAULT '{{}}',
                embedding vector({dimension}),
                embedding_model TEXT,
                embedding_source_hash TEXT,
                cover_data JSONB NOT NULL DEFAULT '{{}}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                deleted_at TIMESTAMPTZ
            )
            """
        )
        connection.execute(
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ"
        )
        connection.execute(
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS cover_data JSONB NOT NULL DEFAULT '{}'::jsonb"
        )
        connection.execute(
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS embedding_source_hash TEXT"
        )
        connection.execute(
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT ''"
        )
        connection.execute(
            "UPDATE cards SET category = topic WHERE btrim(category) = ''"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS categories (
                name TEXT PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS categories_name_ci_idx ON categories (lower(btrim(name)))"
        )
        connection.execute(
            """
            INSERT INTO categories (name)
            SELECT DISTINCT btrim(category)
            FROM cards
            WHERE btrim(category) <> ''
            ON CONFLICT DO NOTHING
            """
        )
        if dimension_migrated:
            connection.execute(
                f"ALTER TABLE cards ALTER COLUMN embedding TYPE vector({dimension}) USING NULL"
            )
            connection.execute(
                "UPDATE cards SET embedding_model = NULL, embedding_source_hash = NULL, cover_data = '{}'::jsonb"
            )
        connection.execute("ALTER TABLE cards DROP COLUMN IF EXISTS status")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS runtime_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS card_relations (
                source_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                target_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                relation_type TEXT NOT NULL,
                score REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'suggested',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (source_id, target_id, relation_type),
                CHECK (source_id <> target_id)
            )
            """
        )
        # Relation lookups are bidirectional, but the primary key only indexes
        # source_id as its leading column, so `OR target_id = ...` had no index
        # to use. Postgres can BitmapOr the two once this exists.
        connection.execute(
            "CREATE INDEX IF NOT EXISTS card_relations_target_idx ON card_relations (target_id)"
        )
        # The trash view is a selective slice of a table that is otherwise
        # always filtered to deleted_at IS NULL, so keep it partial.
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS cards_deleted_at_idx
            ON cards (deleted_at DESC)
            WHERE deleted_at IS NOT NULL
            """
        )
        if current_schema_version < 2:
            connection.execute(
                """
                INSERT INTO schema_migrations (version, name)
                VALUES (2, 'categories-and-card-metadata')
                ON CONFLICT DO NOTHING
                """
            )
        if current_schema_version < SCHEMA_VERSION:
            connection.execute(
                """
                INSERT INTO schema_migrations (version, name)
                VALUES (3, 'relation-and-trash-indexes')
                ON CONFLICT DO NOTHING
                """
            )
    return dimension_migrated


def get_runtime_settings() -> dict[str, str]:
    with get_connection() as connection:
        rows = connection.execute("SELECT key, value FROM runtime_settings").fetchall()
    return {str(row["key"]): str(row["value"]) for row in rows}


def preview_import(payload: dict[str, Any]) -> dict[str, Any]:
    strategy = str(payload.get("conflict_strategy", "replace"))
    incoming_cards = [card for card in payload.get("cards", []) if isinstance(card, dict)]
    incoming_ids = {str(card.get("id", "")).strip() for card in incoming_cards if str(card.get("id", "")).strip()}
    with get_connection() as connection:
        current_rows = connection.execute(
            """
            SELECT id, number, topic, category, title, question, summary, analogy, detail, source, tags, deleted_at
            FROM cards
            """
        ).fetchall()
        current_categories = {str(row["name"]) for row in connection.execute("SELECT name FROM categories").fetchall()}
        relation_count_row = connection.execute("SELECT COUNT(*) AS relation_count FROM card_relations").fetchone()
        current_relation_count = int(relation_count_row["relation_count"] if relation_count_row else 0)
    current = {str(row["id"]): dict(row) for row in current_rows}
    added = [card for card in incoming_cards if str(card.get("id", "")).strip() not in current]
    conflicts = [card for card in incoming_cards if str(card.get("id", "")).strip() in current]
    changed: list[dict[str, Any]] = []
    fields = ("number", "topic", "category", "title", "question", "summary", "analogy", "detail", "source", "tags")
    for card in conflicts:
        card_id = str(card.get("id", "")).strip()
        existing = current[card_id]
        differences = []
        for field in fields:
            incoming = list(card.get(field, [])) if field == "tags" else str(card.get(field, ""))
            existing_value = list(existing.get(field) or []) if field == "tags" else str(existing.get(field) or "")
            if incoming != existing_value:
                differences.append(field)
        if differences:
            changed.append({"id": card_id, "title": str(card.get("title", existing.get("title", ""))), "fields": differences})
    incoming_categories = {
        normalize_category_name(str(category.get("name", "")))
        for category in payload.get("categories", [])
        if isinstance(category, dict) and normalize_category_name(str(category.get("name", "")))
    }
    incoming_categories.update(
        normalize_category_name(str(card.get("category") or card.get("topic") or "待分類"))
        for card in incoming_cards
    )
    if strategy == "replace":
        removed_count = len(set(current) - incoming_ids)
        added_count = len(added)
        updated_count = len(conflicts)
        category_removed_count = len(current_categories - incoming_categories)
    elif strategy == "skip":
        removed_count = 0
        added_count = len(added)
        updated_count = 0
        category_removed_count = 0
    else:
        removed_count = 0
        added_count = len(added)
        updated_count = len(conflicts)
        category_removed_count = 0
    return {
        "valid": True,
        "format_version": int(payload.get("format_version", 0)),
        "conflict_strategy": strategy,
        "summary": {
            "cards": len(incoming_cards),
            "relations": len(payload.get("relations", [])),
            "duplicate_ids": len(incoming_cards) - len(incoming_ids),
            "invalid_cards": 0,
            "invalid_relations": 0,
            "added_cards": added_count,
            "updated_cards": updated_count,
            "skipped_cards": len(conflicts) if strategy == "skip" else 0,
            "removed_cards": removed_count,
            "changed_cards": len(changed),
            "added_categories": len(incoming_categories - current_categories),
            "removed_categories": category_removed_count,
            "current_relations": current_relation_count,
        },
        "changes": {
            "added_cards": [{"id": str(card.get("id")), "title": str(card.get("title", ""))} for card in added[:100]],
            "updated_cards": changed[:100] if strategy != "skip" else [],
            "skipped_cards": [{"id": str(card.get("id")), "title": str(card.get("title", ""))} for card in conflicts[:100]] if strategy == "skip" else [],
            "removed_card_ids": sorted(set(current) - incoming_ids)[:100] if strategy == "replace" else [],
            "added_categories": sorted(incoming_categories - current_categories),
            "removed_categories": sorted(current_categories - incoming_categories) if strategy == "replace" else [],
        },
    }


def normalize_category_name(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def list_categories() -> list[dict[str, Any]]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT categories.name,
                   COUNT(cards.id) FILTER (WHERE cards.deleted_at IS NULL) AS card_count,
                   categories.created_at,
                   categories.updated_at
            FROM categories
            LEFT JOIN cards ON cards.category = categories.name
            GROUP BY categories.name, categories.created_at, categories.updated_at
            ORDER BY lower(categories.name), categories.name
            """
        ).fetchall()
        uncategorized = connection.execute(
            """
            SELECT COUNT(*) AS card_count
            FROM cards
            WHERE deleted_at IS NULL
              AND (btrim(category) = '' OR lower(btrim(category)) = '待分類')
            """
        ).fetchone()
    result = [
        {
            "name": row["name"],
            "card_count": int(row["card_count"] or 0),
            "created_at": row["created_at"].isoformat(),
            "updated_at": row["updated_at"].isoformat(),
        }
        for row in rows
        if str(row["name"]).strip().lower() != "待分類"
    ]
    unfiled_count = int((uncategorized or {}).get("card_count", 0))
    if unfiled_count or not result:
        result.insert(0, {"name": "待分類", "card_count": unfiled_count, "created_at": None, "updated_at": None})
    return result


def create_category(name: str) -> dict[str, Any]:
    normalized = normalize_category_name(name)
    if not normalized:
        raise ValueError("分類名稱不可為空白")
    with get_connection() as connection:
        try:
            row = connection.execute(
                "INSERT INTO categories (name) VALUES (%s) RETURNING name, created_at, updated_at",
                (normalized,),
            ).fetchone()
        except psycopg.errors.UniqueViolation as exc:
            raise ValueError("已存在相同名稱的分類") from exc
    return {"name": row["name"], "card_count": 0, "created_at": row["created_at"].isoformat(), "updated_at": row["updated_at"].isoformat()}


def rename_category(source: str, target: str) -> dict[str, Any] | None:
    source_name = normalize_category_name(source)
    target_name = normalize_category_name(target)
    if not source_name or not target_name:
        raise ValueError("分類名稱不可為空白")
    if source_name.lower() == "待分類":
        raise ValueError("待分類是系統保留分類，不能重新命名")
    with get_connection() as connection:
        source_row = connection.execute(
            "SELECT name FROM categories WHERE lower(btrim(name)) = lower(%s)", (source_name,)
        ).fetchone()
        if not source_row:
            return None
        target_row = connection.execute(
            "SELECT name FROM categories WHERE lower(btrim(name)) = lower(%s) AND name <> %s",
            (target_name, source_row["name"]),
        ).fetchone()
        if target_row:
            raise ValueError("目標分類已存在，若要合併請使用合併功能")
        connection.execute("UPDATE categories SET name = %s, updated_at = now() WHERE name = %s", (target_name, source_row["name"]))
        affected = connection.execute(
            """
            UPDATE cards
            SET category = %s, embedding = NULL, embedding_model = NULL,
                embedding_source_hash = NULL, cover_data = '{}'::jsonb, updated_at = now()
            WHERE category = %s AND deleted_at IS NULL
            RETURNING id
            """,
            (target_name, source_row["name"]),
        ).fetchall()
        affected_ids = [row["id"] for row in affected]
        if affected_ids:
            connection.execute(
                "DELETE FROM card_relations WHERE relation_type = 'semantic' AND (source_id = ANY(%s) OR target_id = ANY(%s))",
                (affected_ids, affected_ids),
            )
    return {"source": source_row["name"], "name": target_name, "affected_cards": len(affected)}


def merge_categories(source: str, target: str) -> dict[str, Any] | None:
    source_name = normalize_category_name(source)
    target_name = normalize_category_name(target)
    if not source_name or not target_name or source_name.lower() == target_name.lower():
        raise ValueError("合併需要兩個不同的分類名稱")
    if source_name.lower() == "待分類":
        raise ValueError("待分類是系統保留分類，不能作為被合併分類")
    with get_connection() as connection:
        source_row = connection.execute("SELECT name FROM categories WHERE lower(btrim(name)) = lower(%s)", (source_name,)).fetchone()
        if not source_row:
            return None
        target_row = connection.execute("SELECT name FROM categories WHERE lower(btrim(name)) = lower(%s)", (target_name,)).fetchone()
        if not target_row:
            target_row = connection.execute("INSERT INTO categories (name) VALUES (%s) RETURNING name", (target_name,)).fetchone()
        affected = connection.execute(
            """
            UPDATE cards
            SET category = %s, embedding = NULL, embedding_model = NULL,
                embedding_source_hash = NULL, cover_data = '{}'::jsonb, updated_at = now()
            WHERE category = %s AND deleted_at IS NULL
            RETURNING id
            """,
            (target_row["name"], source_row["name"]),
        ).fetchall()
        affected_ids = [row["id"] for row in affected]
        if affected_ids:
            connection.execute(
                "DELETE FROM card_relations WHERE relation_type = 'semantic' AND (source_id = ANY(%s) OR target_id = ANY(%s))",
                (affected_ids, affected_ids),
            )
        connection.execute("DELETE FROM categories WHERE name = %s", (source_row["name"],))
    return {"source": source_row["name"], "name": target_row["name"], "affected_cards": len(affected)}


def export_database() -> dict[str, Any]:
    """Return a portable local backup without exposing saved API keys."""
    with get_connection() as connection:
        card_rows = connection.execute(
            "SELECT * FROM cards ORDER BY number, id"
        ).fetchall()
        relation_rows = connection.execute(
            """
            SELECT source_id, target_id, relation_type, score, status,
                   created_at, updated_at
            FROM card_relations
            ORDER BY source_id, target_id, relation_type
            """
        ).fetchall()
        setting_rows = connection.execute(
            "SELECT key, value FROM runtime_settings ORDER BY key"
        ).fetchall()
        category_rows = connection.execute("SELECT name, created_at, updated_at FROM categories ORDER BY lower(name)").fetchall()

    cards: list[dict[str, Any]] = []
    for row in card_rows:
        cards.append(
            {
                "id": row["id"],
                "number": row["number"],
                "topic": row["topic"],
                "category": row.get("category") or row["topic"],
                "title": row["title"],
                "question": row["question"],
                "summary": row["summary"],
                "analogy": row["analogy"],
                "detail": row["detail"],
                "source": row["source"],
                "tags": list(row["tags"] or []),
                "embedding": (
                    [float(value) for value in row["embedding"].to_list()]
                    if row["embedding"] is not None
                    else None
                ),
                "embedding_model": row["embedding_model"],
                "embedding_source_hash": row["embedding_source_hash"],
                "cover_data": row["cover_data"] or {},
                "created_at": row["created_at"].isoformat(),
                "updated_at": row["updated_at"].isoformat(),
                "deleted_at": row["deleted_at"].isoformat() if row["deleted_at"] else None,
            }
        )

    relations = [
        {
            "source_id": row["source_id"],
            "target_id": row["target_id"],
            "relation_type": row["relation_type"],
            "score": float(row["score"]),
            "status": row["status"],
            "created_at": row["created_at"].isoformat(),
            "updated_at": row["updated_at"].isoformat(),
        }
        for row in relation_rows
    ]
    categories = [
        {"name": row["name"], "created_at": row["created_at"].isoformat(), "updated_at": row["updated_at"].isoformat()}
        for row in category_rows
    ]

    # API keys are deliberately omitted from backups. The corresponding model
    # settings can still be restored manually without exporting credentials.
    runtime_settings = {
        str(row["key"]): str(row["value"])
        for row in setting_rows
        if not str(row["key"]).endswith(".api_key")
    }

    payload: dict[str, Any] = {
        "format_version": BACKUP_FORMAT_VERSION,
        "cards": cards,
        "categories": categories,
        "relations": relations,
        "runtime_settings": runtime_settings,
        "metadata": {
            "card_count": len(cards),
            "relation_count": len(relations),
            "schema_version": SCHEMA_VERSION,
            "includes_embeddings": True,
            "api_keys_included": False,
        },
    }
    payload["checksum_sha256"] = _checksum_payload(payload)
    return payload


def create_backup_file(backup_dir: str, reason: str = "auto") -> str | None:
    """Write a timestamped, credential-free backup and retain the latest 10 files."""
    if not backup_dir:
        return None
    target_dir = Path(backup_dir)
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        payload = export_database()
        payload["backup_reason"] = reason
        payload["backed_up_at"] = datetime.now(timezone.utc).isoformat()
        filename = f"cards-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{reason}.json"
        target = target_dir / filename
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(target)
        backups = sorted(target_dir.glob("cards-*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
        for old_backup in backups[10:]:
            old_backup.unlink(missing_ok=True)
        return str(target)
    except OSError:
        return None


def ensure_auto_backup(backup_dir: str, max_age_hours: int = 24) -> str | None:
    if not backup_dir:
        return None
    target_dir = Path(backup_dir)
    try:
        newest = max(target_dir.glob("cards-*.json"), key=lambda item: item.stat().st_mtime, default=None)
        if newest and (datetime.now(timezone.utc).timestamp() - newest.stat().st_mtime) < max_age_hours * 3600:
            return str(newest)
    except OSError:
        pass
    return create_backup_file(backup_dir, "startup")


def reset_database() -> dict[str, int]:
    """Clear user data while preserving the schema and runtime settings."""
    with get_connection() as connection:
        card_count = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0])
        relation_count = int(
            connection.execute("SELECT COUNT(*) FROM card_relations").fetchone()[0]
        )
        connection.execute("TRUNCATE TABLE card_relations, cards, categories")
    return {"cards": card_count, "relations": relation_count}


def _import_timestamp(value: Any, field: str, *, required: bool = True) -> datetime | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise ValueError(f"匯入資料的 {field} 必須是 ISO 時間字串")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"匯入資料的 {field} 不是有效的 ISO 時間") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def import_database(payload: dict[str, Any]) -> dict[str, int]:
    """Replace local card data from a validated export payload atomically."""
    format_version = int(payload.get("format_version", 0))
    conflict_strategy = str(payload.get("conflict_strategy", "replace"))
    if conflict_strategy not in {"replace", "skip", "update"}:
        raise ValueError("不支援的匯入衝突策略")
    if format_version not in {1, BACKUP_FORMAT_VERSION}:
        raise ValueError(f"不支援的備份格式版本：{format_version}")
    checksum = payload.get("checksum_sha256")
    if checksum:
        expected = _checksum_payload(payload)
        if not isinstance(checksum, str) or not compare_digest(checksum, expected):
            raise ValueError("備份檔案校驗碼不符，可能已損壞或被修改")
    raw_cards = payload.get("cards")
    raw_relations = payload.get("relations", [])
    raw_categories = payload.get("categories", [])
    raw_settings = payload.get("runtime_settings", {})
    if not isinstance(raw_cards, list) or not isinstance(raw_relations, list):
        raise ValueError("匯入檔案缺少有效的 cards 或 relations 陣列")
    if not isinstance(raw_settings, dict):
        raise ValueError("匯入檔案的 runtime_settings 必須是物件")

    card_ids: set[str] = set()
    cards: list[dict[str, Any]] = []
    for raw_card in raw_cards:
        if not isinstance(raw_card, dict):
            raise ValueError("匯入檔案包含格式錯誤的卡片")
        card_id = str(raw_card.get("id", "")).strip()
        if not card_id:
            raise ValueError("每張匯入卡片都必須有 id")
        if card_id in card_ids:
            raise ValueError(f"匯入檔案有重複的卡片 id：{card_id}")
        card_ids.add(card_id)

        required_fields = ("number", "topic", "title")
        for field in required_fields:
            if not str(raw_card.get(field, "")).strip():
                raise ValueError(f"卡片 {card_id} 缺少必要欄位：{field}")

        raw_embedding = raw_card.get("embedding")
        embedding: str | None = None
        if raw_embedding is not None:
            if not isinstance(raw_embedding, list) or len(raw_embedding) != settings.embedding_dimensions:
                raise ValueError(
                    f"卡片 {card_id} 的 embedding 維度不符合目前設定（需要 {settings.embedding_dimensions} 維）"
                )
            try:
                embedding_values = [float(value) for value in raw_embedding]
                if not all(math.isfinite(value) for value in embedding_values):
                    raise ValueError("embedding 含有非有限數值")
                embedding = vector_literal(embedding_values)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"卡片 {card_id} 的 embedding 不是有效數值") from exc

        tags = raw_card.get("tags", [])
        if not isinstance(tags, list):
            raise ValueError(f"卡片 {card_id} 的 tags 必須是陣列")
        cards.append(
            {
                "id": card_id,
                "number": str(raw_card["number"]),
                "topic": str(raw_card["topic"]),
                "category": str(raw_card.get("category") or raw_card["topic"]),
                "title": str(raw_card["title"]),
                "question": str(raw_card.get("question", "")),
                "summary": str(raw_card.get("summary", "")),
                "analogy": str(raw_card.get("analogy", "")),
                "detail": str(raw_card.get("detail", "")),
                "source": str(raw_card.get("source", "")),
                "tags": [str(tag) for tag in tags],
                "embedding": embedding,
                "embedding_model": raw_card.get("embedding_model"),
                "embedding_source_hash": raw_card.get("embedding_source_hash"),
                "cover_data": raw_card.get("cover_data") if isinstance(raw_card.get("cover_data"), dict) else {},
                "created_at": _import_timestamp(raw_card.get("created_at"), "created_at"),
                "updated_at": _import_timestamp(raw_card.get("updated_at"), "updated_at"),
                "deleted_at": _import_timestamp(raw_card.get("deleted_at"), "deleted_at", required=False),
            }
        )

    relations: list[dict[str, Any]] = []
    relation_keys: set[tuple[str, str, str]] = set()
    for raw_relation in raw_relations:
        if not isinstance(raw_relation, dict):
            raise ValueError("匯入檔案包含格式錯誤的關聯")
        source_id = str(raw_relation.get("source_id", "")).strip()
        target_id = str(raw_relation.get("target_id", "")).strip()
        relation_type = str(raw_relation.get("relation_type", "")).strip()
        if not source_id or not target_id or source_id == target_id:
            raise ValueError("匯入關聯的來源與目標卡片必須有效且不同")
        if source_id not in card_ids or target_id not in card_ids:
            raise ValueError("匯入關聯引用了不存在的卡片")
        relation_key = (source_id, target_id, relation_type)
        if relation_key in relation_keys:
            raise ValueError("匯入檔案包含重複的卡片關聯")
        relation_keys.add(relation_key)
        try:
            score = float(raw_relation.get("score", 0))
        except (TypeError, ValueError) as exc:
            raise ValueError("匯入關聯的 score 不是有效數值") from exc
        if not math.isfinite(score) or not -1 <= score <= 1:
            raise ValueError("匯入關聯的 score 必須介於 -1 與 1 之間")
        if relation_type and relation_type not in {"semantic", "manual"}:
            raise ValueError("匯入關聯的 relation_type 不受支援")
        relations.append(
            {
                "source_id": source_id,
                "target_id": target_id,
                "relation_type": relation_type or "semantic",
                "score": score,
                "status": str(raw_relation.get("status", "suggested")),
                "created_at": _import_timestamp(raw_relation.get("created_at"), "relation.created_at"),
                "updated_at": _import_timestamp(raw_relation.get("updated_at"), "relation.updated_at"),
            }
        )

    with get_connection() as connection:
        if conflict_strategy == "replace":
            connection.execute("TRUNCATE TABLE card_relations, cards, categories")
        elif conflict_strategy == "skip":
            existing_ids = {
                row["id"]
                for row in connection.execute("SELECT id FROM cards WHERE id = ANY(%s)", (list(card_ids),)).fetchall()
            }
            cards = [card for card in cards if card["id"] not in existing_ids]
        elif conflict_strategy == "update":
            connection.execute("DELETE FROM cards WHERE id = ANY(%s)", (list(card_ids),))
        for card in cards:
            connection.execute(
                """
                INSERT INTO cards (
                    id, number, topic, category, title, question, summary, analogy, detail,
                    source, tags, embedding, embedding_model, cover_data,
                    embedding_source_hash,
                    created_at, updated_at, deleted_at
                )
                VALUES (
                    %(id)s, %(number)s, %(topic)s, %(category)s, %(title)s, %(question)s, %(summary)s,
                    %(analogy)s, %(detail)s, %(source)s, %(tags)s,
                    %(embedding)s::vector, %(embedding_model)s, %(cover_data)s::jsonb,
                    %(embedding_source_hash)s,
                    %(created_at)s, %(updated_at)s, %(deleted_at)s
                )
                """,
                {
                    **card,
                    "cover_data": json.dumps(card["cover_data"]),
                },
            )
        for category in raw_categories:
            if isinstance(category, dict):
                category_name = normalize_category_name(str(category.get("name", "")))
                if category_name:
                    connection.execute("INSERT INTO categories (name) VALUES (%s) ON CONFLICT DO NOTHING", (category_name,))
        for relation in relations:
            connection.execute(
                """
                INSERT INTO card_relations (
                    source_id, target_id, relation_type, score, status, created_at, updated_at
                )
                VALUES (
                    %(source_id)s, %(target_id)s, %(relation_type)s, %(score)s,
                    %(status)s, %(created_at)s, %(updated_at)s
                )
                """,
                relation,
            )
        connection.execute(
            """
            INSERT INTO categories (name)
            SELECT DISTINCT btrim(category) FROM cards
            WHERE btrim(category) <> ''
            ON CONFLICT DO NOTHING
            """
        )

    save_runtime_settings({
        str(key): str(value)
        for key, value in raw_settings.items()
        if not str(key).endswith(".api_key")
    })

    return {
        "cards": len(cards),
        "deleted_cards": sum(1 for card in cards if card["deleted_at"] is not None),
        "relations": len(relations),
    }


def save_runtime_settings(values: dict[str, str]) -> None:
    if not values:
        return
    with get_connection() as connection:
        for key, value in values.items():
            connection.execute(
                """
                INSERT INTO runtime_settings (key, value, updated_at)
                VALUES (%s, %s, now())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
                """,
                (key, value),
            )


def update_card_embedding(
    card_id: str,
    embedding: list[float],
    embedding_model: str,
    cover_data: dict[str, Any],
    embedding_source_hash: str,
) -> None:
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE cards
            SET embedding = %s::vector,
                embedding_model = %s,
                cover_data = %s::jsonb,
                embedding_source_hash = %s,
                updated_at = now()
            WHERE id = %s AND deleted_at IS NULL
            """,
            (vector_literal(embedding), embedding_model, json.dumps(cover_data), embedding_source_hash, card_id),
        )


def clear_semantic_relations() -> None:
    with get_connection() as connection:
        connection.execute("DELETE FROM card_relations WHERE relation_type = 'semantic'")


def clear_semantic_relations_for(card_ids: list[str]) -> None:
    if not card_ids:
        return
    with get_connection() as connection:
        connection.execute(
            "DELETE FROM card_relations WHERE relation_type = 'semantic' AND (source_id = ANY(%s) OR target_id = ANY(%s))",
            (card_ids, card_ids),
        )


def upsert_card(
    card: dict[str, Any],
    embedding: list[float],
    embedding_model: str,
    cover_data: dict[str, Any] | None = None,
    embedding_source_hash: str | None = None,
) -> dict[str, Any]:
    cover_data = cover_data or build_cover(embedding)
    with get_connection() as connection:
        row = connection.execute(
            """
            INSERT INTO cards (
                id, number, topic, category, title, question, summary, analogy, detail,
                source, tags, embedding, embedding_model, cover_data, updated_at
                , embedding_source_hash
            )
            VALUES (
                %(id)s, %(number)s, %(topic)s, %(category)s, %(title)s, %(question)s, %(summary)s,
                %(analogy)s, %(detail)s, %(source)s, %(tags)s,
                %(embedding)s::vector, %(embedding_model)s, %(cover_data)s::jsonb, now(), %(embedding_source_hash)s
            )
            ON CONFLICT (id) DO UPDATE SET
                number = EXCLUDED.number,
                topic = EXCLUDED.topic,
                category = EXCLUDED.category,
                title = EXCLUDED.title,
                question = EXCLUDED.question,
                summary = EXCLUDED.summary,
                analogy = EXCLUDED.analogy,
                detail = EXCLUDED.detail,
                source = EXCLUDED.source,
                tags = EXCLUDED.tags,
                embedding = EXCLUDED.embedding,
                embedding_model = EXCLUDED.embedding_model,
                embedding_source_hash = EXCLUDED.embedding_source_hash,
                cover_data = EXCLUDED.cover_data,
                deleted_at = NULL,
                updated_at = now()
            RETURNING *
            """,
            {
                **card,
                "embedding": vector_literal(embedding),
                "embedding_model": embedding_model,
                "embedding_source_hash": embedding_source_hash,
                "cover_data": json.dumps(cover_data),
            },
        ).fetchone()
        connection.execute(
            "DELETE FROM card_relations WHERE relation_type = 'semantic' AND (source_id = %s OR target_id = %s)",
            (card["id"], card["id"]),
        )
        return dict(row)


def backfill_covers() -> None:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, embedding
            FROM cards
            WHERE embedding IS NOT NULL
              AND (
                    cover_data IS NULL
                    OR cover_data = '{}'::jsonb
                    OR COALESCE((cover_data->>'version')::int, 0) < %s
              )
            """,
            (COVER_VERSION,),
        ).fetchall()
        for row in rows:
            connection.execute(
                "UPDATE cards SET cover_data = %s::jsonb WHERE id = %s",
                (json.dumps(build_cover(row["embedding"])), row["id"]),
            )


def find_similar_cards(card_id: str, embedding: list[float], limit: int | None = None) -> list[dict[str, Any]]:
    vector = vector_literal(embedding)
    limit = limit or settings.relation_limit
    semantic_weight = 1 - settings.relation_keyword_weight
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT target.id, target.category,
                   1 - (target.embedding <=> %s::vector) AS semantic_score,
                   CASE
                       WHEN lower(target.category) = lower(source.category)
                            AND lower(target.category) NOT IN ('', '待分類') THEN 1.0
                       WHEN lower(target.topic) = lower(source.topic) THEN 0.85
                       WHEN target.tags && source.tags THEN 0.75
                       ELSE 0.0
                   END AS lexical_score,
                   (%s * (1 - (target.embedding <=> %s::vector)) +
                    %s * CASE
                       WHEN lower(target.category) = lower(source.category)
                            AND lower(target.category) NOT IN ('', '待分類') THEN 1.0
                       WHEN lower(target.topic) = lower(source.topic) THEN 0.85
                       WHEN target.tags && source.tags THEN 0.75
                       ELSE 0.0
                    END) AS score
            FROM cards AS source
            JOIN cards AS target ON target.id <> source.id
            WHERE source.id = %s
              AND target.embedding IS NOT NULL
              AND target.deleted_at IS NULL
            ORDER BY score DESC
            LIMIT %s
            """,
            (vector, semantic_weight, vector, settings.relation_keyword_weight, card_id, max(limit * 4, limit)),
        ).fetchall()
    candidates = [dict(row) for row in rows if float(row["score"]) >= settings.related_min_score]
    # Same-category boosting is useful, but allowing every slot to be filled
    # by one category makes the graph look like isolated clusters. Keep at
    # most half of a node's semantic slots in one named category, then fill
    # remaining slots with the next-best candidates.
    category_limit = max(1, limit // 2)
    category_counts: dict[str, int] = {}
    selected: list[dict[str, Any]] = []
    for candidate in candidates:
        category = str(candidate.get("category") or "").strip().casefold()
        limited_category = category not in {"", "待分類"}
        if limited_category and category_counts.get(category, 0) >= category_limit:
            continue
        selected.append(candidate)
        if limited_category:
            category_counts[category] = category_counts.get(category, 0) + 1
        if len(selected) >= limit:
            break
    return selected[:limit]


def save_suggested_relations(card_id: str, similar_cards: list[dict[str, Any]]) -> None:
    with get_connection() as connection:
        for similar in similar_cards:
            source_id, target_id = sorted([card_id, similar["id"]])
            connection.execute(
                """
                INSERT INTO card_relations (source_id, target_id, relation_type, score, status, updated_at)
                VALUES (%s, %s, 'semantic', %s, 'suggested', now())
                ON CONFLICT (source_id, target_id, relation_type) DO UPDATE SET
                    score = EXCLUDED.score,
                    updated_at = now()
                """,
                (source_id, target_id, float(similar["score"])),
            )
        connection.execute(
            """
            WITH ranked AS (
                SELECT source_id, target_id,
                       row_number() OVER (PARTITION BY source_id ORDER BY score DESC) AS source_rank,
                       row_number() OVER (PARTITION BY target_id ORDER BY score DESC) AS target_rank
                FROM card_relations
                WHERE relation_type = 'semantic'
            )
            DELETE FROM card_relations relation
            USING ranked
            WHERE relation.source_id = ranked.source_id
              AND relation.target_id = ranked.target_id
              AND relation.relation_type = 'semantic'
              AND ranked.source_rank > %s
              AND ranked.target_rank > %s
            """,
            (settings.relation_limit, settings.relation_limit),
        )


def search_cards(
    embedding: list[float],
    query_text: str,
    limit: int,
    category: str | None = None,
    tag: str | None = None,
    sort: str = "relevance",
) -> list[dict[str, Any]]:
    vector = vector_literal(embedding)
    keyword = f"%{query_text.strip()}%"
    semantic_weight = 1 - settings.keyword_weight
    order_by = "score DESC, updated_at DESC" if sort == "relevance" else "updated_at DESC, score DESC" if sort == "updated" else "title ASC, score DESC"
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT id, number, topic, category, title, question, summary, analogy, detail,
                   source, tags, embedding_model, cover_data, created_at, updated_at,
                   1 - (embedding <=> %s::vector) AS semantic_score,
                   CASE WHEN lower(concat_ws(' ', title, topic, category, question, summary, analogy,
                                             detail, source, array_to_string(tags, ' ')))
                             LIKE lower(%s)
                        THEN 1.0 ELSE 0.0 END AS keyword_score,
                   array_remove(ARRAY[
                       CASE WHEN lower(concat_ws(' ', title, topic, category, question, summary, analogy,
                                                 detail, source, array_to_string(tags, ' '))) LIKE lower(%s)
                            THEN '關鍵字命中' END,
                       CASE WHEN 1 - (embedding <=> %s::vector) >= 0.65 THEN '語意相似' END,
                       CASE WHEN lower(category) = lower(%s) AND btrim(%s) <> '' THEN '同分類' END,
                       CASE WHEN %s <> '' AND EXISTS (
                           SELECT 1 FROM unnest(tags) AS card_tag
                           WHERE lower(card_tag) = lower(%s)
                       ) THEN '共享標籤' END
                   ], NULL) AS search_reasons,
                   (%s * (1 - (embedding <=> %s::vector)) +
                    %s * CASE WHEN lower(concat_ws(' ', title, topic, category, question, summary, analogy,
                                                   detail, source, array_to_string(tags, ' ')))
                                   LIKE lower(%s)
                              THEN 1.0 ELSE 0.0 END) AS score
            FROM cards
            WHERE embedding IS NOT NULL
              AND deleted_at IS NULL
              AND (%s::text IS NULL OR lower(category) = lower(%s::text))
              AND (%s::text IS NULL OR EXISTS (
                  SELECT 1 FROM unnest(tags) AS filter_tag
                  WHERE lower(filter_tag) = lower(%s::text)
              ))
            ORDER BY {order_by}
            LIMIT %s
            """,
            (
                vector, keyword,
                keyword, vector, category or "", category or "", tag or "", tag or "",
                semantic_weight, vector, settings.keyword_weight, keyword,
                category, category, tag, tag, limit,
            ),
        ).fetchall()
    return [dict(row) for row in rows]


def list_cards() -> list[dict[str, Any]]:
    with get_connection() as connection:
        return [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM cards WHERE deleted_at IS NULL ORDER BY number"
            ).fetchall()
        ]


def list_trash() -> list[dict[str, Any]]:
    with get_connection() as connection:
        return [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM cards WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
            ).fetchall()
        ]


def get_card(card_id: str, *, include_deleted: bool = False) -> dict[str, Any] | None:
    with get_connection() as connection:
        query = "SELECT * FROM cards WHERE id = %s"
        if not include_deleted:
            query += " AND deleted_at IS NULL"
        row = connection.execute(query, (card_id,)).fetchone()
    return dict(row) if row else None


def soft_delete_card(card_id: str) -> dict[str, Any] | None:
    with get_connection() as connection:
        row = connection.execute(
            """
            UPDATE cards
            SET deleted_at = now(), updated_at = now()
            WHERE id = %s AND deleted_at IS NULL
            RETURNING *
            """,
            (card_id,),
        ).fetchone()
        if row:
            connection.execute(
                """
                DELETE FROM card_relations
                WHERE relation_type = 'semantic'
                  AND (source_id = %s OR target_id = %s)
                """,
                (card_id, card_id),
            )
    return dict(row) if row else None


def restore_card(card_id: str) -> dict[str, Any] | None:
    with get_connection() as connection:
        row = connection.execute(
            """
            UPDATE cards
            SET deleted_at = NULL, updated_at = now()
            WHERE id = %s AND deleted_at IS NOT NULL
            RETURNING *
            """,
            (card_id,),
        ).fetchone()
    return dict(row) if row else None


def permanently_delete_card(card_id: str) -> bool:
    with get_connection() as connection:
        row = connection.execute(
            """
            DELETE FROM cards
            WHERE id = %s AND deleted_at IS NOT NULL
            RETURNING id
            """,
            (card_id,),
        ).fetchone()
    return row is not None


def get_related_cards(card_id: str) -> list[dict[str, Any]]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT r.relation_type, r.score, r.status,
                   r.created_at AS relation_created_at,
                   r.updated_at AS relation_updated_at,
                   CASE
                       WHEN r.relation_type = 'manual' THEN '自製關聯'
                       WHEN lower(c.category) = lower(source.category)
                            AND lower(c.category) NOT IN ('', '待分類') THEN '同分類 + 語意相似'
                       WHEN c.tags && source.tags THEN '共享標籤 + 語意相似'
                       WHEN lower(c.topic) = lower(source.topic) THEN '同主題 + 語意相似'
                       ELSE '語意相似'
                   END AS relation_reason,
                   c.id, c.number, c.topic, c.category, c.title, c.question, c.summary,
                   c.analogy, c.detail, c.source, c.tags,
                   c.embedding_model, c.cover_data, c.created_at, c.updated_at
            FROM card_relations r
            JOIN cards source ON source.id = %s
            JOIN cards c ON c.id = CASE WHEN r.source_id = %s THEN r.target_id ELSE r.source_id END
            WHERE (r.source_id = %s OR r.target_id = %s)
              AND (r.relation_type = 'manual' OR r.score >= %s)
              AND c.deleted_at IS NULL
            ORDER BY r.score DESC
            LIMIT %s
            """,
            (card_id, card_id, card_id, card_id, settings.related_min_score, settings.relation_limit),
        ).fetchall()
    return [dict(row) for row in rows]


def confirm_relation(card_id: str, target_id: str) -> dict[str, Any]:
    source_id, target_id = sorted([card_id, target_id])
    with get_connection() as connection:
        row = connection.execute(
            """
            INSERT INTO card_relations (source_id, target_id, relation_type, score, status, updated_at)
            VALUES (%s, %s, 'manual', 1.0, 'confirmed', now())
            ON CONFLICT (source_id, target_id, relation_type) DO UPDATE SET
                status = 'confirmed',
                updated_at = now()
            RETURNING source_id, target_id, relation_type, score, status
            """,
            (source_id, target_id),
        ).fetchone()
    return dict(row)


def delete_manual_relation(card_id: str, target_id: str) -> bool:
    source_id, target_id = sorted([card_id, target_id])
    with get_connection() as connection:
        row = connection.execute(
            """
            DELETE FROM card_relations
            WHERE source_id = %s AND target_id = %s AND relation_type = 'manual'
            RETURNING source_id
            """,
            (source_id, target_id),
        ).fetchone()
    return bool(row)


def _embedding_cosine(first: Any, second: Any) -> float:
    if first is None or second is None:
        return 0.0
    first_values = first.to_list() if hasattr(first, "to_list") else list(first)
    second_values = second.to_list() if hasattr(second, "to_list") else list(second)
    length = min(len(first_values), len(second_values))
    numerator = sum(float(first_values[index]) * float(second_values[index]) for index in range(length))
    first_norm = math.sqrt(sum(float(value) ** 2 for value in first_values)) or 1.0
    second_norm = math.sqrt(sum(float(value) ** 2 for value in second_values)) or 1.0
    return numerator / (first_norm * second_norm)


def _normalized_tags(tags: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags or []:
        tag = re.sub(r"\s+", " ", str(raw_tag or "").strip())
        key = tag.casefold()
        if tag and key not in seen:
            result.append(tag)
            seen.add(key)
    return result


def _canonical_tag_map(rows: list[dict[str, Any]]) -> dict[str, str]:
    canonical: dict[str, str] = {}
    for row in rows:
        for tag in _normalized_tags(row.get("tags")):
            canonical.setdefault(tag.casefold(), tag)
    return canonical


def update_card_metadata(card_id: str, category: str, tags: list[str]) -> dict[str, Any] | None:
    with get_connection() as connection:
        row = connection.execute(
            """
            UPDATE cards
            SET category = %s, tags = %s, embedding = NULL, embedding_model = NULL,
                embedding_source_hash = NULL, cover_data = '{}'::jsonb, updated_at = now()
            WHERE id = %s AND deleted_at IS NULL
            RETURNING *
            """,
            (normalize_category_name(category) or "待分類", _normalized_tags(tags), card_id),
        ).fetchone()
        if row:
            connection.execute(
                "DELETE FROM card_relations WHERE relation_type = 'semantic' AND (source_id = %s OR target_id = %s)",
                (card_id, card_id),
            )
    return dict(row) if row else None


def batch_organize(card_ids: list[str] | None = None) -> dict[str, Any]:
    rows = list_cards()
    if card_ids:
        selected = set(card_ids)
        rows = [row for row in rows if row["id"] in selected]
    canonical_tags = _canonical_tag_map(rows)
    suggestions = []
    for row in rows:
        current_category = normalize_category_name(row.get("category") or "")
        suggested_category = current_category if current_category and current_category != "待分類" else normalize_category_name(row.get("topic") or "") or "待分類"
        normalized_tags = [canonical_tags.get(tag.casefold(), tag) for tag in _normalized_tags(row.get("tags"))]
        suggestions.append({
            "id": row["id"],
            "title": row["title"],
            "current_category": current_category or "待分類",
            "suggested_category": suggested_category,
            "current_tags": list(row.get("tags") or []),
            "suggested_tags": normalized_tags,
            "changed": suggested_category != (current_category or "待分類") or normalized_tags != list(row.get("tags") or []),
        })

    duplicates: list[dict[str, Any]] = []
    relation_suggestions: list[dict[str, Any]] = []
    for index, first in enumerate(rows):
        for second in rows[index + 1:]:
            title_same = re.sub(r"\W+", "", str(first["title"]).casefold()) == re.sub(r"\W+", "", str(second["title"]).casefold())
            score = _embedding_cosine(first.get("embedding"), second.get("embedding"))
            if title_same or score >= 0.9:
                duplicates.append({"source_id": first["id"], "target_id": second["id"], "score": round(max(score, 1.0 if title_same else score), 4), "reason": "標題相同" if title_same else "語意高度重複"})
            if score >= settings.related_min_score:
                shared_tags = set(_normalized_tags(first.get("tags"))) & set(_normalized_tags(second.get("tags")))
                same_category = first.get("category") and first.get("category") == second.get("category") and first.get("category") != "待分類"
                reason = "同分類 + 語意相似" if same_category else "共享標籤 + 語意相似" if shared_tags else "語意相似"
                relation_suggestions.append({"source_id": first["id"], "target_id": second["id"], "score": round(score, 4), "reason": reason})
    relation_suggestions.sort(key=lambda item: item["score"], reverse=True)
    return {"cards": suggestions, "duplicates": duplicates, "relations": relation_suggestions[: max(settings.relation_limit * 2, 12)]}
