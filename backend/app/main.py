import asyncio
import time
from contextlib import asynccontextmanager
from datetime import datetime
from secrets import compare_digest
from typing import Any, Callable, Literal

import psycopg
from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db
from .audit import write_audit
from .config import settings
from .covers import build_cover
from .embeddings import build_embedding_text, embed_text, embedding_source_hash
from .model_runtime import create_model_runtime
from .model_state import snapshot as model_state_snapshot
from .summarization import generate_card_draft
from .tasks import TaskContext, TaskManager


class CardInput(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    number: str = Field(min_length=1, max_length=30)
    topic: str = Field(min_length=1, max_length=120)
    category: str | None = Field(default=None, max_length=120)
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
    category: str | None = Field(default=None, max_length=120)
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
    format_version: int = Field(ge=1, le=2)
    checksum_sha256: str | None = None
    cards: list[dict[str, Any]] = Field(default_factory=list)
    categories: list[dict[str, Any]] = Field(default_factory=list)
    relations: list[dict[str, Any]] = Field(default_factory=list)
    runtime_settings: dict[str, str] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    conflict_strategy: Literal["replace", "skip", "update"] = "replace"


class BatchOrganizeInput(BaseModel):
    card_ids: list[str] = Field(default_factory=list, max_length=200)
    apply: bool = False


class CategoryInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class CategoryMergeInput(BaseModel):
    source: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=120)


class SearchResult(BaseModel):
    id: str
    number: str
    topic: str
    category: str
    title: str
    question: str
    summary: str
    analogy: str
    detail: str
    source: str
    tags: list[str]
    score: float
    search_reasons: list[str] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None
    cover: "CoverSpec | None" = None


class CoverSpec(BaseModel):
    version: int
    seed: str
    pattern: Literal["orbit", "grid", "ladder", "shelf"]
    accent: Literal["coral", "sky", "lavender", "mint"]
    color: str
    soft_color: str
    background: str
    density: float
    orbit: float
    motifs: list["CoverMotif"] = Field(default_factory=list)


class CoverMotif(BaseModel):
    shape: Literal[
        "steps",
        "quad",
        "nested",
        "crosshair-box",
        "link",
        "target",
        "triple-dot",
        "constellation",
        "folder",
        "stack",
        "arch",
        "lines",
        "corners",
        "diagonal",
        "pill",
        "brackets",
        "bars",
        "crosshair",
    ]
    x: float
    y: float
    size: float
    opacity: float
    weight: float


SearchResult.model_rebuild()


class RelationResult(BaseModel):
    relation_type: str
    score: float
    status: str
    reason: str = ""
    created_at: str | None = None
    updated_at: str | None = None
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


class TaskResponse(BaseModel):
    task_id: str
    operation: str
    label: str
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    progress: int
    message: str
    result: dict[str, Any] | None = None
    error: str = ""
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    can_retry: bool = False


def compact_card(row: dict[str, Any]) -> dict[str, Any]:
    cover = row.get("cover_data") or row.get("cover")
    if not cover and row.get("embedding") is not None:
        cover = build_cover(row["embedding"])
    return {
        "id": row["id"],
        "number": row["number"],
        "topic": row["topic"],
        "category": row.get("category") or row["topic"],
        "title": row["title"],
        "question": row["question"],
        "summary": row["summary"],
        "analogy": row.get("analogy", ""),
        "detail": row.get("detail", ""),
        "source": row["source"],
        "tags": list(row.get("tags") or []),
        "score": float(row.get("score", 0.0)),
        "search_reasons": list(row.get("search_reasons") or []),
        "created_at": row.get("created_at").isoformat() if hasattr(row.get("created_at"), "isoformat") else row.get("created_at"),
        "updated_at": row.get("updated_at").isoformat() if hasattr(row.get("updated_at"), "isoformat") else row.get("updated_at"),
        "cover": cover,
    }


def compact_trash_card(row: dict[str, Any]) -> dict[str, Any]:
    card = compact_card(row)
    deleted_at = row.get("deleted_at")
    card["deleted_at"] = deleted_at.isoformat() if deleted_at else None
    return card


async def initialize_database() -> bool:
    for attempt in range(30):
        try:
            dimension_migrated = db.ensure_schema()
            db.backfill_covers()
            db.ensure_auto_backup(settings.backup_dir)
            return dimension_migrated
        except psycopg.OperationalError:
            if attempt == 29:
                raise
            await asyncio.sleep(2)


