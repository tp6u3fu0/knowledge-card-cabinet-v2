import type { CoverSpec } from "../card-face";

export type KnowledgeCard = {
  id: string;
  number: string;
  topic: string;
  category: string;
  title: string;
  question: string;
  summary: string;
  analogy: string;
  detail: string;
  source: string;
  accent: string;
  pattern: string;
  cover?: CoverSpec;
  tags: string[];
  related: string[];
  updated_at?: string;
  created_at?: string;
};

export type ApiCard = {
  id: string;
  number: string;
  topic: string;
  category?: string;
  title: string;
  question?: string;
  summary?: string;
  analogy?: string;
  detail?: string;
  source?: string;
  tags?: string[];
  cover?: CoverSpec | null;
  search_reasons?: string[];
  score?: number;
  // Both halves of the hybrid score, reported so a bad ranking can be measured
  // rather than argued about. semantic_score is null when the card carries no
  // vector the query could be compared against — which is not the same as a
  // vector that scored zero.
  lexical_score?: number;
  semantic_score?: number | null;
  created_at?: string;
  updated_at?: string;
};

export type ApiRelation = {
  relation_type: string;
  score: number;
  status: string;
  reason?: string;
  created_at?: string | null;
  updated_at?: string | null;
  card: ApiCard;
};

export type CategoryRecord = {
  name: string;
  card_count: number;
  created_at?: string | null;
  updated_at?: string | null;
};

export type DuplicatePair = {
  source_id: string;
  source_title: string;
  target_id: string;
  target_title: string;
  score: number;
  reason: string;
};

export type RelationEdge = {
  source_id: string;
  target_id: string;
  relation_type: "semantic" | "manual";
  score: number;
  status: string;
  reason?: string;
  created_at?: string | null;
  updated_at?: string | null;
};

export type TrashCard = ApiCard & {
  deleted_at?: string | null;
};

export type CardDraft = {
  id: string;
  number: string;
  topic: string;
  category: string;
  title: string;
  question: string;
  summary: string;
  analogy: string;
  detail: string;
  source: string;
  tags: string;
};

export type CardDraftResponse = {
  detail?: string;
  model?: string;
  draft?: {
    category?: string;
    topic?: string;
    title?: string;
    question?: string;
    summary?: string;
    analogy?: string;
    detail?: string;
    tags?: string[];
  };
};

export type ModelKind = "summary" | "embedding";

export type ModelOption = {
  id: string;
  kind: ModelKind;
  label: string;
  short_label: string;
  provider: string;
  model_id: string | null;
  task: string;
  dimensions?: number;
  size_label: string;
  size_tier?: "none" | "small" | "medium" | "large";
  language?: "none" | "zh" | "en" | "multi";
  min_memory_gb: number;
  tier: string;
  languages: string;
  description: string;
  builtin: boolean;
  /**
   * Its weights ship inside the installer, so it is ready without a download.
   * The API has always sent this; nothing displayed it, which meant the bundled
   * model advertised a download size it did not need.
   */
  bundled?: boolean;
  /** Added by the user from a Hugging Face id rather than shipped with the app. */
  custom?: boolean;
  added_at?: string;
  active: boolean;
  installed: boolean;
  recommended: boolean;
  status: "available" | "downloading" | "ready";
  error?: string;
  error_code?: string;
  error_hint?: string;
  storage?: ModelStorage;
};

export type ModelStorage = {
  status: "ready" | "partial" | "missing";
  installed: boolean;
  files: number;
  bytes: number;
  size_label: string;
  download_size_bytes: number;
  resumable: boolean;
};

export type ModelCatalog = {
  hardware: {
    tier: string;
    label: string;
    memory_gb: number;
    cpu_cores: number;
    recommended_summary: string;
    recommended_embedding: string;
    note: string;
  };
  active: {
    summary: string;
    embedding: string;
  };
  active_source?: {
    summary: "local" | "api";
    embedding: "local" | "api";
  };
  storage?: {
    path_label: string;
    free_bytes: number;
    free_size_label: string;
    total_bytes: number;
    total_size_label: string;
  };
  models: ModelOption[];
  dimension_guide?: DimensionGuideEntry[];
  api_providers?: ApiProvider[];
  simple?: SimpleChoices;
};

