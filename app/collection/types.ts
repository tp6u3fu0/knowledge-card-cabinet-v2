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

export type BatchOrganizeResult = {
  status?: string;
  task_id?: string | null;
  changed_cards?: number;
  cards?: Array<{ id: string; title: string; suggested_category: string; suggested_tags: string[]; changed: boolean }>;
  duplicates?: Array<{ source_id: string; target_id: string; score: number; reason: string }>;
  relations?: Array<{ source_id: string; target_id: string; score: number; reason: string }>;
  detail?: string;
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
  min_memory_gb: number;
  tier: string;
  languages: string;
  description: string;
  builtin: boolean;
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

export type SettingsTab = "local" | "api" | "data";

export const visualAccents = ["coral", "sky", "lavender", "mint"] as const;
export const visualPatterns = ["orbit", "grid", "ladder", "shelf"] as const;
export type CollectionView = "cards" | "relations" | "table";
export type RelationFilter = "all" | "semantic" | "manual";
export type RelationStrength = "all" | "strong";
