"""Mutable model choices shared by the FastAPI runtime modules.

The environment still provides the initial defaults, while the model settings
API can change the active models without restarting the container.
"""

from .config import settings


_state = {
    "embedding_provider": settings.embedding_provider,
    "embedding_model": settings.embedding_model,
    "embedding_api_url": settings.embedding_api_url,
    "embedding_api_format": settings.embedding_api_format,
    "embedding_api_key": settings.embedding_api_key,
    "embedding_dimensions": settings.embedding_dimensions,
    "summary_provider": settings.summary_provider,
    "summary_model": settings.summary_model,
    "summary_api_url": settings.summary_api_url,
    "summary_api_key": settings.summary_api_key,
}


def configure(
    *,
    embedding_provider: str | None = None,
    embedding_model: str | None = None,
    embedding_api_url: str | None = None,
    embedding_api_format: str | None = None,
    embedding_api_key: str | None = None,
    embedding_dimensions: int | None = None,
    summary_provider: str | None = None,
    summary_model: str | None = None,
    summary_api_url: str | None = None,
    summary_api_key: str | None = None,
) -> None:
    if embedding_provider is not None:
        _state["embedding_provider"] = embedding_provider
    if embedding_model is not None:
        _state["embedding_model"] = embedding_model
    if embedding_api_url is not None:
        _state["embedding_api_url"] = embedding_api_url
    if embedding_api_format is not None:
        _state["embedding_api_format"] = embedding_api_format
    if embedding_api_key is not None:
        _state["embedding_api_key"] = embedding_api_key
    if embedding_dimensions is not None:
        _state["embedding_dimensions"] = embedding_dimensions
    if summary_provider is not None:
        _state["summary_provider"] = summary_provider
    if summary_model is not None:
        _state["summary_model"] = summary_model
    if summary_api_url is not None:
        _state["summary_api_url"] = summary_api_url
    if summary_api_key is not None:
        _state["summary_api_key"] = summary_api_key


def get_embedding_provider() -> str:
    return str(_state["embedding_provider"])


def get_embedding_model() -> str:
    return str(_state["embedding_model"])


def get_embedding_api_url() -> str:
    return str(_state["embedding_api_url"])


def get_embedding_api_format() -> str:
    return str(_state["embedding_api_format"])


def get_embedding_api_key() -> str:
    return str(_state["embedding_api_key"])


def get_embedding_dimensions() -> int:
    return int(_state["embedding_dimensions"])


def get_summary_provider() -> str:
    return str(_state["summary_provider"])


def get_summary_model() -> str:
    return str(_state["summary_model"])


def get_summary_api_url() -> str:
    return str(_state["summary_api_url"])


def get_summary_api_key() -> str:
    return str(_state["summary_api_key"])


def snapshot() -> dict[str, str | int]:
    return {key: value for key, value in _state.items()}
