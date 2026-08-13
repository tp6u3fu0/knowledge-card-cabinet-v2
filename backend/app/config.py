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
    embedding_dimensions: int = int(os.getenv("EMBEDDING_DIMENSIONS", "1024"))
    related_min_score: float = float(os.getenv("RELATED_MIN_SCORE", "0.62"))
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
    task_state_file: str = os.getenv("TASK_STATE_FILE", "/app/data/tasks.json").strip()
    model_cache_dir: str = os.getenv("MODEL_CACHE_DIR", "/root/.cache/huggingface").strip()
    api_token: str = os.getenv("KCC_API_TOKEN", "").strip()
    api_read_token: str = os.getenv("KCC_API_READ_TOKEN", "").strip()
    cors_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv(
            "KCC_CORS_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000",
        ).split(",")
        if origin.strip()
    )
    backup_dir: str = os.getenv("BACKUP_DIR", "/app/data/backups").strip()
    audit_log_file: str = os.getenv("AUDIT_LOG_FILE", "/app/data/audit.jsonl").strip()
    relation_limit: int = int(os.getenv("RELATED_LIMIT", "6"))
    relation_keyword_weight: float = float(os.getenv("RELATED_KEYWORD_WEIGHT", "0.35"))
    keyword_weight: float = float(os.getenv("SEARCH_KEYWORD_WEIGHT", "0.25"))


settings = Settings()

if not 8 <= settings.embedding_dimensions <= 8192:
    raise ValueError("EMBEDDING_DIMENSIONS must be between 8 and 8192")
if not 1 <= settings.relation_limit <= 50:
    raise ValueError("RELATED_LIMIT must be between 1 and 50")
if not 0 <= settings.relation_keyword_weight <= 1:
    raise ValueError("RELATED_KEYWORD_WEIGHT must be between 0 and 1")
if not 0 <= settings.keyword_weight <= 1:
    raise ValueError("SEARCH_KEYWORD_WEIGHT must be between 0 and 1")
