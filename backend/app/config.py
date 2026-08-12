from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql://knowledge:knowledge@localhost:5433/knowledge",
    )
    embedding_provider: str = os.getenv("EMBEDDING_PROVIDER", "local-transformers").strip().lower()
    embedding_api_url: str = os.getenv("EMBEDDING_API_URL", "").strip()
    embedding_api_format: str = os.getenv("EMBEDDING_API_FORMAT", "openai").strip().lower()
    embedding_api_key: str = os.getenv("EMBEDDING_API_KEY", "").strip()
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
    embedding_dimensions: int = int(os.getenv("EMBEDDING_DIMENSIONS", "384"))
    related_min_score: float = float(os.getenv("RELATED_MIN_SCORE", "0.55"))
    summary_provider: str = os.getenv("SUMMARY_PROVIDER", "local-transformers").strip().lower()
    summary_api_url: str = os.getenv("SUMMARY_API_URL", "").strip()
    summary_api_format: str = os.getenv("SUMMARY_API_FORMAT", "openai").strip().lower()
    summary_api_key: str = os.getenv("SUMMARY_API_KEY", "").strip()
    summary_model: str = os.getenv("SUMMARY_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
    summary_max_new_tokens: int = int(os.getenv("SUMMARY_MAX_NEW_TOKENS", "192"))
    embedding_query_instruction: str = os.getenv(
        "EMBEDDING_QUERY_INSTRUCTION",
        "Given a user question, retrieve relevant knowledge cards that answer the question",
    ).strip()


settings = Settings()

if not 8 <= settings.embedding_dimensions <= 8192:
    raise ValueError("EMBEDDING_DIMENSIONS must be between 8 and 8192")
