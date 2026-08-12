import hashlib
import math
import re
import asyncio
from typing import Sequence

import httpx

from .config import settings
from .model_state import (
    get_embedding_api_format,
    get_embedding_api_key,
    get_embedding_api_url,
    get_embedding_dimensions,
    get_embedding_model,
    get_embedding_provider,
)


TOKEN_PATTERN = re.compile(r"[a-z0-9_]+|[\u4e00-\u9fff]", re.IGNORECASE)
_local_model = None
_local_model_id = None
_local_model_lock = asyncio.Lock()


def build_embedding_text(card: dict) -> str:
    return "\n".join(
        [
            f"Title: {card['title']}",
            f"Question: {card['question']}",
            f"Summary: {card['summary']}",
            f"Analogy: {card['analogy']}",
            f"Detail: {card['detail']}",
            f"Topic: {card['topic']}",
            f"Tags: {', '.join(card.get('tags', []))}",
            f"Source: {card.get('source', '')}",
        ]
    )


def local_smoke_embedding(text: str, dimensions: int) -> list[float]:
    """Deterministic local fallback for API and relation smoke tests.

    This is lexical hashing, not a semantic model. Configure EMBEDDING_API_URL
    for real multilingual semantic retrieval.
    """
    tokens = TOKEN_PATTERN.findall(text.lower())
    tokens += [f"{tokens[i]}_{tokens[i + 1]}" for i in range(len(tokens) - 1)]
    vector = [0.0] * dimensions

    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        vector[bucket] += 1.0 if digest[4] & 1 else -1.0

    norm = sum(value * value for value in vector) ** 0.5
    if norm == 0:
        vector[0] = 1.0
        return vector
    return [value / norm for value in vector]


def query_embedding_text(text: str) -> str:
    return f"Instruct: {settings.embedding_query_instruction}\nQuery: {text}"


def normalize_embedding(values: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in values))
    if norm == 0:
        raise ValueError("Embedding vector has zero length")
    return [float(value) / norm for value in values]


async def preload_embedding_model(model_id: str | None = None) -> None:
    global _local_model, _local_model_id

    selected_model = model_id or get_embedding_model()
    if selected_model == "embedding-hash-384":
        return

    async with _local_model_lock:
        if _local_model is None or _local_model_id != selected_model:
            from sentence_transformers import SentenceTransformer

            _local_model = await asyncio.to_thread(
                SentenceTransformer,
                selected_model,
                device="cpu",
            )
            _local_model_id = selected_model


async def local_transformers_embedding(text: str) -> list[float]:
    await preload_embedding_model()

    selected_model = get_embedding_model()

    embedding = await asyncio.to_thread(
        _local_model.encode,
        [text],
        normalize_embeddings=True,
        truncate_dim=get_embedding_dimensions(),
    )
    return [float(value) for value in embedding[0]]


async def embed_text(text: str, *, is_query: bool = False) -> tuple[list[float], str]:
    input_text = query_embedding_text(text) if is_query else text

    dimensions = get_embedding_dimensions()

    if get_embedding_provider() == "local-hash" or get_embedding_model() == "embedding-hash-384":
        return local_smoke_embedding(input_text, dimensions), "embedding-hash-384"

    if get_embedding_provider() == "local-transformers":
        return await local_transformers_embedding(input_text), get_embedding_model()

    api_url = get_embedding_api_url()
    api_format = get_embedding_api_format()
    api_key = get_embedding_api_key()
    if not api_url:
        return local_smoke_embedding(input_text, dimensions), "local-hash-smoke"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=45) as client:
        if api_format == "tei":
            request_payload = {"inputs": [input_text]}
        elif api_format == "openai":
            request_payload = {"model": get_embedding_model(), "input": input_text}
        else:
            raise ValueError(
                "EMBEDDING_API_FORMAT must be either 'tei' or 'openai', "
                f"got {api_format!r}"
            )

        response = await client.post(api_url, headers=headers, json=request_payload)
        response.raise_for_status()
        payload = response.json()

    if api_format == "tei":
        embedding = payload[0]
    else:
        embedding = payload["data"][0]["embedding"]

    if len(embedding) > dimensions and api_format == "tei":
        # Qwen3-Embedding supports Matryoshka dimensions. Keep the existing
        # 384-dimensional pgvector schema for the MVP and renormalize after
        # truncating the model's default 1024-dimensional output.
        embedding = normalize_embedding(embedding[:dimensions])
    elif len(embedding) != dimensions:
        raise ValueError(
            "Embedding dimension mismatch: "
            f"received {len(embedding)}, expected {dimensions}"
        )
    else:
        embedding = [float(value) for value in embedding]

    return embedding, get_embedding_model()


def vector_literal(values: Sequence[float]) -> str:
    return "[" + ",".join(f"{float(value):.8f}" for value in values) + "]"
