import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Literal

import psycopg
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .covers import build_cover
from .embeddings import build_embedding_text, embed_text
from .model_runtime import create_model_runtime
from .model_state import snapshot as model_state_snapshot
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


class ModelSelectInput(BaseModel):
    kind: Literal["summary", "embedding"]
    model_id: str = Field(min_length=1, max_length=200)


class ProviderSettingsInput(BaseModel):
    source: Literal["local", "api"] = "local"
    api_url: str = Field(default="", max_length=1000)
    model: str = Field(default="", max_length=300)
    api_format: Literal["openai", "tei"] = "openai"
    api_key: str = Field(default="", max_length=1000)
    clear_api_key: bool = False


class RuntimeSettingsInput(BaseModel):
    summary: ProviderSettingsInput
    embedding: ProviderSettingsInput


class DatabaseResetInput(BaseModel):
    confirmation: str = Field(min_length=1, max_length=40)


class DatabaseImportInput(BaseModel):
    format_version: int = Field(ge=1, le=1)
    cards: list[dict[str, Any]] = Field(default_factory=list)
    relations: list[dict[str, Any]] = Field(default_factory=list)


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
    cover: "CoverSpec | None" = None


class CoverSpec(BaseModel):
    version: int
    seed: str
    pattern: Literal["orbit", "grid", "ladder", "shelf"]
    accent: Literal["coral", "sky", "lavender", "mint"]
    color: str
    soft_color: str
    background: str
    rotation: float
    scale: float
    density: float
    orbit: float
    motifs: list["CoverMotif"] = Field(default_factory=list)


class CoverMotif(BaseModel):
    shape: Literal["block", "stair", "corner", "zigzag", "stack", "window", "plus", "frame"]
    x: float
    y: float
    size: float
    rotation: float
    opacity: float
    weight: float


SearchResult.model_rebuild()


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
    summary_status: str = "available"
    model_error: str = ""


def compact_card(row: dict[str, Any]) -> dict[str, Any]:
    cover = row.get("cover_data") or row.get("cover")
    if not cover and row.get("embedding") is not None:
        cover = build_cover(row["embedding"])
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
        "cover": cover,
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
            db.backfill_covers()
            return
        except psycopg.OperationalError:
            if attempt == 29:
                raise
            await asyncio.sleep(2)


model_runtime = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model_runtime
    await initialize_database()
    model_runtime = create_model_runtime()
    try:
        yield
    finally:
        model_runtime = None


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
    if model_runtime is not None:
        return {"status": "ok", **model_runtime.health()}
    state = model_state_snapshot()
    return {
        "status": "ok",
        "embedding_model": state["embedding_model"],
        "embedding_provider": state["embedding_provider"],
        "embedding_dimensions": settings.embedding_dimensions,
        "semantic_mode": state["embedding_provider"] == "local-transformers" or bool(settings.embedding_api_url),
        "summary_provider": state["summary_provider"],
        "summary_model": state["summary_model"],
    }


def current_model_runtime():
    if model_runtime is None:
        raise HTTPException(status_code=503, detail="模型 runtime 尚未完成初始化")
    return model_runtime


async def reindex_cards() -> int:
    """Re-embed active cards and rebuild only semantic relations."""
    cards_to_update = db.list_cards()
    computed: list[tuple[str, list[float], str, dict[str, Any]]] = []
    for card in cards_to_update:
        embedding, embedding_model = await embed_text(build_embedding_text(card))
        computed.append((card["id"], embedding, embedding_model, build_cover(embedding)))

    for card_id, embedding, embedding_model, cover in computed:
        db.update_card_embedding(card_id, embedding, embedding_model, cover)

    db.clear_semantic_relations()
    for card_id, embedding, _, _ in computed:
        db.save_suggested_relations(card_id, db.find_similar_cards(card_id, embedding))
    return len(computed)


@app.get("/models", tags=["models"])
def models() -> dict[str, Any]:
    return current_model_runtime().catalog()


