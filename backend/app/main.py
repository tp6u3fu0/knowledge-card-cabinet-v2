import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .embeddings import build_embedding_text, embed_text


class CardInput(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    number: str = Field(min_length=1, max_length=30)
    topic: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=240)
    question: str = ""
    summary: str = ""
    analogy: str = ""
    detail: str = ""
    source: str = ""
    tags: list[str] = Field(default_factory=list)
    status: str = "draft"


class SearchResult(BaseModel):
    id: str
    number: str
    topic: str
    title: str
    question: str
    summary: str
    source: str
    tags: list[str]
    status: str
    score: float


class RelationResult(BaseModel):
    relation_type: str
    score: float
    status: str
    card: SearchResult


def compact_card(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "number": row["number"],
        "topic": row["topic"],
        "title": row["title"],
        "question": row["question"],
        "summary": row["summary"],
        "source": row["source"],
        "tags": list(row.get("tags") or []),
        "status": row.get("status", row.get("card_status", "draft")),
        "score": float(row.get("score", 0.0)),
    }


async def initialize_database() -> None:
    for attempt in range(30):
        try:
            db.ensure_schema()
            return
        except psycopg.OperationalError:
            if attempt == 29:
                raise
            await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await initialize_database()
    yield


app = FastAPI(
    title="Knowledge Card API",
    version="0.1.0",
    description="Semantic search and relation suggestions for the knowledge card cabinet.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "embedding_model": (
            settings.embedding_model
            if settings.embedding_provider == "local-transformers" or settings.embedding_api_url
            else "local-hash-smoke"
        ),
        "embedding_provider": settings.embedding_provider,
        "embedding_dimensions": settings.embedding_dimensions,
        "semantic_mode": settings.embedding_provider == "local-transformers" or bool(settings.embedding_api_url),
    }


@app.get("/cards")
def cards() -> list[dict[str, Any]]:
    return [compact_card(row) for row in db.list_cards()]


@app.post("/cards")
async def create_or_update_card(card: CardInput) -> dict[str, Any]:
    payload = card.model_dump()
    embedding, embedding_model = await embed_text(build_embedding_text(payload))
    row = db.upsert_card(payload, embedding, embedding_model)
    similar = db.find_similar_cards(card.id, embedding)
    db.save_suggested_relations(card.id, similar)
    return {
        "card": compact_card(row),
        "embedding_model": embedding_model,
        "suggested_relations": similar,
    }


@app.get("/search", response_model=list[SearchResult])
async def search(
    q: str = Query(min_length=1, description="自然語言搜尋問題"),
    limit: int = Query(default=10, ge=1, le=50),
) -> list[dict[str, Any]]:
    embedding, _ = await embed_text(q, is_query=True)
    return [compact_card(row) for row in db.search_cards(embedding, limit)]


@app.get("/cards/{card_id}/related", response_model=list[RelationResult])
def related_cards(card_id: str) -> list[dict[str, Any]]:
    if not db.get_card(card_id):
        raise HTTPException(status_code=404, detail="Card not found")
    return [
        {
            "relation_type": row["relation_type"],
            "score": float(row["score"]),
            "status": row["status"],
            "card": compact_card(row),
        }
        for row in db.get_related_cards(card_id)
    ]


@app.post("/cards/{card_id}/relations/{target_id}/confirm")
def confirm_card_relation(card_id: str, target_id: str) -> dict[str, Any]:
    if card_id == target_id or not db.get_card(card_id) or not db.get_card(target_id):
        raise HTTPException(status_code=404, detail="Both cards must exist and be different")
    return db.confirm_relation(card_id, target_id)