model_runtime = None
task_manager: TaskManager | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model_runtime, task_manager
    dimension_migrated = await initialize_database()
    model_runtime = create_model_runtime(settings.model_cache_dir)
    task_manager = TaskManager(settings.task_state_file)
    if dimension_migrated:
        async def dimension_reindex_worker(context: TaskContext) -> dict[str, Any]:
            reindexed = await reindex_cards(progress=context.update)
            return {"status": "reindexed", "reindexed_cards": reindexed, "embedding_dimensions": settings.embedding_dimensions}

        task_manager.start(
            "dimension_migration",
            f"切換至 {settings.embedding_dimensions} 維並重建 embedding",
            dimension_reindex_worker,
        )
    try:
        yield
    finally:
        if task_manager is not None:
            await task_manager.close()
        task_manager = None
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
    allow_origins=list(settings.cors_origins),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def api_security(request: Request, call_next):
    started = time.perf_counter()
    route = request.url.path
    is_public = request.method == "OPTIONS" or route in {"/health", "/docs", "/openapi.json"} or route.startswith("/docs/")
    actor = "anonymous"
    token = ""
    authorization = request.headers.get("authorization", "")
    if authorization.startswith("Bearer "):
        token = authorization[7:].strip()

    if not is_public and (settings.api_token or settings.api_read_token):
        if settings.api_token and compare_digest(token, settings.api_token):
            actor = "api-token"
        elif settings.api_read_token and compare_digest(token, settings.api_read_token):
            actor = "read-token"
            if request.method not in {"GET", "HEAD"}:
                response = JSONResponse({"detail": "目前 Token 只有讀取權限"}, status_code=403)
                write_audit(settings.audit_log_file, method=request.method, route=route, status=403, actor=actor, duration_ms=0)
                return response
        else:
            response = JSONResponse({"detail": "需要有效的 API Token"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
            write_audit(settings.audit_log_file, method=request.method, route=route, status=401, actor="rejected", duration_ms=0)
            return response

    response = await call_next(request)
    write_audit(
        settings.audit_log_file,
        method=request.method,
        route=route,
        status=response.status_code,
        actor=actor,
        duration_ms=int((time.perf_counter() - started) * 1000),
    )
    return response


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


def current_task_manager() -> TaskManager:
    if task_manager is None:
        raise HTTPException(status_code=503, detail="背景任務管理器尚未完成初始化")
    return task_manager


async def reindex_cards(progress: Callable[[int, str], None] | None = None) -> int:
    """Re-embed only cards whose content or active embedding model is stale."""
    all_cards = db.list_cards()
    current_model = str(model_state_snapshot().get("embedding_model", ""))
    cards_to_update = [
        card
        for card in all_cards
        if not card.get("embedding")
        or card.get("embedding_model") != current_model
        or card.get("embedding_source_hash") != embedding_source_hash(card)
    ]
    computed: list[tuple[str, list[float], str, dict[str, Any]]] = []
    total = len(cards_to_update)
    for index, card in enumerate(cards_to_update, start=1):
        embedding, embedding_model = await embed_text(build_embedding_text(card))
        computed.append((card["id"], embedding, embedding_model, build_cover(embedding)))
        if progress:
            progress(10 + int(index / max(total, 1) * 70), f"已建立 {index}/{total} 張卡片向量")

    for card_id, embedding, embedding_model, cover in computed:
        card = next(item for item in cards_to_update if item["id"] == card_id)
        db.update_card_embedding(card_id, embedding, embedding_model, cover, embedding_source_hash(card))

    if progress:
        progress(85, "正在重建語意關聯")
    if len(cards_to_update) == len(all_cards):
        db.clear_semantic_relations()
    else:
        db.clear_semantic_relations_for([card["id"] for card in cards_to_update])
    for card_id, embedding, _, _ in computed:
        db.save_suggested_relations(card_id, db.find_similar_cards(card_id, embedding))
    if progress:
        progress(95, "正在保存索引")
    return len(computed)


def start_download_task(model_id: str) -> dict[str, Any]:
    runtime = current_model_runtime()
    model = next((item for item in runtime.catalog()["models"] if item["id"] == model_id), None)
    if model is None:
        raise HTTPException(status_code=404, detail="找不到指定模型")

    async def worker(context: TaskContext) -> dict[str, Any]:
        context.update(10, "正在下載並載入模型（會沿用既有快取）")
        result = await runtime.download(model_id)
        context.update(95, "模型已載入，正在檢查檔案")
        return {"model": result, "inspection": runtime.inspect(model_id)}

    return current_task_manager().start(
        "model_download",
        f"下載 {model['label']}",
        worker,
        retry_payload={"model_id": model_id},
    )


def start_model_select_task(
    kind: str,
    model_id: str,
    selection: dict[str, Any],
    previous: str,
) -> dict[str, Any]:
    runtime = current_model_runtime()

    async def worker(context: TaskContext) -> dict[str, Any]:
        try:
            reindexed = await reindex_cards(progress=context.update)
            return {"status": "active", "selection": selection, "reindexed_cards": reindexed, "models": runtime.catalog()}
        except asyncio.CancelledError:
            try:
                await runtime.select(kind, previous, allow_uninstalled=True)
            except Exception:
                pass
            raise
        except Exception:
            try:
                await runtime.select(kind, previous, allow_uninstalled=True)
            except Exception:
                pass
            raise

    return current_task_manager().start(
        "model_select",
        f"啟用 {model_id} 並重建 embedding",
        worker,
        retry_payload={"kind": kind, "model_id": model_id, "previous_model_id": previous},
    )


@app.get("/models", tags=["models"])
def models() -> dict[str, Any]:
    return current_model_runtime().catalog()


@app.get("/models/{model_id}/inspect", tags=["models"])
def inspect_model(model_id: str) -> dict[str, Any]:
    try:
        return current_model_runtime().inspect(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/models/{model_id}", tags=["models"])
def remove_model(model_id: str) -> dict[str, Any]:
    try:
        return {"status": "removed", "model": current_model_runtime().remove(model_id)}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/models/select", tags=["models"])
async def select_model(payload: ModelSelectInput) -> dict[str, Any]:
    runtime = current_model_runtime()
    previous = runtime.catalog()["active"][payload.kind]
    try:
        selection = await runtime.select(payload.kind, payload.model_id)
    except Exception as exc:
        if getattr(exc, "code", "") == "MODEL_NOT_INSTALLED":
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        raise HTTPException(status_code=500, detail=f"切換模型失敗：{exc}") from exc

    if payload.kind != "embedding" or not selection["changed"]:
        return {"status": "active", "selection": selection, "reindexed_cards": 0, "models": runtime.catalog()}

    task = start_model_select_task(payload.kind, payload.model_id, selection, previous)
    return {"status": "accepted", "task_id": task["task_id"], "selection": selection, "models": runtime.catalog()}


@app.post("/models/{model_id}", status_code=202, tags=["models"])
async def download_model(model_id: str) -> dict[str, Any]:
    runtime = current_model_runtime()
    task = start_download_task(model_id)
    model = next(item for item in runtime.catalog()["models"] if item["id"] == model_id)
    return {"status": "accepted", "task_id": task["task_id"], "model": model}


@app.get("/settings", tags=["settings"])
def runtime_settings() -> dict[str, Any]:
    return current_model_runtime().settings()


@app.put("/settings", tags=["settings"])
async def update_runtime_settings(payload: RuntimeSettingsInput) -> dict[str, Any]:
    runtime = current_model_runtime()
    previous = runtime.settings_state()
    try:
        result = runtime.update_settings(payload.model_dump())
        if not result["embedding_changed"]:
            return {"status": "saved", "settings": runtime.settings(), "reindexed_cards": 0}

        async def worker(context: TaskContext) -> dict[str, Any]:
            try:
                reindexed = await reindex_cards(progress=context.update)
                return {"status": "saved", "settings": runtime.settings(), "reindexed_cards": reindexed}
            except asyncio.CancelledError:
                runtime.restore_settings_state(previous)
                raise
            except Exception:
                runtime.restore_settings_state(previous)
                raise

        task = current_task_manager().start("settings_update", "套用模型設定並重建 embedding", worker)
        return {"status": "accepted", "task_id": task["task_id"], "settings": runtime.settings()}
    except ValueError as exc:
        runtime.restore_settings_state(previous)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        runtime.restore_settings_state(previous)
        raise HTTPException(status_code=502, detail=f"套用設定失敗：{exc}") from exc


@app.get("/tasks", response_model=list[TaskResponse], tags=["tasks"])
def tasks(limit: int = Query(default=20, ge=1, le=100)) -> list[dict[str, Any]]:
    return current_task_manager().list(limit)


@app.get("/tasks/{task_id}", response_model=TaskResponse, tags=["tasks"])
def task(task_id: str) -> dict[str, Any]:
    try:
        return current_task_manager().get(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="找不到指定背景任務") from exc


@app.post("/tasks/{task_id}/cancel", response_model=TaskResponse, tags=["tasks"])
async def cancel_task(task_id: str) -> dict[str, Any]:
    try:
        return await current_task_manager().cancel(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="找不到指定背景任務") from exc


@app.post("/tasks/{task_id}/retry", response_model=TaskResponse, tags=["tasks"])
async def retry_task(task_id: str) -> dict[str, Any]:
    manager = current_task_manager()
    try:
        previous_task = manager.raw_get(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="找不到指定背景任務") from exc
    if previous_task["status"] not in {"failed", "cancelled"}:
        raise HTTPException(status_code=409, detail="只有失敗或已取消的任務可以重試")
    retry_payload = previous_task.get("retry_payload") or {}
    try:
        if previous_task["operation"] == "model_download":
            task = start_download_task(str(retry_payload["model_id"]))
        elif previous_task["operation"] == "model_select":
            kind = str(retry_payload["kind"])
            model_id = str(retry_payload["model_id"])
            previous = str(retry_payload["previous_model_id"])
            selection = await current_model_runtime().select(kind, model_id)
            task = start_model_select_task(kind, model_id, selection, previous)
        else:
            raise ValueError("這個任務目前無法自動重試，請重新提交設定")
        return task
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"重新啟動任務失敗：{exc}") from exc


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
    backup = db.create_backup_file(settings.backup_dir, "before-reset")
    removed = db.reset_database()
    return {
        "status": "reset",
        "removed": removed,
        "preserved": ["schema", "runtime_settings", "model_files"],
        "backup": backup,
    }


@app.post("/database/import", tags=["database"])
def import_database(payload: DatabaseImportInput) -> dict[str, Any]:
    try:
        backup = db.create_backup_file(settings.backup_dir, "before-import")
        imported = db.import_database(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "imported", "imported": imported, "backup": backup}


@app.post("/database/import/preview", tags=["database"])
def preview_database_import(payload: DatabaseImportInput) -> dict[str, Any]:
    if payload.checksum_sha256 and not compare_digest(payload.checksum_sha256, db._checksum_payload(payload.model_dump())):
        raise HTTPException(status_code=400, detail="備份檔案校驗碼不符，可能已損壞或被修改")
    cards = payload.cards
    ids = [str(card.get("id", "")).strip() for card in cards]
    duplicate_ids = sorted({card_id for card_id in ids if card_id and ids.count(card_id) > 1})
    missing_fields = [
        {"id": str(card.get("id", "")), "fields": [field for field in ("number", "topic", "title") if not str(card.get(field, "")).strip()]}
        for card in cards
        if any(not str(card.get(field, "")).strip() for field in ("number", "topic", "title"))
    ]
    relation_ids = {str(card.get("id", "")).strip() for card in cards}
    invalid_relations = [
        relation for relation in payload.relations
        if str(relation.get("source_id", "")) not in relation_ids or str(relation.get("target_id", "")) not in relation_ids
    ]
    valid = not duplicate_ids and not missing_fields and not invalid_relations
    if not valid:
        return {
            "valid": False,
            "format_version": payload.format_version,
            "conflict_strategy": payload.conflict_strategy,
            "summary": {"cards": len(cards), "relations": len(payload.relations), "duplicate_ids": len(duplicate_ids), "invalid_cards": len(missing_fields), "invalid_relations": len(invalid_relations)},
            "duplicate_ids": duplicate_ids,
            "missing_fields": missing_fields,
            "invalid_relations": invalid_relations[:20],
        }
    preview = db.preview_import(payload.model_dump())
    preview["duplicate_ids"] = []
    preview["missing_fields"] = []
    preview["invalid_relations"] = []
    return preview


@app.get("/categories", tags=["categories"])
def categories() -> list[dict[str, Any]]:
    return db.list_categories()


@app.post("/categories", tags=["categories"])
def create_category(payload: CategoryInput) -> dict[str, Any]:
    try:
        return db.create_category(payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.patch("/categories/{category_name}", tags=["categories"])
async def rename_category(category_name: str, payload: CategoryInput) -> dict[str, Any]:
    try:
        result = db.rename_category(category_name, payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail="找不到指定分類")
    if result.get("affected_cards"):
        async def worker(context: TaskContext) -> dict[str, Any]:
            reindexed = await reindex_cards(progress=context.update)
            return {"status": "reindexed", "reindexed_cards": reindexed}
        result["task_id"] = current_task_manager().start("category_reindex", "分類變更後重建 embedding", worker)["task_id"]
    return result


@app.post("/categories/merge", tags=["categories"])
async def merge_categories(payload: CategoryMergeInput) -> dict[str, Any]:
    try:
        result = db.merge_categories(payload.source, payload.target)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail="找不到要合併的來源分類")
    if result.get("affected_cards"):
        async def worker(context: TaskContext) -> dict[str, Any]:
            reindexed = await reindex_cards(progress=context.update)
            return {"status": "reindexed", "reindexed_cards": reindexed}
        result["task_id"] = current_task_manager().start("category_reindex", "分類合併後重建 embedding", worker)["task_id"]
    return result


@app.get("/cards/duplicates", tags=["quality"])
def duplicate_cards() -> dict[str, Any]:
    analysis = db.batch_organize()
    return {"duplicates": analysis["duplicates"]}


@app.post("/cards/batch/organize", tags=["quality"])
async def batch_organize_cards(payload: BatchOrganizeInput) -> dict[str, Any]:
    analysis = db.batch_organize(payload.card_ids or None)
    if not payload.apply:
        return {"status": "preview", **analysis}
    changed_ids: list[str] = []
    for suggestion in analysis["cards"]:
        if not suggestion["changed"]:
            continue
        row = db.update_card_metadata(suggestion["id"], suggestion["suggested_category"], suggestion["suggested_tags"])
        if row:
            changed_ids.append(suggestion["id"])
    task_id = None
    if changed_ids:
        async def worker(context: TaskContext) -> dict[str, Any]:
            reindexed = await reindex_cards(progress=context.update)
            return {"status": "applied", "changed_cards": len(changed_ids), "reindexed_cards": reindexed}
        task_id = current_task_manager().start("batch_organize", "套用 AI 批次整理建議", worker)["task_id"]
    return {"status": "accepted" if task_id else "applied", "task_id": task_id, "changed_cards": len(changed_ids), **analysis}


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
    payload["category"] = (payload.get("category") or payload["topic"]).strip()
    embedding, embedding_model = await embed_text(build_embedding_text(payload))
    cover = build_cover(embedding)
    row = db.upsert_card(payload, embedding, embedding_model, cover, embedding_source_hash(payload))
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
        "category": updates.get("category") or existing.get("category") or existing["topic"],
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
    row = db.upsert_card(payload, embedding, embedding_model, cover, embedding_source_hash(payload))
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
    category: str | None = Query(default=None, max_length=120),
    tag: str | None = Query(default=None, max_length=120),
    sort: Literal["relevance", "updated", "title"] = "relevance",
) -> list[dict[str, Any]]:
    embedding, _ = await embed_text(q, is_query=True)
    return [compact_card(row) for row in db.search_cards(embedding, q, limit, category, tag, sort)]


@app.get("/cards/{card_id}/related", response_model=list[RelationResult])
def related_cards(card_id: str) -> list[dict[str, Any]]:
    if not db.get_card(card_id):
        raise HTTPException(status_code=404, detail="Card not found")
    return [
        {
            "relation_type": row["relation_type"],
            "score": float(row["score"]),
            "status": row["status"],
            "reason": row.get("relation_reason", ""),
            "created_at": row.get("relation_created_at").isoformat() if row.get("relation_created_at") else None,
            "updated_at": row.get("relation_updated_at").isoformat() if row.get("relation_updated_at") else None,
            "card": compact_card(row),
        }
        for row in db.get_related_cards(card_id)
    ]


@app.post("/cards/{card_id}/relations/{target_id}/confirm")
def confirm_card_relation(card_id: str, target_id: str) -> dict[str, Any]:
    if card_id == target_id or not db.get_card(card_id) or not db.get_card(target_id):
        raise HTTPException(status_code=404, detail="Both cards must exist and be different")
    return db.confirm_relation(card_id, target_id)


@app.delete("/cards/{card_id}/relations/{target_id}", tags=["relations"])
def delete_card_relation(card_id: str, target_id: str) -> dict[str, Any]:
    if card_id == target_id or not db.get_card(card_id) or not db.get_card(target_id):
        raise HTTPException(status_code=404, detail="Both cards must exist and be different")
    if not db.delete_manual_relation(card_id, target_id):
        raise HTTPException(status_code=404, detail="找不到自製關聯")
    return {"status": "deleted", "source_id": min(card_id, target_id), "target_id": max(card_id, target_id), "relation_type": "manual"}


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
        "authentication": "Bearer API Token; optional read-only token is accepted for GET requests",
        "intended_use": "local or trusted-network integrations",
        "capabilities": [
            "models.read",
            "models.download",
            "models.select",
            "models.inspect",
            "models.remove",
            "tasks.read",
            "tasks.cancel",
            "tasks.retry",
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
            "cards.relations.delete",
            "categories.read",
            "categories.write",
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


@api_v1.get("/models/{model_id}/inspect", tags=["models"])
def inspect_model_v1(model_id: str) -> dict[str, Any]:
    return inspect_model(model_id)


@api_v1.delete("/models/{model_id}", tags=["models"])
def remove_model_v1(model_id: str) -> dict[str, Any]:
    return remove_model(model_id)


@api_v1.post("/models/select", tags=["models"])
async def select_model_v1(payload: ModelSelectInput) -> dict[str, Any]:
    return await select_model(payload)


@api_v1.post("/models/{model_id}", status_code=202, tags=["models"])
async def download_model_v1(model_id: str) -> dict[str, Any]:
    return await download_model(model_id)


@api_v1.get("/settings", tags=["settings"])
def runtime_settings_v1() -> dict[str, Any]:
    return runtime_settings()


@api_v1.get("/tasks", response_model=list[TaskResponse], tags=["tasks"])
def tasks_v1(limit: int = Query(default=20, ge=1, le=100)) -> list[dict[str, Any]]:
    return tasks(limit)


@api_v1.get("/tasks/{task_id}", response_model=TaskResponse, tags=["tasks"])
def task_v1(task_id: str) -> dict[str, Any]:
    return task(task_id)


@api_v1.post("/tasks/{task_id}/cancel", response_model=TaskResponse, tags=["tasks"])
async def cancel_task_v1(task_id: str) -> dict[str, Any]:
    return await cancel_task(task_id)


@api_v1.post("/tasks/{task_id}/retry", response_model=TaskResponse, tags=["tasks"])
async def retry_task_v1(task_id: str) -> dict[str, Any]:
    return await retry_task(task_id)


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


@api_v1.get("/categories", tags=["categories"])
def categories_v1() -> list[dict[str, Any]]:
    return categories()


@api_v1.post("/categories", tags=["categories"])
def create_category_v1(payload: CategoryInput) -> dict[str, Any]:
    return create_category(payload)


@api_v1.patch("/categories/{category_name}", tags=["categories"])
async def rename_category_v1(category_name: str, payload: CategoryInput) -> dict[str, Any]:
    return await rename_category(category_name, payload)


@api_v1.post("/categories/merge", tags=["categories"])
async def merge_categories_v1(payload: CategoryMergeInput) -> dict[str, Any]:
    return await merge_categories(payload)


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
    category: str | None = Query(default=None, max_length=120),
    tag: str | None = Query(default=None, max_length=120),
    sort: Literal["relevance", "updated", "title"] = "relevance",
) -> list[dict[str, Any]]:
    return await search(q=q, limit=limit, category=category, tag=tag, sort=sort)


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


@api_v1.delete("/cards/{card_id}/relations/{target_id}", tags=["relations"])
def delete_card_relation_v1(card_id: str, target_id: str) -> dict[str, Any]:
    return delete_card_relation(card_id, target_id)


app.include_router(api_v1)
