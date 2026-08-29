"use client";

import { useEffect, useState, useRef, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";

import type { CoverMotif } from "../cover-art";
import { CardSelect } from "./card-select";
import { AddCard, CardDeck, CardSlot, GlossaryCard, SettingCard } from "./setting-cards";
import { glossaryEntries } from "./glossary";

import type {
  ApiProbeResult,
  EmbeddingProbeResult,
  BackgroundTask,
  CardDraft,
  DimensionGuideEntry,
  EmbeddingChoice,
  ModelCatalog,
  SimpleChoices,
  ModelKind,
  ModelOption,
  PairedDevice,
  PairingCode,
  LanSharingStatus,
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

/** Which glyph stands for a kind of model on its cover. */
export function modelGlyph(model: ModelOption): CoverMotif["shape"] {
  if (model.kind === "summary") return "steps";
  return (model.dimensions ?? 0) >= 1024 ? "constellation" : "target";
}

function modelTags(model: ModelOption): string[] {
  // A bundled model's size is a fact about the installer, not about anything
  // the reader has to wait for, so it says "隨程式附帶" instead of a number
  // that reads as a pending download.
  const tags = [model.bundled ? "隨程式附帶" : model.size_label];
  if (model.kind === "embedding" && model.dimensions) tags.push(`${model.dimensions} 維`);
  if (model.custom) tags.push("自訂");
  return tags;
}

function modelState(model: ModelOption, isBusy: boolean): string {
  if (model.active) return "使用中";
  if (model.status === "downloading" || isBusy) return "準備中…";
  if (model.bundled) return "已內建";
  if (model.installed) return "已下載";
  return model.size_label ? `下載 ${model.size_label}` : "未下載";
}

/**
 * A model as a card you pick up, rather than a row in a list.
 *
 * Pressing the card is the whole primary interaction: it selects an installed
 * model, or starts the download for one that is not. File maintenance lives on
 * a separate strip underneath, because those are things you do to a model
 * occasionally and choosing one is what you came here for.
 */
export function ModelOptionCard({
  model,
  actionId,
  isTaskRunning,
  showTools = true,
  onDownload,
  onSelect,
  onInspect,
  onRemove,
  onRemoveCustom,
}: {
  model: ModelOption;
  actionId: string;
  isTaskRunning: boolean;
  showTools?: boolean;
  onDownload: (id: string) => void;
  onSelect: (kind: ModelKind, id: string) => void;
  onInspect: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveCustom: (id: string) => void;
}) {
  const isBusy = actionId === model.id;
  const isPending = model.status === "downloading" || isBusy;

  return (
    <div className={`model-card${model.active ? " is-active" : ""}`}>
      <SettingCard
        accent={model.kind === "summary" ? "amber" : "sky"}
        glyph={modelGlyph(model)}
        number={model.short_label}
        meta={model.recommended ? "依硬體推薦" : model.kind === "summary" ? "整理" : "向量"}
        title={model.label}
        caption={model.description}
        tags={modelTags(model)}
        state={modelState(model, isBusy)}
        active={model.active}
        disabled={isTaskRunning || isPending}
        draggableId={model.id}
        dragKind={model.kind}
        onClick={() => (model.installed ? onSelect(model.kind, model.id) : onDownload(model.id))}
      />
      {model.error ? (
        <small className="model-card__error">
          上次載入失敗{model.error_code ? `（${model.error_code}）` : ""}：{model.error}
          {model.error_hint ? ` ${model.error_hint}` : ""}
        </small>
      ) : null}
      {showTools && !model.builtin ? (
        <div className="model-card__tools">
          <button type="button" onClick={() => onInspect(model.id)} disabled={isTaskRunning}>檢查檔案</button>
          {!model.active ? <button type="button" onClick={() => onRemove(model.id)} disabled={isTaskRunning || isBusy}>清理檔案</button> : null}
          {model.custom && !model.active ? (
            <button type="button" onClick={() => onRemoveCustom(model.id)} disabled={isTaskRunning || isBusy}>從清單移除</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The explainer cards for a set of terms, placed where those terms appear.
 *
 * They used to sit in one row at the foot of each tab, which meant the answer
 * to "what is a dimension" was three screens away from the control that asks
 * you to choose one. Anchoring them to the thing they describe is the whole
 * point of having them.
 */
function GlossaryAside({ ids, label = "這是什麼？" }: { ids: string[]; label?: string }) {
  const entries = glossaryEntries(ids);
  if (entries.length === 0) return null;
  return (
    <aside className="glossary-aside">
      <span className="model-settings-kicker">{label}</span>
      <div className="glossary-aside__wall">
        {entries.map((entry) => (
          <GlossaryCard
            key={entry.id}
            accent={entry.accent}
            glyph={entry.glyph}
            number={entry.number}
            term={entry.term}
            question={entry.question}
            answer={entry.answer}
            aside={entry.aside}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * One model decision: a slot, the cards that can go in it, and the words that
 * explain them — kept together so the drag is a few centimetres rather than a
 * scroll, and so the explanation is beside the thing it explains.
 */
function ModelSection({
  kind,
  kicker,
  title,
  description,
  slotKicker,
  slotLabel,
  slotHint,
  slotCard,
  glossaryIds,
  onDrop,
  children,
  footer,
}: {
  kind: ModelKind;
  kicker: string;
  title: string;
  description: string;
  slotKicker: string;
  slotLabel: string;
  slotHint: string;
  slotCard: ReactNode;
  glossaryIds: string[];
  onDrop: (modelId: string) => void;
  children: ReactNode;
  /** Anything that opens out of the deck, such as the add-a-model form. */
  footer?: ReactNode;
}) {
  return (
    <section className="settings-block model-section">
      <div className="settings-block__heading">
        <span className="model-settings-kicker">{kicker}</span>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="model-section__body">
        <CardSlot kicker={slotKicker} label={slotLabel} hint={slotHint} card={slotCard} kind={kind} onDrop={onDrop} />
        <div className="model-section__wall">{children}</div>
        <GlossaryAside ids={glossaryIds} />
      </div>
      {footer}
    </section>
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

function DeviceManagementPanel({
  devices,
  pairingCode,
  isLoading,
  isIssuingCode,
  revokingId,
  onIssueCode,
  onRevoke,
  onForget,
  lanSharing,
  isLanSharingChanging,
  onEnableLan,
  onDisableLan,
}: {
  devices: PairedDevice[];
  pairingCode: PairingCode | null;
  isLoading: boolean;
  isIssuingCode: boolean;
  revokingId: string;
  onIssueCode: () => void;
  onRevoke: (id: string) => void;
  onForget: (id: string) => void;
  lanSharing: LanSharingStatus | null;
  isLanSharingChanging: boolean;
  onEnableLan: () => void;
  onDisableLan: () => void;
}) {
  const expiry = pairingCode ? new Date(pairingCode.expires_at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" }) : "";
  const pairingPayload = pairingCode && lanSharing?.enabled && lanSharing.api_urls[0] && lanSharing.certificate_fingerprint_sha256
    ? JSON.stringify({ version: 1, host: lanSharing.api_urls[0], certificate_fingerprint: lanSharing.certificate_fingerprint_sha256, pairing_code: pairingCode.code })
    : null;
  return (
    <div className="device-management">
      <div className="settings-api-intro settings-api-intro--devices">
        <span className="model-settings-kicker">DEVICE PAIRING / HOST ONLY</span>
        <strong>讓你的裝置安全取得自己的憑證</strong>
        <p>每台裝置拿到的鑰匙只屬於它自己，桌面這邊不會顯示也不會保存。要從外網連，請走 Tailscale 或 WireGuard。</p>
      </div>

      <section className="device-pairing-card">
        <div>
          <span className="model-settings-kicker">01 / PAIRING CODE</span>
          {pairingCode ? <strong className="device-pairing-code">{pairingCode.code}</strong> : <p>產生配對碼後，在 iPhone 的知識卡冊輸入即可。</p>}
          {pairingCode ? <small>請在 {expiry} 前完成配對；產生新碼會讓舊碼失效。</small> : null}
          {pairingPayload ? <PairingQRCode payload={pairingPayload} /> : pairingCode ? <small>啟用同一 Wi‑Fi 分享後，即可顯示可掃描的 iPhone 配對碼。</small> : null}
        </div>
        <button className="create-card-submit" type="button" onClick={onIssueCode} disabled={isIssuingCode}>
          {isIssuingCode ? "產生中…" : pairingCode ? "產生新配對碼" : "產生配對碼"}
        </button>
        <GlossaryAside ids={["pairing"]} />
      </section>

      <section className="device-list-card">
        <div className="device-list-card__heading">
          <div className="settings-block__heading">
            <span className="model-settings-kicker">02 / LOCAL NETWORK</span>
            <h3>同一 Wi‑Fi 直連</h3>
          </div>
          <button className={lanSharing?.enabled ? "settings-danger-button" : "create-card-submit"} type="button" onClick={lanSharing?.enabled ? onDisableLan : onEnableLan} disabled={isLanSharingChanging}>
            {isLanSharingChanging ? "處理中…" : lanSharing?.enabled ? "停止分享" : "啟用區網分享"}
          </button>
        </div>
        {lanSharing?.enabled ? (
          <div className="device-lan-details">
            <p>
              {lanSharing.discovery_active
                ? "Bonjour 已啟用，iPhone 可直接在清單中選到這台主機。"
                : lanSharing.discovery_detail || "這台電腦沒有 mDNS 服務，iPhone 請掃描上方 QR code 或手動輸入下列位址。"}
            </p>
            {lanSharing.api_urls.map((url) => <code key={url}>{url}</code>)}
            <code>{lanSharing.certificate_fingerprint_sha256}</code>
          </div>
        ) : <p>啟用後只會在同一個區網以 HTTPS 分享；原本桌面 API 仍維持 loopback。</p>}
        {/* The fingerprint is only worth explaining once one is on screen. */}
        {lanSharing?.enabled ? <GlossaryAside ids={["fingerprint"]} /> : null}
      </section>

      <section className="device-list-card">
        <div className="device-list-card__heading">
          <div className="settings-block__heading">
            <span className="model-settings-kicker">03 / PAIRED DEVICES</span>
            <h3>已配對裝置</h3>
          </div>
          <span>{isLoading ? "讀取中…" : `${devices.length} 台`}</span>
        </div>
        {isLoading ? <p>正在讀取裝置清單…</p> : devices.length === 0 ? <p>尚未有已配對裝置。</p> : (
          <div className="device-list">
            {devices.map((device) => (
              <div className="device-list__item" key={device.id}>
                <div>
                  <strong>{device.name}</strong>
                  <small>加入於 {new Date(device.created_at).toLocaleString("zh-TW")}{device.last_used_at ? ` · 最近使用 ${new Date(device.last_used_at).toLocaleString("zh-TW")}` : ""}</small>
                </div>
                {device.revoked_at ? (
                  <div className="device-list__actions">
                    <span>已撤銷</span>
                    <button className="settings-danger-button" type="button" onClick={() => onForget(device.id)} disabled={revokingId === device.id}>
                      {revokingId === device.id ? "刪除中…" : "刪除紀錄"}
                    </button>
                  </div>
                ) : (
                  <button className="settings-danger-button" type="button" onClick={() => onRevoke(device.id)} disabled={revokingId === device.id}>
                    {revokingId === device.id ? "撤銷中…" : "撤銷"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}

function PairingQRCode({ payload }: { payload: string }) {
  const [imageUrl, setImageUrl] = useState("");

  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(payload, { width: 220, margin: 1, errorCorrectionLevel: "M" }).then((value) => {
      if (active) setImageUrl(value);
    });
    return () => { active = false; };
  }, [payload]);

  return (
    <div className="device-pairing-qr">
      {imageUrl ? (
        // Data URL is generated locally and never requested from a remote image host.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="iPhone 配對 QR code" />
      ) : <span>產生 QR code 中…</span>}
      <p>在 iPhone 點選「掃描主機配對碼」。QR 裡只有配對碼，沒有鑰匙。</p>
    </div>
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
        <p>資料都留在這台電腦。動任何東西之前，先下載一份備份。</p>
      </div>

      <section className="settings-data-card">
        <div className="settings-block__heading">
          <span className="model-settings-kicker">01 / BACKUP</span>
          <h3>匯出本機資料</h3>
          <p>含卡片、封面、向量、垃圾桶與關聯，不含 API 金鑰。匯入會取代目前的本機資料。</p>
        </div>
        <GlossaryAside ids={["backup"]} />
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

/**
 * Adding a model from Hugging Face, reduced to the one thing only you know.
 *
 * The id is the whole input. Everything else the form used to ask for — the
 * display name, the vector width — the backend already reads out of the repo's
 * own config.json when it validates the id, so asking up front was asking
 * people to look up something the app was about to look up anyway. The extra
 * fields still exist, but only appear once detection has actually failed, which
 * in practice means being offline.
 */
function AddModelForm({
  kind,
  actionId,
  onAdd,
  onClose,
}: {
  /** Fixed by the deck the form opened out of — you are adding to that pile. */
  kind: ModelKind;
  actionId: string;
  onAdd: (input: { kind: ModelKind; model_id: string; label: string; dimensions: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [modelId, setModelId] = useState("");
  const [label, setLabel] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [needsDetail, setNeedsDetail] = useState(false);
  const isAdding = actionId === "custom-add";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modelId.trim()) return;
    const added = await onAdd({ kind, model_id: modelId.trim(), label: label.trim(), dimensions });
    if (!added) {
      // The usual cause is that the width could not be read, so offer the
      // fields rather than leaving the person to guess what went wrong.
      if (kind === "embedding" && !dimensions) setNeedsDetail(true);
      return;
    }
    setModelId("");
    setLabel("");
    setDimensions("");
    setNeedsDetail(false);
    onClose();
  };

  return (
    <form className="model-add-form" onSubmit={submit}>
      <div className="model-add-form__heading">
        <span className="model-settings-kicker">ADD FROM HUGGING FACE</span>
        <strong>貼上模型 id</strong>
        <p>
          填 <code>作者/模型名稱</code>，其餘資訊會自動從 Hugging Face 讀取。本機只跑得動 ONNX 權重。
        </p>
      </div>
      <div className="model-add-form__row">
        <input
          className="model-add-form__id"
          type="text"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          placeholder={kind === "embedding" ? "Xenova/multilingual-e5-base" : "Xenova/LaMini-Flan-T5-783M"}
          aria-label="Hugging Face 模型 id"
          required
        />
        <button className="create-card-submit" type="submit" disabled={isAdding || !modelId.trim()}>
          {isAdding ? "檢查中…" : "加入"}
        </button>
      </div>
      {needsDetail ? (
        <div className="model-add-form__fallback">
          <p>讀不到這個模型的資訊（離線時會這樣）。補上這兩欄就能手動加入。</p>
          <label>
            <span>顯示名稱 <em>選填</em></span>
            <input type="text" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="留白就用模型名稱" />
          </label>
          {kind === "embedding" ? (
            <label>
              <span>向量維度</span>
              <input type="number" min={1} value={dimensions} onChange={(event) => setDimensions(event.target.value)} placeholder="例如 768" />
            </label>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/**
 * One deck of models in the advanced view, with the blank card that adds to it.
 *
 * The add-a-model form used to be its own section at the foot of the page,
 * which made a model you added feel like it came from somewhere else. Opening
 * it from the back of the deck it will join says what it does without a label.
 */
/**
 * Rough on purpose: the point is "minutes, not seconds", not a countdown.
 *
 * A quarter of a second a card, measured on an eight-gigabyte laptop with the
 * bundled model — ninety-one cards took twenty-one seconds.
 */
function rebuildEstimate(cardCount: number) {
  const seconds = cardCount * 0.25;
  return seconds < 90 ? "不到一分鐘" : `${Math.round(seconds / 60)} 分鐘`;
}

/**
 * The one model choice that costs something to change.
 *
 * Sitting in the open next to the summary model, it read as the same kind of
 * decision. It is not: the summary model can be swapped freely and never
 * touches a stored card, while changing the embedding model recomputes every
 * vector in the cabinet. There is no reason to do that unless something
 * specific is wrong with the model already in use, so this does not recommend
 * one — it just makes sure nobody arrives here by accident.
 *
 * Closed by default. What is behind the door is the picker; what stays outside
 * is the slot naming the model in use, because that is information rather than
 * a decision.
 *
 * The warning says what actually happens, which is less alarming than it used
 * to be: the rebuild converts every card before switching, so search keeps
 * working throughout, covers and category colours do not move, and cancelling
 * leaves the cabinet exactly as it was. Overstating the risk would be its own
 * bug — people stop reading warnings that cry wolf.
 */
function EmbeddingChangeGate({ cardCount, children }: { cardCount: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="embedding-gate">
        <button className="settings-danger-button" type="button" onClick={() => setOpen(true)}>
          更改向量模型
        </button>
        <p>目前的模型隨程式附帶，沒有特別理由不需要更改。換一個模型會重新計算全部 {cardCount} 張卡片的向量。</p>
      </div>
    );
  }

  return (
    <div className="embedding-gate is-open">
      <div className="embedding-gate__warning">
        <strong>更改向量模型會重建整個卡片資料庫</strong>
        <ul>
          <li>全部 {cardCount} 張卡片的向量都會重新計算，大約 {rebuildEstimate(cardCount)}。</li>
          <li>重建期間搜尋照常可用，全部算完之後才會一次換過去。</li>
          <li>卡片的封面、分類顏色與修改時間都不會改變。</li>
          <li>中途可以取消，取消之後卡冊維持原樣。</li>
        </ul>
      </div>
      {children}
      <button className="embedding-gate__close" type="button" onClick={() => setOpen(false)}>
        收起，不更改
      </button>
    </div>
  );
}

function AdvancedModelSection({
  kind,
  models,
  actionId,
  isTaskRunning,
  onDownload,
  onSelect,
  onInspect,
  onRemove,
  onRemoveCustom,
  onAdd,
  children,
  gate,
  ...section
}: {
  kind: ModelKind;
  kicker: string;
  title: string;
  description: string;
  slotKicker: string;
  slotLabel: string;
  slotHint: string;
  slotCard: ReactNode;
  glossaryIds: string[];
  models: ModelOption[];
  actionId: string;
  isTaskRunning: boolean;
  onDrop: (modelId: string) => void;
  onDownload: (id: string) => void;
  onSelect: (kind: ModelKind, id: string) => void;
  onInspect: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveCustom: (id: string) => void;
  onAdd: (input: { kind: ModelKind; model_id: string; label: string; dimensions: string }) => Promise<boolean>;
  children?: ReactNode;
  /** Wraps the choices — not the slot — when changing this model is costly. */
  gate?: (content: ReactNode) => ReactNode;
}) {
  const [isAdding, setAdding] = useState(false);
  const wrap = gate ?? ((content: ReactNode) => content);

  return (
    <ModelSection
      kind={kind}
      {...section}
      footer={isAdding ? (
        <div className="model-section__footer">
          <AddModelForm kind={kind} actionId={actionId} onAdd={onAdd} onClose={() => setAdding(false)} />
          <GlossaryAside ids={["onnx"]} />
        </div>
      ) : null}
    >
      {wrap(<>
      {children}
      <CardDeck kind={kind} hint="攤開這疊模型">
        {models.map((model) => (
          <ModelOptionCard
            key={model.id}
            model={model}
            actionId={actionId}
            isTaskRunning={isTaskRunning}
            onDownload={onDownload}
            onSelect={onSelect}
            onInspect={onInspect}
            onRemove={onRemove}
            onRemoveCustom={onRemoveCustom}
          />
        ))}
        <AddCard
          key="add"
          label="加入模型"
          caption={`從 Hugging Face 貼上一個 id，成為這疊裡的${kind === "embedding" ? "向量" : "整理"}卡。`}
          open={isAdding}
          onClick={() => setAdding((open) => !open)}
        />
      </CardDeck>
      </>)}
    </ModelSection>
  );
}

/**
 * The default view: pick a size for tidying and a language for search, and let
 * the app choose the checkpoint.
 *
 * It renders the same card component and the same slot as the advanced view.
 * The two used to be laid out differently, which made switching between them
 * feel like arriving at an unrelated screen. Simple shows the shortlist;
 * advanced shows everything. That is the only difference there should be.
 */
function SimpleModelPicker({
  choices,
  models,
  activeSummary,
  activeEmbedding,
  actionId,
  isTaskRunning,
  summarySlot,
  embeddingSlot,
  cardCount,
  onChoose,
  onDownload,
  onSelect,
}: {
  choices: SimpleChoices;
  models: ModelOption[];
  activeSummary: string;
  activeEmbedding: string;
  actionId: string;
  isTaskRunning: boolean;
  summarySlot: ReactNode;
  embeddingSlot: ReactNode;
  cardCount: number;
  onChoose: (modelId: string) => void;
  onDownload: (id: string) => void;
  onSelect: (kind: ModelKind, id: string) => void;
}) {
  const activeChoice = choices.embedding.find((choice) => choice.model_id === activeEmbedding);
  const [language, setLanguage] = useState<EmbeddingChoice["language"]>(activeChoice?.language ?? "multi");
  const [tier, setTier] = useState<EmbeddingChoice["tier"]>(activeChoice?.tier ?? "light");

  const byId = new Map(models.map((model) => [model.id, model]));
  const selected = choices.embedding.find((choice) => choice.language === language && choice.tier === tier);
  const selectedModel = selected ? byId.get(selected.model_id) : undefined;
  /**
   * What goes in brackets after the chosen model's name.
   *
   * A bundled model's size is a fact about the installer, not something anyone
   * waits for — the rule `modelTags` already follows. Printed here it sat two
   * words away from "不需要下載", and read as a download that had not started.
   */
  const chosenDetails = [
    selectedModel?.bundled ? null : selected?.size_label,
    selected?.dimensions ? `${selected.dimensions} 維` : null,
  ].filter(Boolean).join(" · ");

  /**
   * Picking an axis is the choice, so it applies itself.
   *
   * This used to need a second click on a card that was a copy of the one
   * already in the slot. A model that is not downloaded yet is the exception:
   * a few hundred megabytes should not start moving because someone pressed a
   * button labelled "中文為主", so that case asks first.
   */
  const pick = (nextLanguage: EmbeddingChoice["language"], nextTier: EmbeddingChoice["tier"]) => {
    setLanguage(nextLanguage);
    setTier(nextTier);
    const choice = choices.embedding.find((entry) => entry.language === nextLanguage && entry.tier === nextTier);
    const model = choice ? byId.get(choice.model_id) : undefined;
    if (model?.installed && !model.active) onSelect("embedding", model.id);
  };
  const cardProps = { actionId, isTaskRunning, showTools: false, onDownload, onSelect, onInspect: () => {}, onRemove: () => {}, onRemoveCustom: () => {} };

  return (
    <div className="simple-picker">
      <ModelSection
        kind="summary"
        kicker="01 / 整理筆記"
        title="要多大的整理模型？"
        description="越大的模型讀得越懂上下文，下載和整理也越慢。隨時可以換，不影響已經存好的卡片。"
        slotKicker="ACTIVE / 整理"
        slotLabel="整理卡槽"
        slotHint="貼上筆記時，由這張卡負責拆成欄位。"
        slotCard={summarySlot}
        glossaryIds={["summary-model"]}
        onDrop={onChoose}
      >
        <CardDeck kind="summary" hint="攤開這疊模型">
          {choices.summary.map((choice) => {
            const model = byId.get(choice.model_id);
            if (!model) return null;
            return (
              <div className="model-card-wall__item" key={choice.tier}>
                <span className="model-card-wall__tier">{choice.label}</span>
                <ModelOptionCard model={{ ...model, active: choice.model_id === activeSummary }} {...cardProps} />
                <p className="model-card-wall__note">{choice.note}</p>
              </div>
            );
          })}
        </CardDeck>
      </ModelSection>

      <ModelSection
        kind="embedding"
        kicker="02 / 搜尋與關聯"
        title="搜尋與關聯的向量模型"
        description="隨程式附帶，開箱就能用。"
        slotKicker="ACTIVE / 向量"
        slotLabel="向量卡槽"
        slotHint="搜尋與關聯圖的語意距離由這張卡決定。"
        slotCard={embeddingSlot}
        glossaryIds={["embedding", "dimensions"]}
        onDrop={onChoose}
      >
        <EmbeddingChangeGate cardCount={cardCount}>
        <div className="simple-picker__axes">
          <div className="simple-axis" role="group" aria-label="語言">
            {[...new Map(choices.embedding.map((choice) => [choice.language, choice.language_label])).entries()].map(([value, label]) => (
              <button className={language === value ? "is-active" : ""} key={value} type="button" onClick={() => pick(value, tier)}>
                {label}
              </button>
            ))}
          </div>
          {/* A size, not a width. No 384-dim Chinese model exists, so a button
              promising one could only be honoured by handing back another
              language's model; the chosen card states its real width instead. */}
          <div className="simple-axis" role="group" aria-label="模型大小">
            {[...new Map(choices.embedding.map((choice) => [choice.tier, choice.tier_label])).entries()].map(([value, label]) => (
              <button className={tier === value ? "is-active" : ""} key={value} type="button" onClick={() => pick(language, value)}>
                {label}{value === "light" ? "（小而快）" : "（較準）"}
              </button>
            ))}
          </div>
        </div>
        {selected ? (
          <div className="simple-picker__chosen">
            <p>
              這個組合用的是 <strong>{selected.model_label}</strong>
              {chosenDetails ? `（${chosenDetails}）` : ""}
              {selectedModel?.bundled
                ? "，隨程式附帶，不需要下載。"
                : selectedModel?.installed ? "，已經放進左邊的卡槽。" : "，下載完成後就會放進左邊的卡槽。"}
            </p>
            {selected.note ? <p className="is-caveat">{selected.note}</p> : null}
            {selectedModel && !selectedModel.installed ? (
              <button
                className="create-card-submit"
                type="button"
                onClick={() => onDownload(selectedModel.id)}
                disabled={isTaskRunning || actionId === selectedModel.id}
              >
                {actionId === selectedModel.id ? "準備中…" : `下載 ${selectedModel.size_label}`}
              </button>
            ) : null}
          </div>
        ) : null}
        </EmbeddingChangeGate>
      </ModelSection>
    </div>
  );
}

/**
 * The 384-versus-1024 decision.
 *
 * Every dimension used to state its case in full — a headline, two figures and
 * five bullets each — which is three screens of prose sitting between someone
 * and the picker they came here for. The comparison people actually make is the
 * two numbers: how big the download is, and how much each card costs. Those
 * stay on the face. The trade-offs are one click away, one at a time.
 */
function DimensionGuide({ entries, active }: { entries: DimensionGuideEntry[]; active?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  if (entries.length === 0) return null;
  return (
    <div className="dimension-guide">
      <span className="model-settings-kicker">384 vs 1024 / 該選哪一個</span>
      <p className="dimension-guide__lede">
        維度不是越大越好，是取捨。全庫必須一致，切換會重建所有卡片的向量與關聯。
      </p>
      <div className="dimension-guide__grid">
        {entries.map((entry) => {
          const isOpen = open === entry.dimensions;
          return (
            <article
              className={`dimension-guide__card${active === entry.dimensions ? " is-active" : ""}${isOpen ? " is-open" : ""}`}
              key={entry.dimensions}
            >
              <button
                className="dimension-guide__face"
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : entry.dimensions)}
              >
                <span className="dimension-guide__topline">
                  <strong>{entry.label}</strong>
                  {active === entry.dimensions ? <span className="dimension-guide__badge">目前使用</span> : null}
                </span>
                <span className="dimension-guide__headline">{entry.headline}</span>
                <span className="dimension-guide__numbers">
                  <span>下載 {entry.download}</span>
                  <span>{entry.per_card}</span>
                </span>
                <span className="dimension-guide__toggle">{isOpen ? "收起取捨" : "看取捨"}</span>
              </button>
              {isOpen ? (
                <div className="dimension-guide__body">
                  <ul className="dimension-guide__list dimension-guide__list--good">
                    {entry.strengths.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                  <ul className="dimension-guide__list dimension-guide__list--cost">
                    {entry.limits.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function ModelSettingsPanel({
  catalog,
  cardCount,
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
  devices,
  pairingCode,
  isDevicesLoading,
  isPairingCodeIssuing,
  revokingDeviceId,
  error,
  actionId,
  onClose,
  onDownload,
  onSelect,
  onInspect,
  onRemove,
  onAddCustomModel,
  onRemoveCustomModel,
  onProbeApi,
  onProbeEmbedding,
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
  onIssuePairingCode,
  onRevokeDevice,
  onForgetDevice,
  lanSharing,
  isLanSharingChanging,
  onEnableLan,
  onDisableLan,
}: {
  catalog: ModelCatalog | null;
  cardCount: number;
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
  devices: PairedDevice[];
  pairingCode: PairingCode | null;
  isDevicesLoading: boolean;
  isPairingCodeIssuing: boolean;
  revokingDeviceId: string;
  error: string;
  actionId: string;
  onClose: () => void;
  onDownload: (id: string) => void;
  onSelect: (kind: ModelKind, id: string) => void;
  onInspect: (id: string) => void;
  onRemove: (id: string) => void;
  onAddCustomModel: (input: { kind: ModelKind; model_id: string; label: string; dimensions: string }) => Promise<boolean>;
  onRemoveCustomModel: (id: string) => void;
  onProbeApi: (kind: ModelKind) => Promise<ApiProbeResult>;
  onProbeEmbedding: () => Promise<EmbeddingProbeResult>;
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
  onIssuePairingCode: () => void;
  onRevokeDevice: (id: string) => void;
  onForgetDevice: (id: string) => void;
  lanSharing: LanSharingStatus | null;
  isLanSharingChanging: boolean;
  onEnableLan: () => void;
  onDisableLan: () => void;
}) {
  /**
   * Whether the API form differs from what is actually saved.
   *
   * The save button is disabled without it, so pressing nothing is what
   * happens when there is nothing to press it for; the bar also says so in
   * words, since a disabled button alone reads as "broken".
   */
  const hasUnsavedSettings = (["summary", "embedding"] as const).some((kind) => {
    const draft = settingsDraft[kind];
    const saved = runtimeSettings?.[kind];
    if (!saved) return true;
    return draft.source !== saved.source
      || draft.api_url !== saved.api_url
      || draft.model !== saved.model
      || draft.api_format !== saved.api_format
      || draft.api_key.length > 0
      || draft.clear_api_key;
  });

  const summaryModels = catalog?.models.filter((model) => model.kind === "summary") ?? [];
  const embeddingModels = catalog?.models.filter((model) => model.kind === "embedding") ?? [];
  const activeSummaryModel = summaryModels.find((model) => model.id === catalog?.active.summary);
  const activeEmbeddingModel = embeddingModels.find((model) => model.id === catalog?.active.embedding);
  const slotCard = (model: ModelOption | undefined) => (model ? (
    <SettingCard
      accent={model.kind === "summary" ? "amber" : "sky"}
      glyph={modelGlyph(model)}
      number={model.short_label}
      meta={model.kind === "summary" ? "整理" : "向量"}
      title={model.label}
      tags={model.kind === "embedding" && model.dimensions ? [`${model.dimensions} 維`] : [model.size_label]}
      compact
    />
  ) : null);
  const summarySlotCard = slotCard(activeSummaryModel);
  const embeddingSlotCard = slotCard(activeEmbeddingModel);
  /** Dropping a card does exactly what pressing it does. */
  const chooseModel = (modelId: string) => {
    const model = catalog?.models.find((candidate) => candidate.id === modelId);
    if (!model || isBackgroundTaskRunning) return;
    if (model.installed) onSelect(model.kind, model.id);
    else onDownload(model.id);
  };
  const [probeResults, setProbeResults] = useState<Record<ModelKind, ApiProbeResult | null>>({ summary: null, embedding: null });
  const [probing, setProbing] = useState<ModelKind | "">("");
  const [dimensionProbe, setDimensionProbe] = useState<EmbeddingProbeResult | null>(null);
  const [isMeasuring, setMeasuring] = useState(false);
  // Simple by default: naming a checkpoint is a decision most people have no
  // basis to make on first run.
  const [isAdvanced, setIsAdvanced] = useState(false);

  const providerFields = (kind: ModelKind, label: string, description: string) => {
    const setting = runtimeSettings?.[kind];
    const draft = settingsDraft[kind];
    const isApi = draft.source === "api";
    const providers = (catalog?.api_providers ?? []).filter((provider) => kind === "embedding" || provider.summary_url || provider.id === "custom");
    const probe = probeResults[kind];
    return (
      <div className="settings-provider-card">
        <div className="settings-provider-card__main">
        <div className="settings-block__heading">
          <span className="model-settings-kicker">{kind === "summary" ? "01 / SUMMARY" : "02 / EMBEDDING"}</span>
          <h3>{label}</h3>
          <p>{description}</p>
        </div>
        {/* Where the work happens is a choice between two things, so it is two
            cards — the same gesture as picking a model on the previous tab,
            rather than a dropdown that hides one option until opened. */}
        <div className="settings-source-choice">
          <SettingCard
            accent={kind === "summary" ? "amber" : "sky"}
            glyph="folder"
            number="LOCAL"
            meta="本機"
            title="本機模型"
            caption="用這台電腦的 CPU 計算，卡片內容完全不離開這裡。"
            tags={setting?.source !== "api" ? ["目前使用中"] : []}
            active={draft.source === "local"}
            compact
            onClick={() => onDraftChange(kind, "source", "local")}
          />
          <SettingCard
            accent="lavender"
            glyph="link"
            number="API"
            meta="外部服務"
            title="自訂 API"
            caption="送到你指定的服務計算。Ollama、LM Studio 也走這裡，但它們在本機執行。"
            tags={setting?.source === "api" && setting?.model ? [setting.model] : []}
            active={draft.source === "api"}
            compact
            onClick={() => onDraftChange(kind, "source", "api")}
          />
        </div>
        {isApi ? (
          <div className="settings-provider-fields">
            <CardSelect
              className="settings-provider-picker"
              label="供應商"
              placeholder="選擇供應商以自動填入位址…"
              value=""
              onChange={(next) => {
                const provider = providers.find((candidate) => candidate.id === next);
                if (!provider) return;
                const url = kind === "summary" ? provider.summary_url : provider.embedding_url;
                if (url) onDraftChange(kind, "api_url", url);
                if (kind === "embedding") onDraftChange(kind, "api_format", provider.api_format);
              }}
              options={providers.map((provider) => ({ value: provider.id, label: provider.label }))}
            />
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
                list={`${kind}-probe-models`}
                required
              />
              {probe?.models.length ? (
                <datalist id={`${kind}-probe-models`}>
                  {probe.models.map((name) => <option key={name} value={name} />)}
                </datalist>
              ) : null}
            </label>
            <div className="settings-provider-probe">
              <button
                type="button"
                onClick={async () => {
                  setProbing(kind);
                  setProbeResults((current) => ({ ...current, [kind]: null }));
                  const result = await onProbeApi(kind);
                  setProbeResults((current) => ({ ...current, [kind]: result }));
                  setProbing("");
                }}
                disabled={probing === kind || !draft.api_url}
              >
                {probing === kind ? "偵測中…" : "偵測可用模型"}
              </button>
              {probe ? (
                <span className={probe.ok ? "is-ok" : "is-error"}>
                  {probe.ok
                    ? probe.models.length
                      ? `連線成功，找到 ${probe.models.length} 個模型，可在上方欄位選擇。`
                      : probe.detail || "連線成功，但沒有列出模型。"
                    : `連線失敗：${probe.detail}`}
                </span>
              ) : null}
            </div>
            {kind === "embedding" ? (
              <div className="settings-provider-probe settings-provider-probe--dimensions">
                <button
                  type="button"
                  onClick={async () => {
                    setMeasuring(true);
                    setDimensionProbe(null);
                    setDimensionProbe(await onProbeEmbedding());
                    setMeasuring(false);
                  }}
                  disabled={isMeasuring || !draft.api_url || !draft.model}
                >
                  {isMeasuring ? "測量中…" : "測量維度"}
                </button>
                {dimensionProbe ? (
                  <span className={dimensionProbe.ok && dimensionProbe.matches_store !== false ? "is-ok" : "is-error"}>
                    {!dimensionProbe.ok
                      ? `測不到維度：${dimensionProbe.detail}`
                      : dimensionProbe.matches_store === false
                        ? `這個服務回傳 ${dimensionProbe.dimensions} 維，但你的 ${dimensionProbe.card_count} 張卡片是 ${dimensionProbe.store_dimensions} 維。存下去會重建全部向量。`
                        : dimensionProbe.matches_store === null
                          ? `這個服務回傳 ${dimensionProbe.dimensions} 維。卡冊還沒有向量，這個寬度會成為之後的基準。`
                          : `這個服務回傳 ${dimensionProbe.dimensions} 維，和現有卡片一致。`}
                  </span>
                ) : (
                  <span>送一小段文字過去，數回傳幾個數字。</span>
                )}
              </div>
            ) : null}
            {kind === "embedding" ? (
              <CardSelect
                className="settings-provider-picker"
                label="回傳格式"
                value={draft.api_format}
                onChange={(next) => onDraftChange(kind, "api_format", next)}
                options={[
                  { value: "openai", label: "OpenAI-compatible" },
                  { value: "tei", label: "Text Embeddings Inference" },
                ]}
              />
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
        {kind === "embedding" ? <p className="settings-provider-card__note">目前卡片是 {setting?.dimensions ?? 384} 維，自訂 embedding 必須回傳同樣的維度。</p> : null}
        </div>
        {/* One explanation per term per tab: the two provider blocks are the
            same choice made twice, and the answer does not change between
            them. The dimension note appears only alongside the button that
            measures one. */}
        {kind === "summary" ? <GlossaryAside ids={["local-vs-api"]} /> : null}
        {isApi && kind === "embedding" ? <GlossaryAside ids={["api-dimensions"]} /> : null}
      </div>
    );
  };

  return (
    <section className="model-settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="model-settings-header">
        <div>
          <p className="eyebrow">WORKSPACE SETTINGS</p>
          <h2 id="settings-title">設定</h2>
          <p>設定只存在這台電腦。</p>
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
        <button className={settingsTab === "devices" ? "is-active" : ""} type="button" role="tab" aria-selected={settingsTab === "devices"} onClick={() => onSettingsTabChange("devices")}>
          <span>04</span>
          裝置配對
        </button>
      </div>

      {backgroundTask ? <BackgroundTaskPanel task={backgroundTask} onCancel={onCancelTask} onRetry={onRetryTask} onDismiss={onDismissTask} /> : null}
      {error ? <p className="create-card-error" role="alert">{error}</p> : null}
      {/* Keyed on the tab so React replaces the subtree rather than patching it,
          which is what lets the new tab arrive instead of appearing. */}
      <div className="settings-tabpanel" key={settingsTab}>
      {settingsTab === "devices" ? (
        <DeviceManagementPanel
          devices={devices}
          pairingCode={pairingCode}
          isLoading={isDevicesLoading}
          isIssuingCode={isPairingCodeIssuing}
          revokingId={revokingDeviceId}
          onIssueCode={onIssuePairingCode}
          onRevoke={onRevokeDevice}
          onForget={onForgetDevice}
          lanSharing={lanSharing}
          isLanSharingChanging={isLanSharingChanging}
          onEnableLan={onEnableLan}
          onDisableLan={onDisableLan}
        />
      ) : settingsTab === "data" ? (
        <>
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
        </>
      ) : settingsTab === "api" ? (
        <form className="settings-api-form" onSubmit={onSaveSettings}>
          <div className="settings-api-intro">
            <span className="model-settings-kicker">BRING YOUR OWN MODEL</span>
            <strong>接入你熟悉的模型供應商</strong>
            <p>
              支援 OpenAI-compatible 的服務，包含在本機執行的 <b>Ollama</b> 與 <b>LM Studio</b>，以及 Hugging Face TEI。
              選擇供應商會自動填入位址。
            </p>
          </div>
          {providerFields("summary", "摘要與欄位整理", "用來把筆記整理成可檢查的知識卡草稿。")}
          {providerFields("embedding", "語意向量與關聯圖", "用來計算卡片相似度、搜尋結果與關聯圖連線。")}
          {/* Sticky, because the form is three screens tall and the button used
              to be at the bottom of the third. */}
          <div className={`settings-api-actions${hasUnsavedSettings ? " is-dirty" : ""}`}>
            <p>
              {hasUnsavedSettings
                ? "有尚未儲存的變更。若動到 embedding，儲存後會重建所有卡片的向量與關聯。"
                : "目前的設定都已儲存。"}
            </p>
            <button className="create-card-submit" type="submit" disabled={isSettingsSaving || isBackgroundTaskRunning || !hasUnsavedSettings}>
              {isSettingsSaving ? "儲存並重建中…" : "儲存並套用"}
            </button>
          </div>
        </form>
      ) : isLoading && !catalog ? (
        <div className="model-settings-empty">正在讀取本機硬體與模型狀態…</div>
      ) : catalog ? (
        <>
          <div className="model-hardware-note">
            <span className="model-settings-kicker">YOUR HARDWARE</span>
            <strong>{catalog.hardware.label}</strong>
            <span>{catalog.hardware.memory_gb} GB RAM · {catalog.hardware.cpu_cores} CPU cores</span>
            {catalog.storage ? <span>{catalog.storage.path_label} · 可用 {catalog.storage.free_size_label}</span> : null}
            <p>{catalog.hardware.note}</p>
          </div>
          <div className="model-mode-switch" role="group" aria-label="設定模式">
            <button className={isAdvanced ? "" : "is-active"} type="button" onClick={() => setIsAdvanced(false)}>簡易</button>
            <button className={isAdvanced ? "is-active" : ""} type="button" onClick={() => setIsAdvanced(true)}>進階</button>
            <span>{isAdvanced ? "逐一挑選模型，或加入 Hugging Face 上的其他模型。" : "選大小與語言就好，其餘交給應用程式。"}</span>
          </div>
          {!isAdvanced && catalog.simple ? (
            <SimpleModelPicker
              choices={catalog.simple}
              models={catalog.models}
              activeSummary={catalog.active.summary}
              activeEmbedding={catalog.active.embedding}
              actionId={actionId}
              isTaskRunning={isBackgroundTaskRunning}
              summarySlot={summarySlotCard}
              embeddingSlot={embeddingSlotCard}
              cardCount={cardCount}
              onChoose={chooseModel}
              onDownload={onDownload}
              onSelect={onSelect}
            />
          ) : (
          <>
          <AdvancedModelSection
            kind="summary"
            kicker="01 / SUMMARY"
            title="摘要與欄位整理"
            description="所有可用的整理模型。越大讀得越懂上下文，下載和整理也越慢。"
            slotKicker="ACTIVE / 整理"
            slotLabel="整理卡槽"
            slotHint="貼上筆記時，由這張卡負責拆成欄位。"
            slotCard={summarySlotCard}
            glossaryIds={["summary-model"]}
            models={summaryModels}
            actionId={actionId}
            isTaskRunning={isBackgroundTaskRunning}
            onDrop={chooseModel}
            onDownload={onDownload}
            onSelect={onSelect}
            onInspect={onInspect}
            onRemove={onRemove}
            onRemoveCustom={onRemoveCustomModel}
            onAdd={onAddCustomModel}
          />
          <AdvancedModelSection
            kind="embedding"
            kicker="02 / EMBEDDING"
            title="語意向量與關聯圖"
            description="隨程式附帶，開箱就能用。"
            slotKicker="ACTIVE / 向量"
            slotLabel="向量卡槽"
            slotHint="搜尋與關聯圖的語意距離由這張卡決定。"
            slotCard={embeddingSlotCard}
            glossaryIds={["embedding", "dimensions"]}
            models={embeddingModels}
            actionId={actionId}
            isTaskRunning={isBackgroundTaskRunning}
            onDrop={chooseModel}
            onDownload={onDownload}
            onSelect={onSelect}
            onInspect={onInspect}
            onRemove={onRemove}
            onRemoveCustom={onRemoveCustomModel}
            onAdd={onAddCustomModel}
            gate={(content) => <EmbeddingChangeGate cardCount={cardCount}>{content}</EmbeddingChangeGate>}
          >
            <DimensionGuide entries={catalog.dimension_guide ?? []} active={runtimeSettings?.embedding.dimensions} />
          </AdvancedModelSection>
          </>
          )}
        </>
      ) : null}
      </div>
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
  // Opens by itself when editing: whoever came back to a saved card came back
  // to change something, and half of what a card holds lives down here.
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(isEditing);
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

      {/*
        Four fields, and only four. Everything the reader needs to recognise
        this card later — what it is called, what it answers, the one line that
        rebuilds the understanding, and where it lives — and nothing else
        (CLAUDE.md §1 P-04). The rest is real, still editable, and one click
        away; it just no longer stands between someone and a card they were
        willing to spend twenty seconds on.
      */}
      <div className="create-card-grid">
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
        <CardSelect
          className="create-card-field create-card-field--wide"
          label="分類"
          placeholder="選擇分類"
          required
          value={draft.category}
          onChange={(next) => onChange("category", next)}
          options={[
            ...(draft.category && !categoryOptions.includes(draft.category) ? [{ value: draft.category, label: draft.category }] : []),
            ...categoryOptions.map((category) => ({ value: category, label: category })),
          ]}
        />
      </div>

      <div className="create-card-advanced">
        <button
          className="create-card-advanced__toggle"
          type="button"
          aria-expanded={isAdvancedOpen}
          onClick={() => setIsAdvancedOpen((current) => !current)}
        >
          <span>{isAdvancedOpen ? "收起進階欄位" : "展開進階欄位"}</span>
          <span className="create-card-advanced__hint">比喻、細節、來源、標籤{isEditing ? "、識別資料" : "、編號"}</span>
        </button>
        {isAdvancedOpen ? (
          <div className="create-card-grid">
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
            {/*
              The card is the cache; this is the way back to the storage. The
              kind of source is worked out from the link by the runtime rather
              than asked for here — a dropdown of six words nobody can act on
              would be one more decision in front of a card.
            */}
            <label className="create-card-field">
              <span>來源連結</span>
              <input
                type="url"
                inputMode="url"
                value={draft.source_url}
                onChange={(event) => onChange("source_url", event.target.value)}
                placeholder="https://…（Notion 頁面、論文、網頁）"
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
            <label className="create-card-field">
              <span>主題</span>
              <input
                value={draft.topic}
                onChange={(event) => onChange("topic", event.target.value)}
                placeholder={draft.category || "留空時沿用分類"}
              />
            </label>
            <label className="create-card-field">
              <span>編號</span>
              <input
                value={draft.number}
                onChange={(event) => onChange("number", event.target.value)}
                placeholder="留空自動編為 KC-000123"
              />
            </label>
            {/*
              Only ever shown for a card that already has one. Before the first
              save there is no id to show — the runtime mints it — and a box
              inviting someone to name one would put the friction straight back.
            */}
            {isEditing ? (
              <label className="create-card-field create-card-field--wide">
                <span>卡片 ID</span>
                <input readOnly value={draft.id} />
              </label>
            ) : null}
          </div>
        ) : null}
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
