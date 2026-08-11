import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import psycopg
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .embeddings import build_embedding_text, embed_text
from .summarization import generate_card_draft


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


class CardUpdate(BaseModel):
    number: str | None = Field(default=None, min_length=1, max_length=30)
    topic: str | None = Field(default=None, min_length=1, max_length=120)
    title: str | None = Field(default=None, min_length=1, max_length=240)
    question: str | None = None
    summary: str | None = None
    analogy: str | None = None
    detail: str | None = None
    source: str | None = None
    tags: list[str] | None = None


class CardDraftInput(BaseModel):
    content: str = Field(min_length=20, max_length=20000)
    source: str = Field(default="", max_length=1000)


class CardDraftOutput(BaseModel):
    draft: dict[str, Any]
    model: str


class SearchResult(BaseModel):
    id: str
    number: str
    topic: str
    title: str
    question: str
    summary: str
    analogy: str
    detail: str
    source: str
    tags: list[str]
    score: float


class RelationResult(BaseModel):
    relation_type: str
    score: float
    status: str
    card: SearchResult


class SuggestedRelation(BaseModel):
    id: str
    score: float


class CardWriteResponse(BaseModel):
    card: SearchResult
    embedding_model: str
    suggested_relations: list[SuggestedRelation]


class TrashCardResponse(SearchResult):
    deleted_at: str | None = None


class TrashActionResponse(BaseModel):
    status: str
    card: TrashCardResponse


class RestoreActionResponse(BaseModel):
    status: str
    card: SearchResult


class PermanentDeleteResponse(BaseModel):
    status: str
    id: str


class ConfirmedRelationResponse(BaseModel):
    source_id: str
    target_id: str
    relation_type: str
    score: float
    status: str


class ApiInfoResponse(BaseModel):
    name: str
    version: str
    compatibility: str
    authentication: str
    intended_use: str
    capabilities: list[str]
    docs: str
    openapi: str


class HealthResponse(BaseModel):
    status: str
    embedding_model: str
    embedding_provider: str
    embedding_dimensions: int
    semantic_mode: bool
    summary_provider: str
    summary_model: str


def compact_card(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "number": row["number"],
        "topic": row["topic"],
        "title": row["title"],
        "question": row["question"],
        "summary": row["summary"],
        "analogy": row.get("analogy", ""),
        "detail": row.get("detail", ""),
        "source": row["source"],
        "tags": list(row.get("tags") or []),
        "score": float(row.get("score", 0.0)),
    }


def compact_trash_card(row: dict[str, Any]) -> dict[str, Any]:
    card = compact_card(row)
    deleted_at = row.get("deleted_at")
    card["deleted_at"] = deleted_at.isoformat() if deleted_at else None
    return card


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
    version="0.2.0",
    description=(
        "Knowledge Card Cabinet API. Manage knowledge cards, generate local AI drafts, "
        "search by embedding, and inspect semantic or confirmed relations. "
        "The versioned public contract is available under /api/v1."
    ),
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
        "summary_provider": settings.summary_provider,
        "summary_model": settings.summary_model,
    }


@app.get("/cards")
def cards() -> list[dict[str, Any]]:
    return [compact_card(row) for row in db.list_cards()]


@app.get("/cards/{card_id}")
def get_card(card_id: str) -> dict[str, Any]:
    row = db.get_card(card_id)
    if not row:
        raise HTTPException(status_code=404, detail="Active card not found")
    return compact_card(row)


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


@app.patch("/cards/{card_id}")
async def update_card(card_id: str, changes: CardUpdate) -> dict[str, Any]:
    existing = db.get_card(card_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Active card not found")

    updates = changes.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="至少需要提供一個要更新的欄位")

    payload = {
        "id": card_id,
        "number": updates.get("number", existing["number"]),
        "topic": updates.get("topic", existing["topic"]),
        "title": updates.get("title", existing["title"]),
        "question": updates.get("question", existing["question"]),
        "summary": updates.get("summary", existing["summary"]),
        "analogy": updates.get("analogy", existing["analogy"]),
        "detail": updates.get("detail", existing["detail"]),
        "source": updates.get("source", existing["source"]),
        "tags": updates.get("tags", list(existing.get("tags") or [])),
    }
    embedding, embedding_model = await embed_text(build_embedding_text(payload))
    row = db.upsert_card(payload, embedding, embedding_model)
    similar = db.find_similar_cards(card_id, embedding)
    db.save_suggested_relations(card_id, similar)
    return {
        "card": compact_card(row),
        "embedding_model": embedding_model,
        "suggested_relations": similar,
    }


@app.post("/cards/draft", response_model=CardDraftOutput)
async def draft_card(payload: CardDraftInput) -> CardDraftOutput:
    try:
        draft, model = await generate_card_draft(payload.content, payload.source)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"本機整理模型目前無法使用：{exc}") from exc
    return CardDraftOutput(draft=draft, model=model)


