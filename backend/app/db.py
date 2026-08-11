from typing import Any

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row

from .config import settings
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
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                deleted_at TIMESTAMPTZ
            )
            """
        )
        connection.execute(
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ"
        )
        connection.execute("ALTER TABLE cards DROP COLUMN IF EXISTS status")
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


def upsert_card(card: dict[str, Any], embedding: list[float], embedding_model: str) -> dict[str, Any]:
    with get_connection() as connection:
        row = connection.execute(
            """
            INSERT INTO cards (
                id, number, topic, title, question, summary, analogy, detail,
                source, tags, embedding, embedding_model, updated_at
            )
            VALUES (
                %(id)s, %(number)s, %(topic)s, %(title)s, %(question)s, %(summary)s,
                %(analogy)s, %(detail)s, %(source)s, %(tags)s,
                %(embedding)s::vector, %(embedding_model)s, now()
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
                deleted_at = NULL,
                updated_at = now()
            RETURNING *
            """,
            {**card, "embedding": vector_literal(embedding), "embedding_model": embedding_model},
        ).fetchone()
        connection.execute(
            "DELETE FROM card_relations WHERE relation_type = 'semantic' AND (source_id = %s OR target_id = %s)",
            (card["id"], card["id"]),
        )
        return dict(row)


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
                   source, tags, embedding_model, created_at, updated_at,
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
                   c.embedding_model, c.created_at, c.updated_at
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
