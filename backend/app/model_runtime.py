"""Model catalog and runtime state for the Docker backend.

The desktop app and the Docker app expose the same model-management contract,
but each runtime keeps its own compatible model catalog.  Docker uses the
Python Hugging Face stack, so its downloadable entries are Python models
rather than the Transformers.js/ONNX entries used by the desktop build.
"""

import asyncio
import copy
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings
from .model_state import configure


BUILTIN_SUMMARY_MODEL = "summary-template"
BUILTIN_EMBEDDING_MODEL = "embedding-hash-384"
SETTINGS_VERSION = "1"

MODEL_CATALOG: list[dict[str, Any]] = [
    {
        "id": BUILTIN_SUMMARY_MODEL,
        "kind": "summary",
        "label": "規則整理",
        "short_label": "內建輕量",
        "provider": "local-template",
        "model_id": None,
        "task": "template",
        "size_label": "不需下載",
        "min_memory_gb": 0,
        "tier": "任何硬體",
        "languages": "中英文皆可，固定格式",
        "description": "不下載模型，使用本機規則快速填入卡片欄位。適合先開始使用。",
        "builtin": True,
    },
    {
        "id": "summary-qwen-0.5b",
        "kind": "summary",
        "label": "Qwen2.5 0.5B Instruct",
        "short_label": "本機語言模型",
        "provider": "local-transformers",
        "model_id": "Qwen/Qwen2.5-0.5B-Instruct",
        "task": "text-generation",
        "size_label": "約 1 GB",
        "download_size_bytes": 1_000_000_000,
        "min_memory_gb": 8,
        "tier": "平衡硬體",
        "languages": "中英文短摘要與欄位整理",
        "description": "體積較小的指令模型，適合在 Docker 後端進行摘要與知識卡欄位整理。",
        "builtin": False,
    },
    {
        "id": BUILTIN_EMBEDDING_MODEL,
        "kind": "embedding",
        "label": f"Hash fallback {settings.embedding_dimensions}",
        "short_label": "內建輕量",
        "provider": "local-hash",
        "model_id": None,
        "task": "hash",
        "dimensions": settings.embedding_dimensions,
        "size_label": "不需下載",
        "min_memory_gb": 0,
        "tier": "任何硬體",
        "languages": "依文字切詞，速度最快",
        "description": "非語意的 deterministic fallback 向量，零下載、零等待，適合低規格電腦或離線環境；正式關聯建議使用 Qwen。",
        "builtin": True,
    },
    {
        "id": "embedding-qwen-0.6b",
        "kind": "embedding",
        "label": "Qwen3 Embedding 0.6B",
        "short_label": "中英語意",
        "provider": "local-transformers",
        "model_id": "Qwen/Qwen3-Embedding-0.6B",
        "task": "feature-extraction",
        "dimensions": settings.embedding_dimensions,
        "size_label": "約 1.2 GB",
        "download_size_bytes": 1_200_000_000,
        "min_memory_gb": 8,
        "tier": "平衡硬體",
        "languages": "中文、英文與多語言語意關聯",
        "description": "Docker 版的預設多語言語意模型；使用目前設定的完整輸出維度，切換後會重新建立所有卡片的向量與關聯。",
        "builtin": False,
    },
    {
        "id": "embedding-bge-m3",
        "kind": "embedding",
        "label": "BGE-M3 多語言",
        "short_label": "多語言進階",
        "provider": "local-transformers",
        "model_id": "BAAI/bge-m3",
        "task": "feature-extraction",
        "dimensions": settings.embedding_dimensions,
        "size_label": "約 2.2 GB",
        "download_size_bytes": 2_200_000_000,
        "min_memory_gb": 10,
        "tier": "進階硬體",
        "languages": "中文、英文與多語言長文本",
        "description": "多語言檢索模型，支援較長文本；適合用來和 Qwen 0.6B 比較關聯品質。",
        "builtin": False,
    },
    {
        "id": "embedding-e5-large",
        "kind": "embedding",
        "label": "Multilingual E5 Large",
        "short_label": "多語言大型",
        "provider": "local-transformers",
        "model_id": "intfloat/multilingual-e5-large",
        "task": "feature-extraction",
        "dimensions": settings.embedding_dimensions,
        "size_label": "約 2.2 GB",
        "download_size_bytes": 2_200_000_000,
        "min_memory_gb": 12,
        "tier": "進階硬體",
        "languages": "多語言檢索，需使用 query／passage 格式",
        "description": "大型多語言句向量模型，適合用來比較跨語言與概念檢索效果。",
        "builtin": False,
    },
]


