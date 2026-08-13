"use client";

import { useRef, type FormEvent } from "react";

import type {
  BackgroundTask,
  CardDraft,
  ModelCatalog,
  ModelKind,
  ModelOption,
  ProviderSettingsDraft,
  RuntimeSettings,
  SettingsDraft,
  SettingsTab,
  TrashCard,
} from "./types";

export function TrashPanel({
  cards,
  isLoading,
  error,
  restoringId,
  deletingId,
  onClose,
  onRestore,
  onDelete,
}: {
  cards: TrashCard[];
  isLoading: boolean;
  error: string;
  restoringId: string;
  deletingId: string;
  onClose: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="trash-panel">
      <div className="trash-panel__header">
        <div>
          <p className="eyebrow">CARD TRASH</p>
          <h2>垃圾桶</h2>
          <span>移入垃圾桶的卡片仍可復原。</span>
        </div>
        <button className="create-card-close" type="button" onClick={onClose}>
          關閉
        </button>
      </div>

      {error ? <p className="create-card-error" role="alert">{error}</p> : null}
      {isLoading ? (
        <div className="trash-panel__empty">正在載入垃圾桶…</div>
      ) : cards.length === 0 ? (
        <div className="trash-panel__empty">垃圾桶目前是空的。</div>
      ) : (
        <div className="trash-list">
          {cards.map((card) => (
            <div className="trash-list__item" key={card.id}>
              <div>
                <span>{card.number} · {card.topic}</span>
                <strong>{card.title}</strong>
                <small>
                  {card.deleted_at ? new Date(card.deleted_at).toLocaleString("zh-TW") : "已移除"}
                </small>
              </div>
              <div className="trash-list__actions">
                <button
                  className="trash-restore-button"
                  type="button"
                  onClick={() => onRestore(card.id)}
                  disabled={restoringId === card.id || deletingId === card.id}
                >
                  {restoringId === card.id ? "復原中…" : "復原"}
                </button>
                <button
                  className="trash-delete-button"
                  type="button"
                  onClick={() => onDelete(card.id)}
                  disabled={restoringId === card.id || deletingId === card.id}
                >
                  {deletingId === card.id ? "刪除中…" : "永久刪除"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ModelOptionCard({
  model,
  actionId,
  isTaskRunning,
  onDownload,
  onSelect,
  onInspect,
  onRemove,
}: {
  model: ModelOption;
  actionId: string;
  isTaskRunning: boolean;
  onDownload: (id: string) => void;
  onSelect: (kind: ModelKind, id: string) => void;
  onInspect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const isBusy = actionId === model.id;
  return (
    <article className={`model-option${model.active ? " is-active" : ""}`}>
      <div className="model-option__topline">
        <span>{model.short_label}</span>
        {model.recommended ? <b>依硬體推薦</b> : null}
      </div>
      <h3>{model.label}</h3>
      <p>{model.description}</p>
      <div className="model-option__meta">
        <span>{model.size_label}</span>
        <span>{model.tier}</span>
        <span>{model.languages}</span>
      </div>
      <div className="model-option__storage">
        <span>檔案：{model.storage?.size_label ?? (model.builtin ? "不需下載" : "尚未檢查")}</span>
        <span>{model.storage?.status === "partial" ? "可續傳" : model.storage?.status === "ready" ? "檔案完整" : model.builtin ? "內建" : "尚未下載"}</span>
      </div>
      {model.error ? (
        <small className="model-option__error">
          上次載入失敗{model.error_code ? `（${model.error_code}）` : ""}：{model.error}
          {model.error_hint ? ` ${model.error_hint}` : ""}
        </small>
      ) : null}
      <div className="model-option__actions">
        {model.active ? (
          <span className="model-option__active">目前使用中</span>
        ) : model.status === "downloading" || isBusy ? (
          <span className="model-option__pending">下載／準備中…</span>
        ) : model.installed ? (
          <button type="button" onClick={() => onSelect(model.kind, model.id)} disabled={isTaskRunning}>
            啟用這個模型
          </button>
        ) : (
          <button type="button" onClick={() => onDownload(model.id)} disabled={isTaskRunning}>
            下載模型
          </button>
        )}
      </div>
      {!model.builtin ? (
        <div className="model-option__tools">
          <button type="button" onClick={() => onInspect(model.id)} disabled={isTaskRunning}>檢查檔案</button>
          {!model.active ? <button type="button" onClick={() => onRemove(model.id)} disabled={isTaskRunning || isBusy}>清理檔案</button> : null}
        </div>
      ) : null}
    </article>
  );
}

export function BackgroundTaskPanel({ task, onCancel, onRetry, onDismiss }: { task: BackgroundTask; onCancel: () => void; onRetry: () => void; onDismiss: () => void }) {
  const isRunning = task.status === "queued" || task.status === "running";
  const progress = Math.min(100, Math.max(0, Math.round(task.progress)));
  const statusLabel = task.status === "succeeded"
    ? "已完成"
    : task.status === "failed"
      ? "處理失敗"
      : task.status === "cancelled"
        ? "已取消"
        : task.status === "queued"
          ? "等待開始"
          : "處理中";

  return (
    <section
      className={`background-task-panel${isRunning ? " is-running" : ""}${task.status === "failed" ? " is-failed" : ""}`}
      aria-live="polite"
      aria-label="模型背景任務進度"
    >
      <div className="background-task-panel__mark" aria-hidden="true">
        <span />
      </div>
      <div className="background-task-panel__body">
        <div className="background-task-panel__heading">
          <div>
            <span className="model-settings-kicker">BACKGROUND TASK / {task.operation.toUpperCase()}</span>
            <strong>{task.label || "模型任務"}</strong>
          </div>
          <span className="background-task-panel__status">{statusLabel}</span>
        </div>
        <p>{task.error || task.message || "正在準備…"}</p>
        <div className="background-task-panel__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
      <strong className="background-task-panel__percent">{progress}%</strong>
      <div className="background-task-panel__actions">
        {isRunning ? <button type="button" onClick={onCancel}>取消任務</button> : null}
        {!isRunning && task.can_retry ? <button type="button" onClick={onRetry}>重試任務</button> : null}
        {!isRunning ? <button type="button" onClick={onDismiss}>關閉</button> : null}
      </div>
    </section>
  );
}

export function DataManagementPanel({
  isExporting,
  isImporting,
  isResetting,
  hasBackup,
  backupAcknowledged,
  resetConfirmation,
  onExport,
  onImport,
  onBackupAcknowledgedChange,
  onResetConfirmationChange,
  onReset,
}: {
  isExporting: boolean;
  isImporting: boolean;
  isResetting: boolean;
  hasBackup: boolean;
  backupAcknowledged: boolean;
  resetConfirmation: string;
  onExport: () => void;
  onImport: (file: File) => void;
  onBackupAcknowledgedChange: (value: boolean) => void;
  onResetConfirmationChange: (value: string) => void;
  onReset: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canReset = hasBackup && backupAcknowledged && resetConfirmation === "RESET DATABASE";

  return (
    <div className="settings-data-form">
      <div className="settings-api-intro settings-api-intro--data">
        <span className="model-settings-kicker">LOCAL DATA / SAFETY</span>
        <strong>先備份，再整理本機資料</strong>
        <p>資料會留在這台電腦的 Docker PostgreSQL。匯出會下載一份 JSON 備份；重置只會清除卡片、垃圾桶與關聯，不會刪除模型檔案或資料表結構。</p>
      </div>

      <section className="settings-data-card">
        <div>
          <span className="model-settings-kicker">01 / BACKUP</span>
          <h3>匯出本機資料</h3>
          <p>包含卡片內容、封面資料、embedding、垃圾桶內容與卡片關聯。API 金鑰不會寫入備份檔。匯入會取代目前本機資料。</p>
        </div>
        <div className="settings-data-actions">
          <button className="settings-secondary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={isImporting || isExporting || isResetting}>
            {isImporting ? "匯入中…" : "匯入 JSON 備份"}
          </button>
          <button className="create-card-submit" type="button" onClick={onExport} disabled={isExporting || isImporting || isResetting}>
            {isExporting ? "準備備份中…" : "下載 JSON 備份"}
          </button>
          <input
            ref={fileInputRef}
            className="settings-file-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onImport(file);
            }}
          />
        </div>
      </section>

      <section className="settings-danger-zone">
        <div>
          <span className="model-settings-kicker">02 / RESET</span>
          <h3>重置本機資料庫</h3>
          <p>這會清除目前所有啟用卡片、垃圾桶卡片與關聯。模型設定、模型下載檔與資料表結構會保留。</p>
        </div>
        <label className="settings-data-check">
          <input
            type="checkbox"
            checked={backupAcknowledged}
            disabled={!hasBackup || isResetting}
            onChange={(event) => onBackupAcknowledgedChange(event.target.checked)}
          />
          <span>我已下載並保存剛才的 JSON 備份</span>
        </label>
        <label className="settings-confirm-field">
          <span>輸入確認文字</span>
          <input
            value={resetConfirmation}
            onChange={(event) => onResetConfirmationChange(event.target.value)}
            placeholder="RESET DATABASE"
            autoComplete="off"
            spellCheck={false}
            disabled={isResetting}
          />
        </label>
        <button className="settings-danger-button" type="button" onClick={onReset} disabled={!canReset || isResetting || isExporting}>
          {isResetting ? "重置中…" : "重置本機資料庫"}
        </button>
      </section>
    </div>
  );
}

export function ModelSettingsPanel({
  catalog,
  runtimeSettings,
  settingsDraft,
  settingsTab,
  backgroundTask,
  isBackgroundTaskRunning,
  isLoading,
  isSettingsSaving,
  isDatabaseExporting,
  isDatabaseImporting,
  isDatabaseResetting,
  hasDatabaseBackup,
  databaseBackupAcknowledged,
  databaseResetConfirmation,
  error,
  actionId,
  onClose,
  onDownload,
  onSelect,
  onInspect,
  onRemove,
  onCancelTask,
  onRetryTask,
  onDismissTask,
  onSettingsTabChange,
  onDraftChange,
  onSaveSettings,
  onExportDatabase,
  onImportDatabase,
  onDatabaseBackupAcknowledgedChange,
  onDatabaseResetConfirmationChange,
  onResetDatabase,
}: {
  catalog: ModelCatalog | null;
  runtimeSettings: RuntimeSettings | null;
  settingsDraft: SettingsDraft;
  settingsTab: SettingsTab;
  backgroundTask: BackgroundTask | null;
  isBackgroundTaskRunning: boolean;
  isLoading: boolean;
  isSettingsSaving: boolean;
  isDatabaseExporting: boolean;
  isDatabaseImporting: boolean;
  isDatabaseResetting: boolean;
  hasDatabaseBackup: boolean;
  databaseBackupAcknowledged: boolean;
  databaseResetConfirmation: string;
  error: string;
  actionId: string;
  onClose: () => void;
  onDownload: (id: string) => void;
  onSelect: (kind: ModelKind, id: string) => void;
  onInspect: (id: string) => void;
  onRemove: (id: string) => void;
  onCancelTask: () => void;
  onRetryTask: () => void;
  onDismissTask: () => void;
  onSettingsTabChange: (tab: SettingsTab) => void;
  onDraftChange: (kind: ModelKind, field: keyof ProviderSettingsDraft, value: string | boolean) => void;
  onSaveSettings: (event: FormEvent<HTMLFormElement>) => void;
  onExportDatabase: () => void;
  onImportDatabase: (file: File) => void;
  onDatabaseBackupAcknowledgedChange: (value: boolean) => void;
  onDatabaseResetConfirmationChange: (value: string) => void;
  onResetDatabase: () => void;
}) {
  const summaryModels = catalog?.models.filter((model) => model.kind === "summary") ?? [];
  const embeddingModels = catalog?.models.filter((model) => model.kind === "embedding") ?? [];

  const providerFields = (kind: ModelKind, label: string, description: string) => {
    const setting = runtimeSettings?.[kind];
    const draft = settingsDraft[kind];
    const isApi = draft.source === "api";
    return (
      <div className="settings-provider-card">
        <div className="settings-provider-card__heading">
          <div>
            <span className="model-settings-kicker">{kind === "summary" ? "01 / SUMMARY" : "02 / EMBEDDING"}</span>
            <h3>{label}</h3>
          </div>
          <p>{description}</p>
        </div>
        <div className="settings-provider-card__mode">
          <label>
            <span>執行方式</span>
            <select
              value={draft.source}
              onChange={(event) => onDraftChange(kind, "source", event.target.value)}
            >
              <option value="local">本機模型</option>
              <option value="api">自訂 API</option>
            </select>
          </label>
          <div className={`settings-provider-status${setting?.source === "api" ? " is-api" : ""}`}>
            <span>{setting?.source === "api" ? "目前使用自訂 API" : "目前使用本機模型"}</span>
            {setting?.model ? <strong>{setting.model}</strong> : null}
          </div>
        </div>
        {isApi ? (
          <div className="settings-provider-fields">
            <label>
              <span>API endpoint</span>
              <input
                type="url"
                value={draft.api_url}
                onChange={(event) => onDraftChange(kind, "api_url", event.target.value)}
                placeholder={kind === "summary" ? "https://api.example.com/v1/chat/completions" : "https://api.example.com/v1/embeddings"}
                required
              />
            </label>
            <label>
              <span>模型名稱</span>
              <input
                type="text"
                value={draft.model}
                onChange={(event) => onDraftChange(kind, "model", event.target.value)}
                placeholder={kind === "summary" ? "例如：gpt-4o-mini" : "例如：text-embedding-3-small"}
                required
              />
            </label>
            {kind === "embedding" ? (
              <label>
                <span>回傳格式</span>
                <select
                  value={draft.api_format}
                  onChange={(event) => onDraftChange(kind, "api_format", event.target.value)}
                >
                  <option value="openai">OpenAI-compatible</option>
                  <option value="tei">Text Embeddings Inference</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>API 金鑰 <em>{setting?.api_key_set ? "已儲存，留白會沿用" : "選填"}</em></span>
              <input
                type="password"
                value={draft.api_key}
                onChange={(event) => onDraftChange(kind, "api_key", event.target.value)}
                placeholder={setting?.api_key_set ? "已設定，輸入新金鑰可覆蓋" : "sk-…"}
                autoComplete="new-password"
              />
            </label>
            {setting?.api_key_set ? (
              <label className="settings-provider-fields__checkbox">
                <input
                  type="checkbox"
                  checked={draft.clear_api_key}
                  onChange={(event) => onDraftChange(kind, "clear_api_key", event.target.checked)}
                />
                <span>清除已儲存的 API 金鑰</span>
              </label>
            ) : null}
          </div>
        ) : null}
        {kind === "embedding" ? <p className="settings-provider-card__note">目前資料庫向量固定為 {setting?.dimensions ?? 384} 維；自訂 embedding 必須回傳這個維度，才可以重新建立關聯。</p> : null}
      </div>
    );
  };

  return (
    <section className="model-settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="model-settings-header">
        <div>
          <p className="eyebrow">WORKSPACE SETTINGS</p>
          <h2 id="settings-title">設定</h2>
          <p>把模型來源、API 連線與本機資源集中管理。設定儲存在這個知識卡櫃，不會上傳到外部服務。</p>
        </div>
        <button className="create-card-close" type="button" onClick={onClose}>
          關閉
        </button>
      </div>

      <div className="settings-tabs" role="tablist" aria-label="設定分類">
        <button className={settingsTab === "local" ? "is-active" : ""} type="button" role="tab" aria-selected={settingsTab === "local"} onClick={() => onSettingsTabChange("local")}>
          <span>01</span>
          本機模型
        </button>
        <button className={settingsTab === "api" ? "is-active" : ""} type="button" role="tab" aria-selected={settingsTab === "api"} onClick={() => onSettingsTabChange("api")}>
          <span>02</span>
          自訂 API
        </button>
        <button className={settingsTab === "data" ? "is-active" : ""} type="button" role="tab" aria-selected={settingsTab === "data"} onClick={() => onSettingsTabChange("data")}>
          <span>03</span>
          資料管理
        </button>
      </div>

      {backgroundTask ? <BackgroundTaskPanel task={backgroundTask} onCancel={onCancelTask} onRetry={onRetryTask} onDismiss={onDismissTask} /> : null}
      {error ? <p className="create-card-error" role="alert">{error}</p> : null}
      {settingsTab === "data" ? (
        <DataManagementPanel
          isExporting={isDatabaseExporting}
          isImporting={isDatabaseImporting}
          isResetting={isDatabaseResetting}
          hasBackup={hasDatabaseBackup}
          backupAcknowledged={databaseBackupAcknowledged}
          resetConfirmation={databaseResetConfirmation}
          onExport={onExportDatabase}
          onImport={onImportDatabase}
          onBackupAcknowledgedChange={onDatabaseBackupAcknowledgedChange}
          onResetConfirmationChange={onDatabaseResetConfirmationChange}
          onReset={onResetDatabase}
        />
      ) : settingsTab === "api" ? (
        <form className="settings-api-form" onSubmit={onSaveSettings}>
          <div className="settings-api-intro">
            <span className="model-settings-kicker">BRING YOUR OWN MODEL</span>
            <strong>接入你熟悉的模型供應商</strong>
            <p>摘要使用 OpenAI-compatible Chat Completions；embedding 支援 OpenAI-compatible 或 TEI。只要填入 endpoint、模型名稱與金鑰，就能在本機流程中使用。</p>
          </div>
          {providerFields("summary", "摘要與欄位整理", "用來把筆記整理成可檢查的知識卡草稿。")}
          {providerFields("embedding", "語意向量與關聯圖", "用來計算卡片相似度、搜尋結果與關聯圖連線。")}
          <div className="settings-api-actions">
            <p>儲存後若 embedding 設定有變更，系統會重新建立現有卡片的向量與關聯。</p>
            <button className="create-card-submit" type="submit" disabled={isSettingsSaving || isBackgroundTaskRunning}>
              {isSettingsSaving ? "儲存並重建中…" : "儲存並套用"}
            </button>
          </div>
        </form>
      ) : isLoading && !catalog ? (
        <div className="model-settings-empty">正在讀取本機硬體與模型狀態…</div>
      ) : catalog ? (
        <>
          <div className="model-hardware-note">
            <div>
              <span className="model-settings-kicker">YOUR HARDWARE</span>
              <strong>{catalog.hardware.label}</strong>
            </div>
            <span>{catalog.hardware.memory_gb} GB RAM · {catalog.hardware.cpu_cores} CPU cores</span>
            {catalog.storage ? <span>{catalog.storage.path_label} · 可用 {catalog.storage.free_size_label}</span> : null}
            <p>{catalog.hardware.note}</p>
          </div>
          <div className="model-settings-group">
            <div className="model-settings-group__heading">
              <div>
                <span className="model-settings-kicker">01 / SUMMARY</span>
                <h3>摘要與欄位整理</h3>
              </div>
              <p>決定「先貼上筆記」時，模型如何幫你整理卡片。</p>
            </div>
            <div className="model-options-grid">
              {summaryModels.map((model) => (
                <ModelOptionCard key={model.id} model={model} actionId={actionId} isTaskRunning={isBackgroundTaskRunning} onDownload={onDownload} onSelect={onSelect} onInspect={onInspect} onRemove={onRemove} />
              ))}
            </div>
          </div>
          <div className="model-settings-group model-settings-group--embedding">
            <div className="model-settings-group__heading">
              <div>
                <span className="model-settings-kicker">02 / EMBEDDING</span>
                <h3>語意向量與關聯圖</h3>
              </div>
              <p>決定卡片之間的語意距離與搜尋結果。</p>
            </div>
            <div className="model-options-grid">
              {embeddingModels.map((model) => (
                <ModelOptionCard key={model.id} model={model} actionId={actionId} isTaskRunning={isBackgroundTaskRunning} onDownload={onDownload} onSelect={onSelect} onInspect={onInspect} onRemove={onRemove} />
              ))}
            </div>
          </div>
          <p className="model-settings-footnote">本機模型執行在 CPU／ONNX runtime；切換到自訂 API 時，只有產生摘要或向量的請求會送到你填入的服務。</p>
        </>
      ) : null}
    </section>
  );
}

export function CreateCardForm({
  draft,
  categoryOptions,
  sourceText,
  isEditing,
  isSaving,
  isDrafting,
  error,
  onSourceChange,
  onGenerate,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: CardDraft;
  categoryOptions: string[];
  sourceText: string;
  isEditing: boolean;
  isSaving: boolean;
  isDrafting: boolean;
  error: string;
  onSourceChange: (value: string) => void;
  onGenerate: () => void;
  onChange: (field: keyof CardDraft, value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="create-card-panel" onSubmit={onSubmit}>
      <div className="create-card-header">
        <div>
          <p className="eyebrow">{isEditing ? "EDIT KNOWLEDGE CARD" : "NEW KNOWLEDGE CARD"}</p>
          <h2>{isEditing ? "把這張卡片重新整理。" : "把下一個理解留下來。"}</h2>
        </div>
        <button className="create-card-close" type="button" onClick={onClose}>
          關閉
        </button>
      </div>

      <div className="create-card-ai-box">
        <div className="create-card-ai-heading">
          <div>
            <span className="create-card-ai-kicker">LOCAL AI ASSIST</span>
            <strong>先貼上筆記，讓本機模型幫你整理欄位</strong>
          </div>
          <span>本機整理 · 不上傳內容</span>
        </div>
        <textarea
          className="create-card-ai-input"
          rows={6}
          value={sourceText}
          onChange={(event) => onSourceChange(event.target.value)}
          placeholder="貼上文章摘錄、讀書筆記或你的零散想法（至少 20 個字）"
        />
        <div className="create-card-ai-actions">
          <span>只產生摘要與欄位草稿，仍可在下方修改後再儲存。</span>
          <button
            className="create-card-ai-button"
            type="button"
            onClick={onGenerate}
            disabled={isDrafting || isSaving || sourceText.trim().length < 20}
          >
            {isDrafting ? "本機整理中…" : "✦ AI 整理欄位"}
          </button>
        </div>
      </div>

      <div className="create-card-grid">
        <label className="create-card-field">
          <span>卡片 ID</span>
          <input
            required
            disabled={isEditing}
            value={draft.id}
            onChange={(event) => onChange("id", event.target.value)}
            placeholder="attention-v2"
          />
        </label>
        <label className="create-card-field">
          <span>編號</span>
          <input
            required
            value={draft.number}
            onChange={(event) => onChange("number", event.target.value)}
            placeholder="AI-005"
          />
        </label>
        <label className="create-card-field">
          <span>分類</span>
          <select
            required
            value={draft.category}
            onChange={(event) => onChange("category", event.target.value)}
          >
            {draft.category && !categoryOptions.includes(draft.category) ? <option value={draft.category}>{draft.category}</option> : null}
            {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label className="create-card-field">
          <span>主題</span>
          <input
            required
            value={draft.topic}
            onChange={(event) => onChange("topic", event.target.value)}
            placeholder="人工智慧"
          />
        </label>
        <label className="create-card-field create-card-field--wide">
          <span>標題</span>
          <input
            required
            value={draft.title}
            onChange={(event) => onChange("title", event.target.value)}
            placeholder="例如：向量資料庫是什麼？"
          />
        </label>
        <label className="create-card-field create-card-field--wide">
          <span>想回答的問題</span>
          <input
            required
            value={draft.question}
            onChange={(event) => onChange("question", event.target.value)}
            placeholder="我想用自己的話回答什麼？"
          />
        </label>
        <label className="create-card-field create-card-field--wide">
          <span>一句話摘要</span>
          <textarea
            required
            rows={3}
            value={draft.summary}
            onChange={(event) => onChange("summary", event.target.value)}
            placeholder="先用一句話說清楚這張卡的核心。"
          />
        </label>
        <label className="create-card-field">
          <span>生活比喻</span>
          <textarea
            rows={4}
            value={draft.analogy}
            onChange={(event) => onChange("analogy", event.target.value)}
            placeholder="它像生活中的什麼？"
          />
        </label>
        <label className="create-card-field">
          <span>再往裡面看</span>
          <textarea
            rows={4}
            value={draft.detail}
            onChange={(event) => onChange("detail", event.target.value)}
            placeholder="補充機制、細節或限制。"
          />
        </label>
        <label className="create-card-field">
          <span>來源</span>
          <input
            value={draft.source}
            onChange={(event) => onChange("source", event.target.value)}
            placeholder="論文、書籍或研究筆記"
          />
        </label>
        <label className="create-card-field">
          <span>標籤</span>
          <input
            value={draft.tags}
            onChange={(event) => onChange("tags", event.target.value)}
            placeholder="入門, 核心概念"
          />
        </label>
      </div>

      {error ? <p className="create-card-error" role="alert">{error}</p> : null}
      <div className="create-card-actions">
        <span>儲存時會同步建立本地語意 embedding。</span>
        <div>
          <button className="create-card-cancel" type="button" onClick={onClose}>
            取消
          </button>
          <button className="create-card-submit" type="submit" disabled={isSaving || isDrafting}>
            {isSaving ? "更新 embedding 中…" : isEditing ? "儲存變更" : "儲存知識卡"}
          </button>
        </div>
      </div>
    </form>
  );
}
