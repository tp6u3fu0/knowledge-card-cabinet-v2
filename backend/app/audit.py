"""Small append-only audit log for API operations."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def write_audit(path: str, *, method: str, route: str, status: int, actor: str, duration_ms: int) -> None:
    if not path:
        return
    record: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "method": method,
        "route": route,
        "status": status,
        "actor": actor,
        "duration_ms": duration_ms,
    }
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        # Auditing must never make the data API unavailable.
        return
