import json
from datetime import datetime, timezone
from typing import Any

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row

from .config import settings
from .covers import COVER_VERSION, build_cover
from .embeddings import vector_literal


def _connect() -> psycopg.Connection:
    return psycopg.connect(settings.database_url, row_factory=dict_row)


def get_connection() -> psycopg.Connection:
    connection = _connect()
    register_vector(connection)
    return connection


def ensure_schema() -> None:
    dimension = settings.embedding_dimensions
    with _connect() as connection:
        connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
        register_vector(connection)
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS cards (
                id TEXT PRIMARY KEY,
                number TEXT NOT NULL,
                topic TEXT NOT NULL,
                title TEXT NOT NULL,
                question TEXT NOT NULL,
                summary TEXT NOT NULL,
                analogy TEXT NOT NULL,
                detail TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT '',
                tags TEXT[] NOT NULL DEFAULT '{{}}',
                embedding vector({dimension}),
                embedding_model TEXT,
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


def get_runtime_settings() -> dict[str, str]:
    with get_connection() as connection:
        rows = connection.execute("SELECT key, value FROM runtime_settings").fetchall()
    return {str(row["key"]): str(row["value"]) for row in rows}


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

    cards: list[dict[str, Any]] = []
    for row in card_rows:
        cards.append(
            {
                "id": row["id"],
                "number": row["number"],
                "topic": row["topic"],
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

    # API keys are deliberately omitted from backups. The corresponding model
    # settings can still be restored manually without exporting credentials.
    runtime_settings = {
        str(row["key"]): str(row["value"])
        for row in setting_rows
        if not str(row["key"]).endswith(".api_key")
    }

    return {
        "format_version": 1,
        "cards": cards,
        "relations": relations,
        "runtime_settings": runtime_settings,
        "metadata": {
            "card_count": len(cards),
            "relation_count": len(relations),
            "includes_embeddings": True,
            "api_keys_included": False,
        },
    }


def reset_database() -> dict[str, int]:
    """Clear user data while preserving the schema and runtime settings."""
    with get_connection() as connection:
        card_count = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0])
        relation_count = int(
            connection.execute("SELECT COUNT(*) FROM card_relations").fetchone()[0]
        )
        connection.execute("TRUNCATE TABLE card_relations, cards")
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
    raw_cards = payload.get("cards")
    raw_relations = payload.get("relations", [])
    if not isinstance(raw_cards, list) or not isinstance(raw_relations, list):
        raise ValueError("匯入檔案缺少有效的 cards 或 relations 陣列")

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
                embedding = vector_literal([float(value) for value in raw_embedding])
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
                "title": str(raw_card["title"]),
                "question": str(raw_card.get("question", "")),
                "summary": str(raw_card.get("summary", "")),
                "analogy": str(raw_card.get("analogy", "")),
                "detail": str(raw_card.get("detail", "")),
                "source": str(raw_card.get("source", "")),
                "tags": [str(tag) for tag in tags],
                "embedding": embedding,
                "embedding_model": raw_card.get("embedding_model"),
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
        connection.execute("TRUNCATE TABLE card_relations, cards")
        for card in cards:
            connection.execute(
                """
                INSERT INTO cards (
                    id, number, topic, title, question, summary, analogy, detail,
                    source, tags, embedding, embedding_model, cover_data,
                    created_at, updated_at, deleted_at
                )
                VALUES (
                    %(id)s, %(number)s, %(topic)s, %(title)s, %(question)s, %(summary)s,
                    %(analogy)s, %(detail)s, %(source)s, %(tags)s,
                    %(embedding)s::vector, %(embedding_model)s, %(cover_data)s::jsonb,
                    %(created_at)s, %(updated_at)s, %(deleted_at)s
                )
                """,
                {
                    **card,
                    "cover_data": json.dumps(card["cover_data"]),
                },
            )
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
) -> None:
    with get_connection() as connection:
        connection.execute(
            """
            UPDATE cards
            SET embedding = %s::vector,
                embedding_model = %s,
                cover_data = %s::jsonb,
                updated_at = now()
            WHERE id = %s AND deleted_at IS NULL
            """,
            (vector_literal(embedding), embedding_model, json.dumps(cover_data), card_id),
        )


def clear_semantic_relations() -> None:
    with get_connection() as connection:
        connection.execute("DELETE FROM card_relations WHERE relation_type = 'semantic'")


def upsert_card(
    card: dict[str, Any],
    embedding: list[float],
    embedding_model: str,
    cover_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cover_data = cover_data or build_cover(embedding)
    with get_connection() as connection:
        row = connection.execute(
            """
            INSERT INTO cards (
                id, number, topic, title, question, summary, analogy, detail,
                source, tags, embedding, embedding_model, cover_data, updated_at
            )
            VALUES (
                %(id)s, %(number)s, %(topic)s, %(title)s, %(question)s, %(summary)s,
                %(analogy)s, %(detail)s, %(source)s, %(tags)s,
                %(embedding)s::vector, %(embedding_model)s, %(cover_data)s::jsonb, now()
            )
            ON CONFLICT (id) DO UPDATE SET
                number = EXCLUDED.number,
                topic = EXCLUDED.topic,
                title = EXCLUDED.title,
                question = EXCLUDED.question,
                summary = EXCLUDED.summary,
                analogy = EXCLUDED.analogy,
                detail = EXCLUDED.detail,
                source = EXCLUDED.source,
                tags = EXCLUDED.tags,
                embedding = EXCLUDED.embedding,
                embedding_model = EXCLUDED.embedding_model,
                cover_data = EXCLUDED.cover_data,
                deleted_at = NULL,
                updated_at = now()
            RETURNING *
            """,
            {
                **card,
                "embedding": vector_literal(embedding),
                "embedding_model": embedding_model,
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


def find_similar_cards(card_id: str, embedding: list[float], limit: int = 6) -> list[dict[str, Any]]:
    vector = vector_literal(embedding)
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, 1 - (embedding <=> %s::vector) AS score
            FROM cards
            WHERE id <> %s AND embedding IS NOT NULL
              AND deleted_at IS NULL
            ORDER BY embedding <=> %s::vector
            LIMIT %s
            """,
            (vector, card_id, vector, limit),
        ).fetchall()
    return [dict(row) for row in rows if float(row["score"]) >= settings.related_min_score]


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


def search_cards(embedding: list[float], limit: int) -> list[dict[str, Any]]:
    vector = vector_literal(embedding)
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, number, topic, title, question, summary, analogy, detail,
                   source, tags, embedding_model, cover_data, created_at, updated_at,
                   1 - (embedding <=> %s::vector) AS score
            FROM cards
            WHERE embedding IS NOT NULL
              AND deleted_at IS NULL
            ORDER BY embedding <=> %s::vector
            LIMIT %s
            """,
            (vector, vector, limit),
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
                   c.id, c.number, c.topic, c.title, c.question, c.summary,
                   c.analogy, c.detail, c.source, c.tags,
                   c.embedding_model, c.cover_data, c.created_at, c.updated_at
            FROM card_relations r
            JOIN cards c ON c.id = CASE WHEN r.source_id = %s THEN r.target_id ELSE r.source_id END
            WHERE (r.source_id = %s OR r.target_id = %s)
              AND c.deleted_at IS NULL
            ORDER BY r.score DESC
            """,
            (card_id, card_id, card_id),
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