@app.delete("/cards/{card_id}")
def delete_card(card_id: str) -> dict[str, Any]:
    row = db.soft_delete_card(card_id)
    if not row:
        raise HTTPException(status_code=404, detail="Active card not found")
    return {"status": "trashed", "card": compact_trash_card(row)}


@app.get("/trash")
def trash() -> list[dict[str, Any]]:
    return [compact_trash_card(row) for row in db.list_trash()]


@app.post("/cards/{card_id}/restore")
def restore_card(card_id: str) -> dict[str, Any]:
    row = db.restore_card(card_id)
    if not row:
        raise HTTPException(status_code=404, detail="Trashed card not found")
    return {"status": "restored", "card": compact_card(row)}


@app.delete("/trash/{card_id}")
def permanently_delete_card(card_id: str) -> dict[str, str]:
    if not db.permanently_delete_card(card_id):
        raise HTTPException(status_code=404, detail="Trashed card not found")
    return {"status": "deleted", "id": card_id}


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


# ---------------------------------------------------------------------------
# Versioned API
# ---------------------------------------------------------------------------
# The original routes above are kept for the existing Next.js proxy and local
# clients. New integrations should use /api/v1, whose surface is documented in
# backend/API.md and exposed through FastAPI's OpenAPI document.
api_v1 = APIRouter(prefix="/api/v1")


@api_v1.get("", response_model=ApiInfoResponse, tags=["meta"])
def api_info() -> dict[str, Any]:
    return {
        "name": "Knowledge Card Cabinet API",
        "version": "v1",
        "compatibility": "The unversioned MVP routes remain available for the web app.",
        "authentication": "none",
        "intended_use": "local or trusted-network integrations",
        "capabilities": [
            "cards.read",
            "cards.write",
            "cards.draft",
            "cards.search",
            "cards.relations.read",
            "cards.relations.confirm",
            "trash.restore",
            "trash.delete",
        ],
        "docs": "/docs",
        "openapi": "/openapi.json",
    }


@api_v1.get("/health", response_model=HealthResponse, tags=["meta"])
def health_v1() -> dict[str, Any]:
    return health()


@api_v1.get("/cards", response_model=list[SearchResult], tags=["cards"])
def cards_v1() -> list[dict[str, Any]]:
    return cards()


@api_v1.get("/cards/{card_id}", response_model=SearchResult, tags=["cards"])
def get_card_v1(card_id: str) -> dict[str, Any]:
    return get_card(card_id)


@api_v1.post("/cards", response_model=CardWriteResponse, tags=["cards"])
async def create_or_update_card_v1(card: CardInput) -> dict[str, Any]:
    return await create_or_update_card(card)


@api_v1.patch("/cards/{card_id}", response_model=CardWriteResponse, tags=["cards"])
async def update_card_v1(card_id: str, changes: CardUpdate) -> dict[str, Any]:
    return await update_card(card_id, changes)


@api_v1.post("/cards/draft", response_model=CardDraftOutput, tags=["drafts"])
async def draft_card_v1(payload: CardDraftInput) -> CardDraftOutput:
    return await draft_card(payload)


@api_v1.delete("/cards/{card_id}", response_model=TrashActionResponse, tags=["cards"])
def delete_card_v1(card_id: str) -> dict[str, Any]:
    return delete_card(card_id)


@api_v1.get("/trash", response_model=list[TrashCardResponse], tags=["trash"])
def trash_v1() -> list[dict[str, Any]]:
    return trash()


@api_v1.post("/cards/{card_id}/restore", response_model=RestoreActionResponse, tags=["trash"])
def restore_card_v1(card_id: str) -> dict[str, Any]:
    return restore_card(card_id)


@api_v1.delete("/trash/{card_id}", response_model=PermanentDeleteResponse, tags=["trash"])
def permanently_delete_card_v1(card_id: str) -> dict[str, str]:
    return permanently_delete_card(card_id)


@api_v1.get("/search", response_model=list[SearchResult], tags=["search"])
async def search_v1(
    q: str = Query(min_length=1, description="自然語言搜尋問題"),
    limit: int = Query(default=10, ge=1, le=50),
) -> list[dict[str, Any]]:
    return await search(q=q, limit=limit)


@api_v1.get("/cards/{card_id}/related", response_model=list[RelationResult], tags=["relations"])
def related_cards_v1(card_id: str) -> list[dict[str, Any]]:
    return related_cards(card_id)


@api_v1.post(
    "/cards/{card_id}/relations/{target_id}/confirm",
    response_model=ConfirmedRelationResponse,
    tags=["relations"],
)
def confirm_card_relation_v1(card_id: str, target_id: str) -> dict[str, Any]:
    return confirm_card_relation(card_id, target_id)


app.include_router(api_v1)
