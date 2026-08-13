"""Persistent task state for long-running local model operations."""

import asyncio
import copy
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TaskContext:
    def __init__(self, manager: "TaskManager", task_id: str) -> None:
        self._manager = manager
        self.task_id = task_id

    def update(self, progress: int, message: str = "") -> None:
        self._manager.update(self.task_id, progress=progress, message=message)


TaskWorker = Callable[[TaskContext], Awaitable[Any]]


class TaskManager:
    def __init__(self, storage_path: str | None = None) -> None:
        self._storage_path = Path(storage_path) if storage_path else None
        self._tasks: dict[str, dict[str, Any]] = {}
        self._running: dict[str, asyncio.Task[Any]] = {}
        self._load()

    def _load(self) -> None:
        if self._storage_path is None or not self._storage_path.exists():
            return
        try:
            payload = json.loads(self._storage_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(payload, list):
            return
        changed = False
        for item in payload:
            if not isinstance(item, dict) or not item.get("task_id"):
                continue
            state = dict(item)
            if state.get("status") in {"queued", "running"}:
                state.update(
                    {
                        "status": "failed",
                        "message": "服務重新啟動，未完成的任務需要重新執行",
                        "error": "服務在任務完成前重新啟動",
                        "finished_at": _now(),
                    }
                )
                changed = True
            self._tasks[str(state["task_id"])] = state
        if changed:
            self._persist()

    def _persist(self) -> None:
        if self._storage_path is None:
            return
        try:
            self._storage_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = self._storage_path.with_suffix(f"{self._storage_path.suffix}.tmp")
            temporary_path.write_text(
                json.dumps(list(self._tasks.values()), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(temporary_path, self._storage_path)
        except OSError:
            # Task state must never take down the API; the in-memory state remains valid.
            return

    @staticmethod
    def _public(state: dict[str, Any]) -> dict[str, Any]:
        result = copy.deepcopy(state)
        result.pop("retry_payload", None)
        result["can_retry"] = bool(
            result.get("status") in {"failed", "cancelled"}
            and state.get("retry_payload") is not None
        )
        return result

    def start(
        self,
        operation: str,
        label: str,
        worker: TaskWorker,
        *,
        retry_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        task_id = str(uuid4())
        self._tasks[task_id] = {
            "task_id": task_id,
            "operation": operation,
            "label": label,
            "status": "queued",
            "progress": 0,
            "message": "等待執行",
            "result": None,
            "error": "",
            "created_at": _now(),
            "started_at": None,
            "finished_at": None,
            "retry_payload": copy.deepcopy(retry_payload),
        }
        self._persist()
        task = asyncio.create_task(self._run(task_id, worker))
        self._running[task_id] = task
        return self.get(task_id)

    async def _run(self, task_id: str, worker: TaskWorker) -> None:
        self.update(task_id, status="running", progress=1, message="開始執行")
        try:
            result = await worker(TaskContext(self, task_id))
            self.update(task_id, status="succeeded", progress=100, message="完成", result=result, finished_at=_now())
        except asyncio.CancelledError:
            self.update(task_id, status="cancelled", message="已取消", finished_at=_now())
            raise
        except Exception as exc:
            self.update(task_id, status="failed", message="執行失敗", error=str(exc), finished_at=_now())
        finally:
            self._running.pop(task_id, None)

    def update(self, task_id: str, **changes: Any) -> None:
        if task_id not in self._tasks:
            return
        state = self._tasks[task_id]
        if changes.get("status") == "running" and state["started_at"] is None:
            changes["started_at"] = _now()
        if "progress" in changes:
            changes["progress"] = max(0, min(100, int(changes["progress"])))
        state.update(changes)
        self._persist()

    def get(self, task_id: str) -> dict[str, Any]:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        return self._public(self._tasks[task_id])

    def raw_get(self, task_id: str) -> dict[str, Any]:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        return copy.deepcopy(self._tasks[task_id])

    def list(self, limit: int = 20) -> list[dict[str, Any]]:
        states = sorted(self._tasks.values(), key=lambda state: state["created_at"], reverse=True)
        return [self._public(state) for state in states[:limit]]

    async def cancel(self, task_id: str) -> dict[str, Any]:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        state = self._tasks[task_id]
        if state["status"] in {"succeeded", "failed", "cancelled"}:
            return self.get(task_id)
        running = self._running.get(task_id)
        if running is not None:
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)
        else:
            self.update(task_id, status="cancelled", message="已取消", finished_at=_now())
        return self.get(task_id)

    def retry(self, task_id: str, worker: TaskWorker) -> dict[str, Any]:
        state = self.raw_get(task_id)
        if state["status"] not in {"failed", "cancelled"}:
            raise ValueError("只有失敗或已取消的任務可以重試")
        if state.get("retry_payload") is None:
            raise ValueError("這個任務沒有可用的重試資訊，請重新提交操作")
        return self.start(
            state["operation"],
            state["label"],
            worker,
            retry_payload=state.get("retry_payload"),
        )

    async def close(self) -> None:
        tasks = list(self._running.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._persist()
