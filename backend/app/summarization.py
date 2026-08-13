import asyncio
import json
import re
from typing import Any

import httpx

from .config import settings
from .model_state import (
    get_summary_api_key,
    get_summary_api_url,
    get_summary_model,
    get_summary_provider,
)


_local_model = None
_local_tokenizer = None
_local_model_id = None
_local_model_lock = asyncio.Lock()


def _load_local_model(model_id: str | None = None) -> tuple[Any, Any]:
    global _local_model, _local_tokenizer, _local_model_id

    selected_model = model_id or get_summary_model()

    if (
        _local_model is None
        or _local_tokenizer is None
        or _local_model_id != selected_model
    ):
        from transformers import AutoModelForCausalLM, AutoTokenizer

        _local_tokenizer = AutoTokenizer.from_pretrained(selected_model)
        _local_model = AutoModelForCausalLM.from_pretrained(
            selected_model,
            torch_dtype="auto",
        )
        _local_model.eval()
        _local_model_id = selected_model

    return _local_tokenizer, _local_model


async def preload_summary_model(model_id: str | None = None) -> None:
    """Download and initialize the selected Python summary model."""
    selected_model = model_id or get_summary_model()
    if selected_model == "summary-template":
        return
    async with _local_model_lock:
        await asyncio.to_thread(_load_local_model, selected_model)


def _build_prompt(content: str, source: str) -> list[dict[str, str]]:
    source_hint = f"\n來源：{source}" if source.strip() else ""
    return [
        {
            "role": "system",
            "content": (
                "你是知識卡編輯助手。請只根據使用者提供的內容整理，不要捏造內容或來源。"
                "請直接輸出一個 JSON 物件，不要 Markdown、不要說明文字。"
                "JSON 必須包含 category、topic、title、question、summary、analogy、detail、tags。"
                "所有欄位都必須是字串，只有 tags 是字串陣列。"
                "category、topic、title、question、summary 必須填寫；summary 只寫一句話；"
                "analogy 只寫一句話，detail 最多兩句話，tags 只要 1 到 3 個短字串。"
            ),
        },
        {
            "role": "user",
            "content": f"請把以下筆記整理成一張繁體中文知識卡。{source_hint}\n\n{content}",
        },
    ]


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0:
        raise ValueError("本機模型沒有回傳可解析的 JSON")

    try:
        if end <= start:
            raise json.JSONDecodeError("incomplete object", cleaned, start)
        payload = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        # Tiny local models sometimes stop before closing a long JSON object.
        # Recover the required string fields so the user can still review them.
        payload = {}
        for field in ("category", "topic", "title", "question", "summary", "analogy", "detail"):
            match = re.search(
                rf'"{field}"\s*:\s*"((?:\\.|[^"\\])*)"',
                cleaned,
                flags=re.DOTALL,
            )
            if match:
                payload[field] = json.loads(f'"{match.group(1)}"')

        tags_match = re.search(r'"tags"\s*:\s*\[(.*?)\]', cleaned, flags=re.DOTALL)
        if tags_match:
            payload["tags"] = re.findall(r'"((?:\\.|[^"\\])*)"', tags_match.group(1))

        if not payload.get("title") or not payload.get("summary"):
            raise ValueError("本機模型沒有回傳可解析的 JSON")
    if not isinstance(payload, dict):
        raise ValueError("本機模型回傳的格式不是 JSON 物件")
    return payload


def _normalize_draft(payload: dict[str, Any]) -> dict[str, Any]:
    text_fields = ("category", "topic", "title", "question", "summary", "analogy", "detail")
    draft = {}
    for field in text_fields:
        value = payload.get(field, "")
        if isinstance(value, list):
            value = value[0] if value else ""
        draft[field] = str(value).strip()
    if not draft["category"]:
        draft["category"] = draft["topic"] or "待分類"
    tags = payload.get("tags", [])
    if isinstance(tags, str):
        tags = [tag.strip() for tag in tags.split(",")]
    if not isinstance(tags, list):
        tags = []
    draft["tags"] = [str(tag).strip() for tag in tags if str(tag).strip()][:5]

    if not draft["title"] or not draft["summary"]:
        raise ValueError("本機模型回傳的卡片內容不完整")
    return draft


def _generate_local_draft(content: str, source: str) -> dict[str, Any]:
    import torch

    tokenizer, model = _load_local_model()
    messages = _build_prompt(content, source)
    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = tokenizer(prompt, return_tensors="pt")

    with torch.inference_mode():
        output = model.generate(
            **inputs,
            do_sample=False,
            max_new_tokens=settings.summary_max_new_tokens,
            pad_token_id=tokenizer.eos_token_id,
        )

    generated_tokens = output[0][inputs["input_ids"].shape[1] :]
    generated_text = tokenizer.decode(generated_tokens, skip_special_tokens=True)
    return _normalize_draft(_extract_json(generated_text))


def _template_draft(content: str, source: str) -> dict[str, Any]:
    """Small deterministic fallback that works without downloading a model."""
    cleaned = " ".join(content.split())
    title = cleaned[:48].rstrip("，。；：") or "未命名知識"
    sentences = [part.strip() for part in re.split(r"[。！？!?]", cleaned) if part.strip()]
    summary = sentences[0][:120] if sentences else title
    keywords = re.findall(r"[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9_-]{1,20}", cleaned)
    tags = list(dict.fromkeys(keywords))[:3]
    return {
        "category": "待分類",
        "topic": tags[0] if tags else "待分類",
        "title": title,
        "question": f"如何理解「{title}」？",
        "summary": summary,
        "analogy": "先抓住核心概念，再用例子驗證它的運作方式。",
        "detail": cleaned[:240],
        "tags": tags,
        "source": source.strip(),
    }


def _message_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return str(value or "")


async def _generate_api_draft(content: str, source: str) -> dict[str, Any]:
    api_url = get_summary_api_url()
    if not api_url:
        raise ValueError("尚未設定摘要 API 位址")

    headers = {"Content-Type": "application/json"}
    if get_summary_api_key():
        headers["Authorization"] = f"Bearer {get_summary_api_key()}"
    base_payload = {
        "model": get_summary_model(),
        "messages": _build_prompt(content, source),
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(api_url, headers=headers, json=base_payload)
        # Some OpenAI-compatible providers do not implement response_format.
        if response.status_code == 400:
            fallback_payload = {key: value for key, value in base_payload.items() if key != "response_format"}
            response = await client.post(api_url, headers=headers, json=fallback_payload)
        response.raise_for_status()
        payload = response.json()

    try:
        message = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("摘要 API 回傳格式不是 OpenAI Chat Completions 格式") from exc
    return _normalize_draft(_extract_json(_message_content(message)))


async def generate_card_draft(content: str, source: str = "") -> tuple[dict[str, Any], str]:
    if get_summary_provider() == "local-template" or get_summary_model() == "summary-template":
        return _template_draft(content, source), "summary-template"

    if get_summary_provider() != "local-transformers":
        if get_summary_provider() == "api-openai":
            return await _generate_api_draft(content, source), get_summary_model()
        raise ValueError(
            "目前只支援 local-template、local-transformers 或 api-openai，"
            f"收到 {get_summary_provider()!r}"
        )

    async with _local_model_lock:
        draft = await asyncio.to_thread(_generate_local_draft, content, source)
    return draft, get_summary_model()
