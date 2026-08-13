const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function now() {
  return new Date().toISOString();
}

function createTaskManager({ storagePath = "" } = {}) {
  const tasks = new Map();
  const running = new Map();

  function persist() {
    if (!storagePath) return;
    try {
      fs.mkdirSync(path.dirname(storagePath), { recursive: true });
      const temporaryPath = `${storagePath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify([...tasks.values()], null, 2), "utf8");
      fs.renameSync(temporaryPath, storagePath);
    } catch {
      // Task state is best-effort; an unavailable state file must not stop the API.
    }
  }

  try {
    const saved = storagePath ? JSON.parse(fs.readFileSync(storagePath, "utf8")) : [];
    if (Array.isArray(saved)) {
      for (const item of saved) {
        if (!item || !item.task_id) continue;
        const task = { ...item };
        if (task.status === "queued" || task.status === "running") {
          Object.assign(task, {
            status: "failed",
            message: "服務重新啟動，未完成的任務需要重新執行",
            error: "服務在任務完成前重新啟動",
            finished_at: now(),
          });
        }
        tasks.set(task.task_id, task);
      }
      persist();
    }
  } catch {
    // Start with an empty task history when the state file is missing or invalid.
  }

  function publicTask(task) {
    const result = JSON.parse(JSON.stringify(task));
    delete result.retry_payload;
    result.can_retry = ["failed", "cancelled"].includes(task.status) && task.retry_payload !== null && task.retry_payload !== undefined;
    return result;
  }

  function get(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new Error("找不到指定背景任務");
    return publicTask(task);
  }

  function rawGet(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new Error("找不到指定背景任務");
    return JSON.parse(JSON.stringify(task));
  }

  function update(taskId, changes) {
    const task = tasks.get(taskId);
    if (!task) return;
    if (changes.status === "running" && !task.started_at) changes.started_at = now();
    if (changes.progress !== undefined) changes.progress = Math.max(0, Math.min(100, Number(changes.progress) || 0));
    Object.assign(task, changes);
    persist();
  }

  async function run(taskId, worker) {
    update(taskId, { status: "running", progress: 1, message: "開始執行" });
    const context = { task_id: taskId, update: (progress, message = "") => update(taskId, { progress, message }) };
    try {
      const result = await worker(context);
      if (tasks.get(taskId)?.status === "cancelled") return;
      update(taskId, { status: "succeeded", progress: 100, message: "完成", result, finished_at: now() });
    } catch (error) {
      if (tasks.get(taskId)?.status === "cancelled") return;
      if (error?.name === "AbortError") {
        update(taskId, { status: "cancelled", message: "已取消", finished_at: now() });
      } else {
        update(taskId, { status: "failed", message: "執行失敗", error: error instanceof Error ? error.message : String(error), finished_at: now() });
      }
    } finally {
      running.delete(taskId);
    }
  }

  function start(operation, label, worker, { retryPayload = null } = {}) {
    const taskId = crypto.randomUUID();
    tasks.set(taskId, {
      task_id: taskId,
      operation,
      label,
      status: "queued",
      progress: 0,
      message: "等待執行",
      result: null,
      error: "",
      created_at: now(),
      started_at: null,
      finished_at: null,
      retry_payload: retryPayload,
    });
    persist();
    const promise = run(taskId, worker);
    running.set(taskId, promise);
    return get(taskId);
  }

  async function cancel(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new Error("找不到指定背景任務");
    if (["succeeded", "failed", "cancelled"].includes(task.status)) return get(taskId);
    update(taskId, { status: "cancelled", message: "已取消", finished_at: now() });
    // Workers currently use cache-aware library calls. Marking the task first
    // prevents duplicate UI actions; the library call can safely finish and its
    // result is ignored by the cancelled task state.
    return get(taskId);
  }

  return {
    start,
    get,
    rawGet,
    cancel,
    list: (limit = 20) => [...tasks.values()]
      .sort((first, second) => second.created_at.localeCompare(first.created_at))
      .slice(0, limit)
      .map(publicTask),
    close: async () => {
      for (const taskId of running.keys()) {
        update(taskId, { status: "cancelled", message: "桌面 runtime 正在關閉", finished_at: now() });
      }
      running.clear();
      persist();
    },
  };
}

module.exports = { createTaskManager };