def _memory_gb() -> float:
    try:
        with open("/proc/meminfo", encoding="utf-8") as file:
            for line in file:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / 1024 / 1024
    except (OSError, ValueError):
        pass
    return 0.0


def hardware_profile() -> dict[str, Any]:
    memory_gb = _memory_gb()
    if memory_gb >= 16:
        return {
            "tier": "advanced",
            "label": "進階硬體",
            "memory_gb": round(memory_gb, 1),
            "cpu_cores": os.cpu_count() or 1,
            "recommended_summary": "summary-qwen-0.5b",
            "recommended_embedding": "embedding-qwen-0.6b",
            "note": "可以使用 Docker 版的本機摘要與多語言 embedding；首次下載與重建索引會需要較久時間。",
        }
    if memory_gb >= 8:
        return {
            "tier": "balanced",
            "label": "平衡硬體",
            "memory_gb": round(memory_gb, 1),
            "cpu_cores": os.cpu_count() or 1,
            "recommended_summary": "summary-qwen-0.5b",
            "recommended_embedding": "embedding-qwen-0.6b",
            "note": "建議使用 Qwen 輕量模型，兼顧中文關聯與本機負載。",
        }
    return {
        "tier": "light",
        "label": "輕量硬體",
        "memory_gb": round(memory_gb, 1),
        "cpu_cores": os.cpu_count() or 1,
        "recommended_summary": BUILTIN_SUMMARY_MODEL,
        "recommended_embedding": BUILTIN_EMBEDDING_MODEL,
        "note": "建議先使用內建模式；若要下載模型，請先關閉其他大型應用程式。",
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _find_model(model_id: str) -> dict[str, Any] | None:
    return next((model for model in MODEL_CATALOG if model["id"] == model_id), None)


def _configured_model_id(kind: str) -> str:
    if kind == "summary":
        if settings.summary_provider == "local-template":
            return BUILTIN_SUMMARY_MODEL
        if settings.summary_model == "Qwen/Qwen2.5-0.5B-Instruct":
            return "summary-qwen-0.5b"
        return BUILTIN_SUMMARY_MODEL
    if settings.embedding_provider == "local-hash" or settings.embedding_model == BUILTIN_EMBEDDING_MODEL:
        return BUILTIN_EMBEDDING_MODEL
    for model in MODEL_CATALOG:
        if model["kind"] == "embedding" and model.get("model_id") == settings.embedding_model:
            return str(model["id"])
    return BUILTIN_EMBEDDING_MODEL


class ModelRuntime:
    def __init__(self, models_dir: str | None = None) -> None:
        self.hardware = hardware_profile()
        self.models_dir = Path(models_dir or os.getenv("HF_HOME", "/root/.cache/huggingface"))
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self._operation_states: dict[str, dict[str, str]] = {}
        self._errors: dict[str, str] = {}
        self._installed: dict[str, str] = {}
        self._download_tasks: dict[str, asyncio.Task[Any]] = {}
        self._lock = asyncio.Lock()
        self._active = {
            "summary": _configured_model_id("summary"),
            "embedding": _configured_model_id("embedding"),
        }
        self._sources = {
            "summary": "api" if settings.summary_provider == "api-openai" and settings.summary_api_url else "local",
            "embedding": "api" if settings.embedding_provider in {"api-openai", "api-tei"} and settings.embedding_api_url else "local",
        }
        self._custom = {
            "summary": {
                "api_url": settings.summary_api_url,
                "api_format": "openai",
                "model": settings.summary_model if self._sources["summary"] == "api" else "",
                "api_key": settings.summary_api_key,
            },
            "embedding": {
                "api_url": settings.embedding_api_url,
                "api_format": settings.embedding_api_format,
                "model": settings.embedding_model if self._sources["embedding"] == "api" else "",
                "api_key": settings.embedding_api_key,
            },
        }
        self._load_persisted_state()
        self._apply_active("summary")
        self._apply_active("embedding")

    def _load_persisted_state(self) -> None:
        from . import db

        persisted = db.get_runtime_settings()
        self._active["summary"] = persisted.get("model.summary_model_id", self._active["summary"])
        self._active["embedding"] = persisted.get("model.embedding_model_id", self._active["embedding"])
        self._installed = {
            key.removeprefix("model.installed."): value
            for key, value in persisted.items()
            if key.startswith("model.installed.")
        }
        for kind in ("summary", "embedding"):
            source = persisted.get(f"model.{kind}_source")
            if source in {"local", "api"}:
                self._sources[kind] = source
            for key in ("api_url", "api_format", "model", "api_key"):
                persisted_key = f"custom.{kind}.{key}"
                if persisted_key in persisted:
                    self._custom[kind][key] = persisted[persisted_key]
        for kind, fallback in (("summary", BUILTIN_SUMMARY_MODEL), ("embedding", BUILTIN_EMBEDDING_MODEL)):
            model = _find_model(self._active[kind])
            if not model or model["kind"] != kind:
                self._active[kind] = fallback

    def _apply_active(self, kind: str) -> None:
        if self._sources[kind] == "api":
            custom = self._custom[kind]
            if kind == "summary":
                configure(
                    summary_provider="api-openai",
                    summary_model=custom["model"],
                    summary_api_url=custom["api_url"],
                    summary_api_key=custom["api_key"],
                )
            else:
                configure(
                    embedding_provider="api-tei" if custom["api_format"] == "tei" else "api-openai",
                    embedding_model=custom["model"],
                    embedding_api_url=custom["api_url"],
                    embedding_api_format=custom["api_format"],
                    embedding_api_key=custom["api_key"],
                    embedding_dimensions=settings.embedding_dimensions,
                )
            return
        model = _find_model(self._active[kind])
        if not model:
            return
        if kind == "summary":
            configure(
                summary_provider=model["provider"],
                summary_model=model["model_id"] or BUILTIN_SUMMARY_MODEL,
                summary_api_url="",
                summary_api_key="",
            )
        else:
            configure(
                embedding_provider=model["provider"],
                embedding_model=model["model_id"] or BUILTIN_EMBEDDING_MODEL,
                embedding_api_url="",
                embedding_api_format="openai",
                embedding_api_key="",
                embedding_dimensions=settings.embedding_dimensions,
            )

    def _persist(self) -> None:
        from . import db

        values = {
            "model.summary_model_id": self._active["summary"],
            "model.embedding_model_id": self._active["embedding"],
            "model.runtime_version": SETTINGS_VERSION,
        }
        values.update({f"model.{kind}_source": self._sources[kind] for kind in ("summary", "embedding")})
        values.update(
            {
                f"custom.{kind}.{key}": str(value)
                for kind, custom in self._custom.items()
                for key, value in custom.items()
            }
        )
        values.update({f"model.installed.{key}": value for key, value in self._installed.items()})
        db.save_runtime_settings(values)

    def _is_installed(self, model: dict[str, Any]) -> bool:
        return bool(model["builtin"] or model["id"] in self._installed)

    @staticmethod
    def _human_size(value: int) -> str:
        if value < 1024 * 1024:
            return f"{value / 1024:.0f} KB"
        if value < 1024 * 1024 * 1024:
            return f"{value / 1024 / 1024:.0f} MB"
        return f"{value / 1024 / 1024 / 1024:.1f} GB"

    def _model_cache_dir(self, model: dict[str, Any]) -> Path:
        model_id = str(model.get("model_id") or "")
        return self.models_dir / "hub" / f"models--{model_id.replace('/', '--')}"

    def inspect(self, model_id: str) -> dict[str, Any]:
        model = _find_model(model_id)
        if not model:
            raise ValueError("找不到指定模型")
        if model["builtin"]:
            return {
                "model_id": model_id,
                "status": "ready",
                "installed": True,
                "files": 0,
                "bytes": 0,
                "size_label": "不需下載",
                "download_size_bytes": 0,
                "resumable": False,
            }
        cache_dir = self._model_cache_dir(model)
        total_bytes = 0
        file_count = 0
        if cache_dir.exists():
            for path in cache_dir.rglob("*"):
                if path.is_file():
                    file_count += 1
                    try:
                        total_bytes += path.stat().st_size
                    except OSError:
                        pass
        installed = self._is_installed(model)
        status = "ready" if installed and file_count > 0 else "partial" if file_count > 0 else "missing"
        return {
            "model_id": model_id,
            "status": status,
            "installed": installed and status == "ready",
            "files": file_count,
            "bytes": total_bytes,
            "size_label": self._human_size(total_bytes) if total_bytes else "尚未建立快取",
            "download_size_bytes": int(model.get("download_size_bytes", 0)),
            "resumable": True,
        }

    def storage(self) -> dict[str, Any]:
        try:
            usage = shutil.disk_usage(self.models_dir)
            return {
                "path_label": "模型快取所在磁碟",
                "free_bytes": usage.free,
                "free_size_label": self._human_size(usage.free),
                "total_bytes": usage.total,
                "total_size_label": self._human_size(usage.total),
            }
        except OSError:
            return {
                "path_label": "模型快取所在磁碟",
                "free_bytes": 0,
                "free_size_label": "無法讀取",
                "total_bytes": 0,
                "total_size_label": "無法讀取",
            }

    @staticmethod
    def _error_hint(error: str) -> tuple[str, str]:
        lowered = error.lower()
        if "no space" in lowered or "enospc" in lowered:
            return "DISK_FULL", "請清理模型檔案或釋放磁碟空間後重試。"
        if "timeout" in lowered or "connection" in lowered or "network" in lowered:
            return "NETWORK", "下載中斷時會保留既有快取；確認網路後可直接重試。"
        if "onnx" in lowered or "runtime" in lowered:
            return "RUNTIME", "模型檔案可能與目前 runtime 不相容，請先檢查檔案或清理後重試。"
        return "MODEL_LOAD", "請檢查模型檔案；若仍失敗，可清理後重新下載。"

    def _describe(self, model: dict[str, Any]) -> dict[str, Any]:
        operation = self._operation_states.get(model["id"])
        error = self._errors.get(model["id"], "")
        error_code, error_hint = self._error_hint(error) if error else ("", "")
        return {
            **model,
            "active": self._active[model["kind"]] == model["id"],
            "installed": self._is_installed(model),
            "recommended": model["id"] in {
                self.hardware["recommended_summary"],
                self.hardware["recommended_embedding"],
            },
            "status": operation["status"] if operation else ("ready" if self._is_installed(model) else "available"),
            "error": error,
            "error_code": error_code,
            "error_hint": error_hint,
            "storage": self.inspect(model["id"]),
        }

    def catalog(self) -> dict[str, Any]:
        return {
            "hardware": self.hardware,
            "active": dict(self._active),
            "active_source": dict(self._sources),
            "storage": self.storage(),
            "models": [self._describe(model) for model in MODEL_CATALOG],
        }

    def remove(self, model_id: str) -> dict[str, Any]:
        model = _find_model(model_id)
        if not model:
            raise ValueError("找不到指定模型")
        if model["builtin"]:
            raise ValueError("內建模型沒有可清理的檔案")
        if self._active[model["kind"]] == model_id and self._sources[model["kind"]] == "local":
            raise ValueError("目前使用中的模型不能清理，請先切換到其他模型")
        if model_id in self._download_tasks:
            raise ValueError("模型仍在下載中，請先取消下載任務")
        cache_dir = self._model_cache_dir(model)
        if cache_dir.exists():
            shutil.rmtree(cache_dir)
        self._installed.pop(model_id, None)
        self._errors.pop(model_id, None)
        self._operation_states.pop(model_id, None)
        self._persist()
        return self.inspect(model_id)

    async def download(self, model_id: str) -> dict[str, Any]:
        model = _find_model(model_id)
        if not model:
            raise ValueError("找不到指定模型")
        if model["builtin"]:
            return self._describe(model)
        if model_id in self._download_tasks:
            await self._download_tasks[model_id]
            return self._describe(model)

        self._operation_states[model_id] = {"status": "downloading", "updated_at": _now()}
        self._errors.pop(model_id, None)

        async def run() -> None:
            try:
                if model["kind"] == "embedding":
                    from .embeddings import preload_embedding_model

                    await preload_embedding_model(model["model_id"])
                else:
                    from .summarization import preload_summary_model

                    await preload_summary_model(model["model_id"])
                self._installed[model_id] = _now()
                self._persist()
                self._operation_states[model_id] = {"status": "ready", "updated_at": _now()}
            except Exception as exc:
                self._operation_states.pop(model_id, None)
                self._errors[model_id] = str(exc)
                raise
            finally:
                self._download_tasks.pop(model_id, None)

        task = asyncio.create_task(run())
        self._download_tasks[model_id] = task
        await task
        return self._describe(model)

    async def select(self, kind: str, model_id: str, *, allow_uninstalled: bool = False) -> dict[str, Any]:
        if kind not in {"summary", "embedding"}:
            raise ValueError("模型類型必須是 summary 或 embedding")
        model = _find_model(model_id)
        if not model or model["kind"] != kind:
            raise ValueError("找不到符合類型的模型")
        if not allow_uninstalled and not self._is_installed(model):
            error = ValueError("請先下載模型，再啟用它")
            error.code = "MODEL_NOT_INSTALLED"
            raise error
        previous = self._active[kind]
        previous_source = self._sources[kind]
        self._active[kind] = model_id
        self._sources[kind] = "local"
        self._apply_active(kind)
        self._persist()
        return {
            "previous": previous,
            "current": model_id,
            "previous_source": previous_source,
            "current_source": "local",
            "changed": previous != model_id or previous_source != "local",
            "model": self._describe(model),
        }

    @staticmethod
    def _validate_custom(kind: str, payload: dict[str, Any]) -> dict[str, str]:
        source = str(payload.get("source", "local")).strip().lower()
        if source not in {"local", "api"}:
            raise ValueError(f"{kind} source 必須是 local 或 api")
        api_url = str(payload.get("api_url", "")).strip()
        api_format = str(payload.get("api_format", "openai")).strip().lower()
        model = str(payload.get("model", "")).strip()
        if source == "api":
            if not api_url.startswith(("http://", "https://")):
                raise ValueError(f"{kind} API 位址必須使用 http:// 或 https://")
            if not model:
                raise ValueError(f"{kind} API 必須填寫模型名稱")
            if kind == "summary" and api_format != "openai":
                raise ValueError("摘要 API 目前只支援 OpenAI-compatible 格式")
            if kind == "embedding" and api_format not in {"openai", "tei"}:
                raise ValueError("embedding API 格式必須是 openai 或 tei")
        return {
            "source": source,
            "api_url": api_url,
            "api_format": api_format,
            "model": model,
        }

    def settings(self) -> dict[str, Any]:
        result: dict[str, Any] = {"summary": {}, "embedding": {}}
        for kind in ("summary", "embedding"):
            custom = self._custom[kind]
            result[kind] = {
                "source": self._sources[kind],
                "provider": (
                    "api-openai" if kind == "summary" else ("api-tei" if custom["api_format"] == "tei" else "api-openai")
                ) if self._sources[kind] == "api" else "local",
                "api_url": custom["api_url"],
                "api_format": custom["api_format"],
                "model": custom["model"],
                "api_key_set": bool(custom["api_key"]),
            }
        result["embedding"]["dimensions"] = settings.embedding_dimensions
        return result

    def settings_state(self) -> dict[str, Any]:
        return {"sources": copy.deepcopy(self._sources), "custom": copy.deepcopy(self._custom)}

    def restore_settings_state(self, state: dict[str, Any]) -> None:
        self._sources = copy.deepcopy(state["sources"])
        self._custom = copy.deepcopy(state["custom"])
        self._apply_active("summary")
        self._apply_active("embedding")
        self._persist()

    def update_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        previous = self.settings_state()
        updated: dict[str, dict[str, str]] = {}
        for kind in ("summary", "embedding"):
            incoming = payload.get(kind) or {}
            validated = self._validate_custom(kind, incoming)
            current = self._custom[kind]
            api_key = str(incoming.get("api_key", "")).strip()
            if bool(incoming.get("clear_api_key", False)):
                api_key = ""
            elif not api_key:
                api_key = current["api_key"]
            updated[kind] = {
                "api_url": validated["api_url"],
                "api_format": validated["api_format"],
                "model": validated["model"],
                "api_key": api_key,
            }

        self._sources = {kind: str((payload.get(kind) or {}).get("source", "local")) for kind in ("summary", "embedding")}
        self._custom = updated
        previous_embedding = {
            key: value for key, value in previous["custom"]["embedding"].items() if key != "api_key"
        }
        next_embedding = {
            key: value for key, value in self._custom["embedding"].items() if key != "api_key"
        }
        embedding_changed = (
            previous["sources"]["embedding"] != self._sources["embedding"]
            or previous_embedding != next_embedding
        )
        self._apply_active("summary")
        self._apply_active("embedding")
        self._persist()
        return {"embedding_changed": embedding_changed, "settings": self.settings()}

    def health(self) -> dict[str, Any]:
        summary = _find_model(self._active["summary"])
        embedding = _find_model(self._active["embedding"])
        summary_custom = self._custom["summary"]
        embedding_custom = self._custom["embedding"]
        if self._sources["embedding"] == "api":
            embedding_model = embedding_custom["model"]
            embedding_provider = "api-tei" if embedding_custom["api_format"] == "tei" else "api-openai"
            semantic_mode = True
        else:
            embedding_model = embedding["id"] if embedding else self._active["embedding"]
            embedding_provider = embedding["provider"] if embedding else "unknown"
            semantic_mode = bool(embedding and not embedding["builtin"])
        if self._sources["summary"] == "api":
            summary_provider = "api-openai"
            summary_model = summary_custom["model"]
            summary_status = "ready"
        else:
            summary_provider = summary["provider"] if summary else "unknown"
            summary_model = summary["id"] if summary else self._active["summary"]
            summary_status = self._describe(summary)["status"] if summary else "available"
        return {
            "embedding_model": embedding_model,
            "embedding_provider": embedding_provider,
            "embedding_dimensions": settings.embedding_dimensions,
            "semantic_mode": semantic_mode,
            "summary_provider": summary_provider,
            "summary_model": summary_model,
            "summary_status": summary_status,
            "model_error": self._errors.get(self._active["summary"], "") or self._errors.get(self._active["embedding"], ""),
        }


def create_model_runtime(models_dir: str | None = None) -> ModelRuntime:
    return ModelRuntime(models_dir)
