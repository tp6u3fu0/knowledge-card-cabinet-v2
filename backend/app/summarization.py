import asyncio
import json
import re
from typing import Any

from .config import settings


_local_model = None
_local_tokenizer = None
_local_model_lock = asyncio.Lock()


def _load_local_model() -> tuple[Any, Any]:
    global _local_model, _local_tokenizer

    if _local_model is None or _local_tokenizer is None:
        from transformers import AutoModelForCausalLM, AutoTokenizer

        _local_tokenizer = AutoTokenizer.from_pretrained(settings.summary_model)
        _local_model = AutoModelForCausalLM.from_pretrained(
            settings.summary_model,
            torch_dtype="auto",
        )
        _local_model.eval()

    return _local_tokenizer, _local_model


def _build_prompt(content: str, source: str) -> list[dict[str, str]]:
    source_hint = f"\n來源：{source}" if source.strip() else ""
    return [
        {
            "role": "system",
            "content": (
                "你是知識卡編輯助手。請只根據使用者提供的內容整理，不要捏造內容或來源。"
                "請直接輸出一個 JSON 物件，不要 Markdown、不要說明文字。"
                "JSON 必須包含 topic、title、question、summary、analogy、detail、tags。"
                "所有欄位都必須是字串，只有 tags 是字串陣列。"
                "topic、title、question、summary 必須填寫；summary 只寫一句話；"
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
        for field in ("topic", "title", "question", "summary", "analogy", "detail"):
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
    text_fields = ("topic", "title", "question", "summary", "analogy", "detail")
    draft = {}
    for field in text_fields:
        value = payload.get(field, "")
        if isinstance(value, list):
            value = value[0] if value else ""
        draft[field] = str(value).strip()
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


async def generate_card_draft(content: str, source: str = "") -> tuple[dict[str, Any], str]:
    if settings.summary_provider != "local-transformers":
        raise ValueError(
            "目前只支援 SUMMARY_PROVIDER=local-transformers，"
            f"收到 {settings.summary_provider!r}"
        )

    async with _local_model_lock:
        draft = await asyncio.to_thread(_generate_local_draft, content, source)
    return draft, settings.summary_model