@app.post("/models/select", tags=["models"])
async def select_model(payload: ModelSelectInput) -> dict[str, Any]:
    runtime = current_model_runtime()
    previous = runtime.catalog()["active"][payload.kind]
    selection = None
    try:
        selection = await runtime.select(payload.kind, payload.model_id)
        reindexed = 0
        if payload.kind == "embedding" and selection["changed"]:
            reindexed = await reindex_cards()
        return {
            "status": "active",
            "selection": selection,
            "reindexed_cards": reindexed,
            "models": runtime.catalog(),
        }
    except Exception as exc:
        if selection and selection["changed"]:
            try:
                await runtime.select(payload.kind, previous, allow_uninstalled=True)
            except Exception:
                pass
        if getattr(exc, "code", "") == "MODEL_NOT_INSTALLED":
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        raise HTTPException(status_code=500, detail=f"切換模型失敗：{exc}") from exc


@app.post("/models/{model_id}", status_code=202, tags=["models"])
async def download_model(model_id: str) -> dict[str, Any]:
    runtime = current_model_runtime()
    model = next((item for item in runtime.catalog()["models"] if item["id"] == model_id), None)
    if model is None:
        raise HTTPException(status_code=404, detail="Model not found")
    download_task = asyncio.create_task(runtime.download(model_id))
    # The operation state is exposed through GET /models; consume failures here
    # so a failed background download does not become an unhandled task warning.
    download_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
    return {"status": "downloading", "model": model}


@app.get("/settings", tags=["settings"])
def runtime_settings() -> dict[str, Any]:
    return current_model_runtime().settings()


@app.put("/settings", tags=["settings"])
async def update_runtime_settings(payload: RuntimeSettingsInput) -> dict[str, Any]:
    runtime = current_model_runtime()
    previous = runtime.settings_state()
    try:
        result = runtime.update_settings(payload.model_dump())
        reindexed = 0
        if result["embedding_changed"]:
            reindexed = await reindex_cards()
        return {
            "status": "saved",
            "settings": runtime.settings(),
            "reindexed_cards": reindexed,
        }
    except ValueError as exc:
        runtime.restore_settings_state(previous)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        runtime.restore_settings_state(previous)
        raise HTTPException(status_code=502, detail=f"套用設定失敗：{exc}") from exc


@app.get("/database/export", tags=["database"])
def export_database() -> dict[str, Any]:
    payload = db.export_database()
    payload["exported_at"] = datetime.now().astimezone().isoformat()
    return payload


@app.post("/database/reset", tags=["database"])
def reset_database(payload: DatabaseResetInput) -> dict[str, Any]:
    if payload.confirmation != "RESET DATABASE":
        raise HTTPException(
            status_code=400,
            detail="請輸入 RESET DATABASE 才能重置本機資料庫。",
        )
    removed = db.reset_database()
    return {
        "status": "reset",
        "removed": removed,
        "preserved": ["schema", "runtime_settings", "model_files"],
    }


@app.post("/database/import", tags=["database"])
def import_database(payload: DatabaseImportInput) -> dict[str, Any]:
    try:
        imported = db.import_database(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "imported", "imported": imported}


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
    cover = build_cover(embedding)
    row = db.upsert_card(payload, embedding, embedding_model, cover)
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
    cover = build_cover(embedding)
    row = db.upsert_card(payload, embedding, embedding_model, cover)
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
            "models.read",
            "models.download",
            "models.select",
            "settings.read",
            "settings.write",
            "database.export",
            "database.reset",
            "database.import",
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


@api_v1.get("/models", tags=["models"])
def models_v1() -> dict[str, Any]:
    return models()


@api_v1.post("/models/select", tags=["models"])
async def select_model_v1(payload: ModelSelectInput) -> dict[str, Any]:
    return await select_model(payload)


@api_v1.post("/models/{model_id}", status_code=202, tags=["models"])
async def download_model_v1(model_id: str) -> dict[str, Any]:
    return await download_model(model_id)


@api_v1.get("/settings", tags=["settings"])
def runtime_settings_v1() -> dict[str, Any]:
    return runtime_settings()


@api_v1.put("/settings", tags=["settings"])
async def update_runtime_settings_v1(payload: RuntimeSettingsInput) -> dict[str, Any]:
    return await update_runtime_settings(payload)


@api_v1.get("/database/export", tags=["database"])
def export_database_v1() -> dict[str, Any]:
    return export_database()


@api_v1.post("/database/reset", tags=["database"])
def reset_database_v1(payload: DatabaseResetInput) -> dict[str, Any]:
    return reset_database(payload)


@api_v1.post("/database/import", tags=["database"])
def import_database_v1(payload: DatabaseImportInput) -> dict[str, Any]:
    return import_database(payload)


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