export type SimpleChoices = {
  summary: SummaryTierChoice[];
  embedding: EmbeddingChoice[];
};

export type SummaryTierChoice = {
  tier: "none" | "small" | "medium" | "large";
  label: string;
  headline: string;
  note: string;
  model_id: string;
  model_label: string;
  size_label: string;
};

export type EmbeddingChoice = {
  language: "zh" | "en" | "multi";
  language_label: string;
  /** The size the user asked for. The width is whatever that model happens to be. */
  tier: "light" | "precise";
  tier_label: string;
  dimensions: number;
  model_id: string;
  model_label: string;
  size_label: string;
  /** False when no model matches this pair exactly and the nearest was used. */
  exact: boolean;
  note: string;
};

export type DimensionGuideEntry = {
  dimensions: number;
  label: string;
  headline: string;
  download: string;
  per_card: string;
  strengths: string[];
  limits: string[];
};

export type ApiProvider = {
  id: string;
  label: string;
  summary_url: string;
  embedding_url: string;
  api_format: "openai" | "tei";
  key_required: boolean;
  note: string;
};

export type ApiProbeResult = {
  ok: boolean;
  endpoint: string;
  models: string[];
  detail: string;
};

export type BackgroundTask = {
  task_id: string;
  operation: string;
  label: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  message: string;
  result?: Record<string, unknown> | null;
  error?: string;
  can_retry?: boolean;
};

export type ProviderSetting = {
  source: "local" | "api";
  provider: string;
  api_url: string;
  api_format: "openai" | "tei";
  model: string;
  api_key_set: boolean;
  dimensions?: number;
};

export type RuntimeSettings = {
  summary: ProviderSetting;
  embedding: ProviderSetting;
};

export type ProviderSettingsDraft = {
  source: "local" | "api";
  api_url: string;
  model: string;
  api_format: "openai" | "tei";
  api_key: string;
  clear_api_key: boolean;
};

export type SettingsDraft = {
  summary: ProviderSettingsDraft;
  embedding: ProviderSettingsDraft;
};

export type SettingsTab = "local" | "api" | "data" | "devices";

/**
 * What one test embedding revealed about a custom API.
 *
 * `matches_store` is deliberately nullable: an empty library has no width to
 * clash with, and reporting that as "compatible" would be answering a question
 * nobody asked.
 */
export type EmbeddingProbeResult = {
  ok: boolean;
  dimensions: number;
  detail: string;
  store_dimensions: number;
  matches_store: boolean | null;
  card_count: number;
};

export type PairedDevice = {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
};

export type PairingCode = {
  code: string;
  expires_at: string;
};

export type LanSharingStatus = {
  enabled: boolean;
  transport: string;
  port: number | null;
  api_urls: string[];
  certificate_fingerprint_sha256: string;
  pairing_requires_fingerprint: boolean;
  /** mDNS is optional: macOS always has it, Windows only with Apple Bonjour. */
  discovery_active?: boolean;
  discovery_detail?: string;
};

/** Must match PALETTES in desktop/local-api.cjs and the accent rules in globals.css. */
export const visualAccents = ["coral", "sky", "lavender", "mint", "amber", "rose", "indigo", "moss"] as const;
export type VisualAccent = (typeof visualAccents)[number];
export const visualPatterns = ["orbit", "grid", "ladder", "shelf"] as const;
export type CollectionView = "cards" | "relations" | "table";
export type RelationFilter = "all" | "semantic" | "manual";
export type RelationStrength = "all" | "strong";

/**
 * What build this is, and whether a newer one has been published.
 *
 * Every field after the version is allowed to be absent: the check is capped
 * at once a day, can be switched off entirely, and fails silently when there
 * is no network — all of which arrive here as "nothing to say".
 */
export type AppVersion = {
  version: string;
  update_available?: boolean;
  latest_version?: string | null;
  release_url?: string | null;
  checked_at?: string | null;
};
