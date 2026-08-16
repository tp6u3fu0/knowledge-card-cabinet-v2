const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const BUILTIN_SUMMARY_MODEL = "summary-template";
const BUILTIN_EMBEDDING_MODEL = "embedding-hash-384";
/**
 * The embedding whose weights ship inside the installer, so a fresh cabinet has
 * real semantics before anything is downloaded. Falls back to the hash
 * embedding when the files are not there (a plain `npm run build`, or a build
 * where scripts/fetch-bundled-model.mjs was skipped).
 */
const BUNDLED_EMBEDDING_MODEL = "embedding-multilingual-384";
/** Width of the built-in hash embedding. Not the width of every model. */
const HASH_EMBEDDING_DIMENSIONS = 384;
const SETTINGS_VERSION = 1;

/**
 * What "384 or 1024" actually costs, so the choice can be made from the
 * settings page instead of from folklore. Dimension is not quality on its own —
 * it is the model that differs — but width is the part that follows the vector
 * into storage, memory and every comparison, so the two are worth stating
 * together. Measured on this project's own runtime, not quoted from a paper.
 */
const DIMENSION_GUIDE = [
  {
    dimensions: 384,
    label: "384 維",
    headline: "小、快、夠用",
    download: "90–140 MB",
    per_card: "1.5 KB／張",
    strengths: ["下載與首次載入最快", "CPU 推論負擔最低，樹莓派也跑得動", "資料庫與記憶體占用最小"],
    limits: ["中文長句與跨領域概念的區辨力較弱", "同義但用詞不同的卡片較容易漏抓"],
  },
  {
    dimensions: 512,
    label: "512 維",
    headline: "中文輕量的實際寬度",
    download: "約 30 MB",
    per_card: "2 KB／張",
    strengths: ["專為中文訓練，短句判斷比多語言 384 維穩", "下載比任何其他選項都小", "CPU 推論負擔很低"],
    limits: ["英文內容的表現不如英文專用模型", "長文的區辨力仍不及 1024 維"],
  },
  {
    dimensions: 1024,
    label: "1024 維",
    headline: "中文語意明顯較準",
    download: "約 570 MB",
    per_card: "4 KB／張",
    strengths: ["中文與多語言關聯品質明顯較好", "支援長文，整段筆記不會被截斷", "跨領域的相似判斷比較穩"],
    limits: ["下載大約是 384 維模型的四倍", "CPU 上每張卡片的處理時間較長", "建議 8 GB 以上記憶體"],
  },
];

/**
 * The models that ship with the app. Anything the user adds by Hugging Face id
 * is merged on top of this at runtime — see customModels().
 */
const MODEL_CATALOG = [
  {
    id: BUILTIN_SUMMARY_MODEL,
    kind: "summary",
    size_tier: "none",
    label: "規則整理",
    short_label: "內建輕量",
    provider: "local-template",
    model_id: null,
    task: "template",
    size_label: "不需下載",
    min_memory_gb: 0,
    tier: "任何硬體",
    languages: "中英文皆可，固定格式",
    description: "不下載模型，使用本機規則快速填入卡片欄位。適合先開始使用。",
    builtin: true,
  },
  {
    id: "summary-lamini-248m",
    kind: "summary",
    size_tier: "small",
    label: "LaMini-Flan-T5 248M",
    short_label: "輕量模型",
    provider: "transformers.js",
    model_id: "Xenova/LaMini-Flan-T5-248M",
    task: "text2text-generation",
    dtype: "q8",
    size_label: "約 180 MB",
    download_size_bytes: 180_000_000,
    min_memory_gb: 8,
    tier: "平衡硬體",
    languages: "中英文可試，短摘要優先",
    description: "比規則整理更能理解句子脈絡，適合 8 GB 以上記憶體的 CPU 本機運算。",
    builtin: false,
  },
  {
    id: "summary-flan-t5-small",
    kind: "summary",
    size_tier: "medium",
    label: "FLAN-T5 Small",
    short_label: "進階模型",
    provider: "transformers.js",
    model_id: "Xenova/flan-t5-small",
    task: "text2text-generation",
    dtype: "q8",
    size_label: "約 260 MB",
    download_size_bytes: 260_000_000,
    min_memory_gb: 12,
    tier: "進階硬體",
    languages: "多語言，中文品質需實測",
    description: "較完整的指令微調模型，能嘗試更自然的摘要與欄位整理；CPU 推論會較慢。",
    builtin: false,
  },
  {
    id: "summary-mt5-small",
    kind: "summary",
    size_tier: "large",
    label: "mT5 Small",
    short_label: "多語言進階",
    provider: "transformers.js",
    model_id: "Xenova/mt5-small",
    task: "text2text-generation",
    dtype: "q8",
    size_label: "約 450 MB",
    download_size_bytes: 450_000_000,
    min_memory_gb: 16,
    tier: "進階硬體",
    languages: "多語言，包含中文",
    description: "以多語言 mT5 為基礎，較適合中文筆記；模型較大，CPU 下載與整理時間也會增加。",
    builtin: false,
  },
  {
    id: BUILTIN_EMBEDDING_MODEL,
    kind: "embedding",
    language: "none",
    label: "Hash 384",
    short_label: "內建輕量",
    provider: "local-runtime",
    model_id: null,
    task: "hash",
    dimensions: 384,
    size_label: "不需下載",
    min_memory_gb: 0,
    tier: "任何硬體",
    languages: "依文字切詞，速度最快",
    description: "內建的 384 維向量，零下載、零等待，適合低規格電腦或離線環境。",
    builtin: true,
  },
  {
    id: "embedding-minilm-384",
    kind: "embedding",
    language: "en",
    label: "all-MiniLM-L6-v2",
    short_label: "英文語意",
    provider: "transformers.js",
    model_id: "Xenova/all-MiniLM-L6-v2",
    task: "feature-extraction",
    dtype: "q8",
    dimensions: 384,
    size_label: "約 90 MB",
    download_size_bytes: 90_000_000,
    min_memory_gb: 4,
    tier: "輕量硬體",
    languages: "英文語意搜尋",
    description: "真正的句向量模型，維持 384 維，適合英文資料與需要較自然語意關聯的收藏。",
    builtin: false,
  },
  {
    id: "embedding-multilingual-384",
    kind: "embedding",
    language: "multi",
    label: "Multilingual MiniLM",
    short_label: "中英語意",
    provider: "transformers.js",
    model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    task: "feature-extraction",
    dtype: "q8",
    dimensions: 384,
    size_label: "約 140 MB",
    download_size_bytes: 140_000_000,
    min_memory_gb: 8,
    tier: "平衡硬體",
    languages: "中文、英文與多語言",
    description: "適合知識卡冊的中英文語意關聯；切換後會重新建立所有卡片的向量與關聯。",
    builtin: false,
  },
  {
    id: "embedding-bge-small-zh-512",
    kind: "embedding",
    language: "zh",
    label: "BGE-Small-ZH",
    short_label: "中文輕量",
    provider: "transformers.js",
    model_id: "Xenova/bge-small-zh-v1.5",
    task: "feature-extraction",
    dtype: "q8",
    // 512, not 384: there is no 384-dim Chinese sentence model with ONNX
    // weights. The whole 384 tier is the MiniLM family, which is English or a
    // multilingual distillation of it — neither is trained on Chinese first.
    dimensions: 512,
    size_label: "約 30 MB",
    download_size_bytes: 30_000_000,
    min_memory_gb: 4,
    tier: "輕量硬體",
    languages: "中文語意搜尋",
    description: "專為中文訓練的輕量句向量模型。下載很小、CPU 也跑得快，是中文收藏在不想下載大模型時的預設選擇。",
    builtin: false,
  },
  {
    id: "embedding-bge-large-zh-1024",
    kind: "embedding",
    language: "zh",
    label: "BGE-Large-ZH",
    short_label: "中文最佳",
    provider: "transformers.js",
    model_id: "Xenova/bge-large-zh-v1.5",
    task: "feature-extraction",
    dtype: "q8",
    dimensions: 1024,
    size_label: "約 330 MB",
    download_size_bytes: 330_000_000,
    min_memory_gb: 8,
    tier: "平衡硬體",
    languages: "中文語意搜尋",
    description: "1024 維、專為中文訓練。純中文收藏的語意關聯品質最好，代價是下載與每張卡片的處理時間都比較長。",
    builtin: false,
  },
  {
    id: "embedding-bge-large-en-1024",
    kind: "embedding",
    language: "en",
    label: "BGE-Large-EN",
    short_label: "英文最佳",
    provider: "transformers.js",
    model_id: "Xenova/bge-large-en-v1.5",
    task: "feature-extraction",
    dtype: "q8",
    dimensions: 1024,
    size_label: "約 330 MB",
    download_size_bytes: 330_000_000,
    min_memory_gb: 8,
    tier: "平衡硬體",
    languages: "英文語意搜尋",
    description: "1024 維、專為英文訓練。英文為主的收藏在需要細緻區辨時用這個。",
    builtin: false,
  },
  {
    id: "embedding-bge-m3-1024",
    kind: "embedding",
    language: "multi",
    label: "BGE-M3",
    short_label: "中英最佳",
    provider: "transformers.js",
    model_id: "Xenova/bge-m3",
    task: "feature-extraction",
    // q8 resolves to model_quantized.onnx (~570 MB) rather than the 2.3 GB
    // fp32 weights — the difference between running on a Raspberry Pi and not.
    dtype: "q8",
    dimensions: 1024,
    size_label: "約 570 MB",
    download_size_bytes: 570_000_000,
    min_memory_gb: 8,
    tier: "平衡硬體",
    languages: "中文、英文與多語言長文",
    description: "1024 維、支援長文的多語言模型，中文語意關聯品質明顯優於 384 維模型。下載較大，切換後會重建所有卡片的向量與關聯。",
    builtin: false,
  },
];

/**
 * The simple picker.
 *
 * Most people do not want to compare four checkpoints; they want "small,
 * medium or large" for tidying, and "which language do I write in" for search.
 * These describe the choice in those terms and resolve to real catalogue
 * entries — the advanced list is still there for anyone who wants to name a
 * model themselves.
 */
const SUMMARY_TIERS = [
  { tier: "none", label: "不下載", headline: "規則整理", note: "用本機規則直接填欄位，零下載、立刻可用。整理結果比較制式。" },
  { tier: "small", label: "小", headline: "約 180 MB", note: "能看懂句子脈絡，適合大多數筆記，CPU 也跑得動。" },
  { tier: "medium", label: "中", headline: "約 260 MB", note: "整理得更自然一些，需要更多記憶體，CPU 上會比較慢。" },
  { tier: "large", label: "大", headline: "約 450 MB", note: "多語言、對中文筆記較友善，但下載與每次整理都最慢。" },
];

/**
 * The two sizes offered, and the widths each accepts.
 *
 * Deliberately a tier rather than a raw dimension. There is no 384-dim Chinese
 * sentence model with ONNX weights — the whole 384 family is MiniLM, which is
 * English or a multilingual distillation — so a "384 維" button could not be
 * honoured for 中文為主 without silently handing back another language's model.
 * The tier is the promise; each card then states the width it actually is.
 */
const EMBEDDING_TIERS = [
  { tier: "light", tier_label: "輕量", dimensions: [384, 512] },
  { tier: "precise", tier_label: "高精度", dimensions: [1024] },
];

const EMBEDDING_LANGUAGES = [
  { language: "zh", label: "中文為主" },
  { language: "en", label: "英文為主" },
  { language: "multi", label: "中英皆可" },
];

/**
 * Which model a (language, dimensions) pair actually resolves to.
 *
 * Built rather than hardcoded so it cannot drift from the catalogue, and it
 * says when a combination has no exact match instead of quietly substituting:
 * there is no 384-dim Chinese-only model here, so "中文為主 + 384" lands on the
 * multilingual one and says so.
 */
function embeddingChoices(models) {
  const rows = [];
  for (const { language, label } of EMBEDDING_LANGUAGES) {
    for (const { tier, tier_label, dimensions } of EMBEDDING_TIERS) {
      const candidates = models.filter((model) => model.kind === "embedding"
        && dimensions.includes(model.dimensions)
        && model.language && model.language !== "none");
      const exact = candidates.find((model) => model.language === language);
      const chosen = exact
        || candidates.find((model) => model.language === "multi")
        || candidates.find((model) => model.language === "zh")
        || candidates[0];
      if (!chosen) continue;
      rows.push({
        language,
        language_label: label,
        tier,
        tier_label,
        dimensions: chosen.dimensions,
        model_id: chosen.id,
        model_label: chosen.label,
        size_label: chosen.size_label,
        exact: Boolean(exact),
        note: exact ? "" : `目前沒有專為${label.replace("為主", "")}訓練的${tier_label}模型，這裡用最接近的「${chosen.label}」。`,
      });
    }
  }
  return rows;
}

/**
 * Presets for the services people actually run, so "bring your own model" does
 * not start with guessing a URL. Ollama and LM Studio both speak the
 * OpenAI-compatible shape, so they need no new request format — only the right
 * endpoint and a way to list what is already installed locally.
 */
const API_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    summary_url: "https://api.openai.com/v1/chat/completions",
    embedding_url: "https://api.openai.com/v1/embeddings",
    api_format: "openai",
    key_required: true,
    note: "需要 API 金鑰，內容會送到 OpenAI。",
  },
  {
    id: "ollama",
    label: "Ollama（本機）",
    summary_url: "http://127.0.0.1:11434/v1/chat/completions",
    embedding_url: "http://127.0.0.1:11434/v1/embeddings",
    api_format: "openai",
    key_required: false,
    note: "在本機執行，內容不會離開這台電腦。請先 ollama pull 你要用的模型。",
  },
  {
    id: "lmstudio",
    label: "LM Studio（本機）",
    summary_url: "http://127.0.0.1:1234/v1/chat/completions",
    embedding_url: "http://127.0.0.1:1234/v1/embeddings",
    api_format: "openai",
    key_required: false,
    note: "在本機執行，需先在 LM Studio 啟動 Local Server。",
  },
  {
    id: "tei",
    label: "Text Embeddings Inference",
    summary_url: "",
    embedding_url: "http://127.0.0.1:8080/embed",
    api_format: "tei",
    key_required: false,
    note: "Hugging Face TEI 伺服器，只提供 embedding。",
  },
  {
    id: "custom",
    label: "其他 OpenAI-compatible 服務",
    summary_url: "",
    embedding_url: "",
    api_format: "openai",
    key_required: false,
    note: "任何相容 OpenAI 格式的服務都可以填在這裡。",
  },
];

const BUNDLED_MODEL_REPOSITORY = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

/**
 * Where the bundled weights live: beside the packaged resources in an installed
 * app, in build/models during development. Returns "" when nothing is bundled,
 * which is what every code path treats as "behave exactly as before".
 */
function bundledModelsDir() {
  const candidates = [
    process.env.KCC_BUNDLED_MODELS_DIR,
    process.resourcesPath ? path.join(process.resourcesPath, "kcc-models") : "",
    path.resolve(__dirname, "..", "build", "models"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, BUNDLED_MODEL_REPOSITORY, "config.json"))) return candidate;
  }
  return "";
}

function directorySize(directory) {
  let total = 0;
  const walk = (current, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath, depth + 1);
      else try { total += fs.statSync(fullPath).size; } catch { /* Vanished mid-scan. */ }
    }
  };
  walk(directory);
  return total;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function customModelId(kind, modelId) {
  return `custom-${kind}-${slugify(modelId)}`;
}

/** A user-added model, shaped exactly like a catalogue entry so nothing downstream cares. */
function describeCustomModel(entry) {
  const isEmbedding = entry.kind === "embedding";
  return {
    id: customModelId(entry.kind, entry.model_id),
    kind: entry.kind,
    label: entry.label || entry.model_id,
    short_label: "自訂",
    provider: "transformers.js",
    model_id: entry.model_id,
    task: isEmbedding ? "feature-extraction" : "text2text-generation",
    dtype: entry.dtype || "q8",
    ...(isEmbedding ? { dimensions: Number(entry.dimensions) || 0 } : {}),
    size_label: entry.size_label || "大小依模型而定",
    download_size_bytes: Number(entry.download_size_bytes) || 0,
    min_memory_gb: 0,
    tier: "自訂",
    languages: entry.languages || "依模型而定",
    description: entry.description || `由 Hugging Face 加入：${entry.model_id}`,
    builtin: false,
    custom: true,
    added_at: entry.added_at || "",
  };
}

/**
 * Ask Hugging Face what a model id actually is before adding it.
 *
 * Two things have to be true for a model to work here: the repository must
 * carry ONNX weights (transformers.js cannot run raw PyTorch), and an embedding
 * model must have a knowable width. Width is not cosmetic — a model whose
 * vectors are a different size than the store's will be rejected at embed time,
 * so it is far kinder to find out now than after a download.
 */
async function lookupHuggingFace(modelId, { timeoutMs = 8000 } = {}) {
  // Not encodeURIComponent: the id is "org/name" and escaping that slash makes
  // the API answer 400 for every namespaced model. Callers validate the shape.
  const repository = String(modelId).split("/").map((part) => encodeURIComponent(part)).join("/");
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`https://huggingface.co/api/models/${repository}`, { signal });
  // Hugging Face answers 401 for a repository that does not exist as well as
  // for one that is private, and it is the same problem either way: this app
  // cannot fetch it.
  if ([401, 403, 404].includes(response.status)) {
    const error = new Error(`Hugging Face 上找不到「${modelId}」，或這是一個非公開的模型`);
    error.code = "MODEL_NOT_FOUND";
    throw error;
  }
  if (!response.ok) throw new Error(`Hugging Face 回應 ${response.status}`);
  const info = await response.json();
  const files = Array.isArray(info?.siblings) ? info.siblings.map((file) => String(file?.rfilename || "")) : [];
  const hasOnnx = files.some((file) => file.toLowerCase().endsWith(".onnx"));

  let dimensions = 0;
  try {
    const configResponse = await fetch(`https://huggingface.co/${repository}/raw/main/config.json`, { signal });
    if (configResponse.ok) {
      const config = await configResponse.json();
      dimensions = Number(config?.hidden_size || config?.d_model || config?.dim || 0);
    }
  } catch {
    // Width stays unknown; the caller decides whether that is fatal.
  }

  return {
    model_id: info?.id || modelId,
    has_onnx: hasOnnx,
    dimensions,
    pipeline_tag: String(info?.pipeline_tag || ""),
    downloads: Number(info?.downloads || 0),
    likes: Number(info?.likes || 0),
  };
}

function hardwareProfile() {
  const memoryGb = os.totalmem() / 1024 ** 3;
  const roundedMemoryGb = Number(memoryGb.toFixed(1));
  if (memoryGb >= 16) {
    return {
      tier: "advanced",
      label: "進階硬體",
      memory_gb: roundedMemoryGb,
      cpu_cores: os.cpus().length,
      recommended_summary: "summary-mt5-small",
      recommended_embedding: "embedding-bge-m3-1024",
      note: "可以嘗試較完整的摘要模型與 1024 維的 BGE-M3。首次下載與重建索引會需要較久時間。",
    };
  }
  if (memoryGb >= 8) {
    return {
      tier: "balanced",
      label: "平衡硬體",
      memory_gb: roundedMemoryGb,
      cpu_cores: os.cpus().length,
      recommended_summary: "summary-lamini-248m",
      recommended_embedding: "embedding-multilingual-384",
      note: "建議使用輕量摘要模型與多語言 embedding，兼顧中文關聯與本機負載。",
    };
  }
  return {
    tier: "light",
    label: "輕量硬體",
    memory_gb: roundedMemoryGb,
    cpu_cores: os.cpus().length,
    recommended_summary: BUILTIN_SUMMARY_MODEL,
    recommended_embedding: BUILTIN_EMBEDDING_MODEL,
    note: "建議先使用內建模式；若要下載模型，請先關閉其他大型應用程式。",
  };
}

function createModelRuntime({ modelsDir, hashEmbedding, templateDraft, apiDimensions = 0 }) {
  const cacheDir = path.join(modelsDir, "transformers-cache");
  const settingsPath = path.join(modelsDir, "settings.json");
  fs.mkdirSync(cacheDir, { recursive: true });

  // Resolved once: whether this build carries embedding weights inside it.
  const bundledDir = bundledModelsDir();
  const isBundled = (model) => Boolean(bundledDir) && model?.id === BUNDLED_EMBEDDING_MODEL;

  // Learned from the first successful custom-API response, or seeded from the
  // width the existing cards already use so a restart keeps the same contract.
  let observedApiDimensions = Number(apiDimensions) || 0;

  const savedSettings = readJson(settingsPath, {});
  const savedCustom = savedSettings.custom && typeof savedSettings.custom === "object" ? savedSettings.custom : {};
  const savedSources = savedSettings.sources && typeof savedSettings.sources === "object" ? savedSettings.sources : {};

  // Falling back to the built-in model is a real downgrade: every vector gets
  // rebuilt at 384 dimensions and semantic search quietly gets worse. It has to
  // be visible, so record it as a model error the settings page can surface.
  // Models the user added by Hugging Face id. They are part of the catalogue
  // from here on, so a selection pointing at one survives a restart.
  const savedCustomModels = Array.isArray(savedSettings.custom_models) ? savedSettings.custom_models : [];
  const customModels = savedCustomModels
    .filter((entry) => entry && (entry.kind === "summary" || entry.kind === "embedding") && entry.model_id)
    .map((entry) => ({ ...entry, model_id: String(entry.model_id) }));

  /** Built-in catalogue plus whatever the user has added. */
  const allModels = () => [...MODEL_CATALOG, ...customModels.map(describeCustomModel)];
  const knows = (id, kind) => allModels().some((model) => model.id === id && model.kind === kind);

  const droppedEmbedding = savedSettings.embedding_model_id
    && !knows(savedSettings.embedding_model_id, "embedding")
    ? String(savedSettings.embedding_model_id)
    : "";
  let settings = {
    version: SETTINGS_VERSION,
    summary_model_id: knows(savedSettings.summary_model_id, "summary")
      ? savedSettings.summary_model_id
      : BUILTIN_SUMMARY_MODEL,
    // A fresh cabinet starts on the bundled semantic model when this build has
    // one. Falling back to the hash embedding by default would mean search and
    // relations are word-overlap until someone changes a setting they have no
    // reason to know about.
    embedding_model_id: knows(savedSettings.embedding_model_id, "embedding")
      ? savedSettings.embedding_model_id
      : bundledModelsDir() ? BUNDLED_EMBEDDING_MODEL : BUILTIN_EMBEDDING_MODEL,
    custom_models: customModels,
    installed: savedSettings.installed && typeof savedSettings.installed === "object" ? savedSettings.installed : {},
    sources: {
      summary: savedSources.summary === "api" ? "api" : "local",
      embedding: savedSources.embedding === "api" ? "api" : "local",
    },
    custom: {
      summary: {
        api_url: String(savedCustom.summary?.api_url || ""),
        api_format: "openai",
        model: String(savedCustom.summary?.model || ""),
        api_key: String(savedCustom.summary?.api_key || ""),
      },
      embedding: {
        api_url: String(savedCustom.embedding?.api_url || ""),
        api_format: savedCustom.embedding?.api_format === "tei" ? "tei" : "openai",
        model: String(savedCustom.embedding?.model || ""),
        api_key: String(savedCustom.embedding?.api_key || ""),
      },
    },
  };
  writeJson(settingsPath, settings);

  const hardware = hardwareProfile();
  const pipelinePromises = new Map();
  const downloadPromises = new Map();
  const operationStates = new Map();
  const modelErrors = new Map();
  if (droppedEmbedding) {
    modelErrors.set("embedding-fallback", `找不到先前選用的 embedding 模型「${droppedEmbedding}」，已暫時改用內建模型。重新選擇模型即可恢復語意品質。`);
  }
  let transformersPromise;

  function findModel(id) {
    return allModels().find((model) => model.id === id);
  }

  /**
   * Add a Hugging Face model to the catalogue.
   *
   * The repository is checked before it is accepted: transformers.js can only
   * run ONNX weights, and an embedding model has to declare a width, because a
   * vector of the wrong size is refused at embed time and would otherwise only
   * fail after a long download.
   */
  async function addCustomModel({ kind, model_id: modelId, label = "", dimensions = 0 }) {
    if (kind !== "summary" && kind !== "embedding") throw new Error("模型類型必須是 summary 或 embedding");
    const trimmed = String(modelId || "").trim().replace(/^https?:\/\/huggingface\.co\//u, "").replace(/\/+$/u, "");
    if (!/^[\w.-]+\/[\w.-]+$/u.test(trimmed)) throw new Error("請填入 Hugging Face 模型 id，格式為「作者/模型名稱」");
    const id = customModelId(kind, trimmed);
    if (findModel(id)) throw new Error("這個模型已經在清單裡了");
    if (MODEL_CATALOG.some((model) => model.model_id === trimmed && model.kind === kind)) {
      throw new Error("這個模型已經內建在清單裡了");
    }

    let resolved = { has_onnx: true, dimensions: Number(dimensions) || 0, pipeline_tag: "" };
    let checked = false;
    try {
      resolved = await lookupHuggingFace(trimmed);
      checked = true;
    } catch (error) {
      if (error?.code === "MODEL_NOT_FOUND") throw error;
      // Offline or Hugging Face unreachable: fall back to what the caller
      // supplied rather than blocking someone who already knows the model.
      if (kind === "embedding" && !Number(dimensions)) {
        throw new Error("目前無法連線到 Hugging Face 確認模型維度，請手動填入向量維度後再加入");
      }
    }

    if (checked && !resolved.has_onnx) {
      throw new Error("這個模型沒有 ONNX 權重，本機 runtime 無法執行。請改用標題有 ONNX／transformers.js 支援的版本（例如 Xenova 或 onnx-community 的轉檔）。");
    }
    const width = Number(dimensions) || Number(resolved.dimensions) || 0;
    if (kind === "embedding" && !width) {
      throw new Error("無法判斷這個模型的向量維度，請手動填入後再加入");
    }

    const entry = {
      kind,
      model_id: trimmed,
      label: String(label || "").trim() || trimmed.split("/").pop(),
      dimensions: kind === "embedding" ? width : 0,
      languages: resolved.pipeline_tag ? `Hugging Face · ${resolved.pipeline_tag}` : "依模型而定",
      added_at: new Date().toISOString(),
    };
    customModels.push(entry);
    settings.custom_models = customModels;
    saveSettings();
    return describeModel(describeCustomModel(entry));
  }

  function removeCustomModel(id) {
    const index = customModels.findIndex((entry) => customModelId(entry.kind, entry.model_id) === id);
    if (index < 0) throw new Error("找不到這個自訂模型");
    const entry = customModels[index];
    if (settings.sources[entry.kind] === "local" && getActive(entry.kind).id === id) {
      throw new Error("目前使用中的模型不能移除，請先切換到其他模型");
    }
    // Cached weights go too, otherwise removing a model leaves its download behind.
    try { removeModel(id); } catch { /* Nothing cached yet, or already gone. */ }
    customModels.splice(index, 1);
    settings.custom_models = customModels;
    delete settings.installed[id];
    saveSettings();
    return { removed: id };
  }

  /**
   * Ask an OpenAI-compatible service what it can offer, so people can pick a
   * model name from a list instead of typing one and hoping. Ollama is tried
   * through its native endpoint too, because older builds do not serve /v1.
   */
  async function probeApi({ api_url: apiUrl, api_key: apiKey = "" }) {
    const trimmed = String(apiUrl || "").trim();
    if (!/^https?:\/\//u.test(trimmed)) throw new Error("API 位址必須使用 http:// 或 https://");
    const base = trimmed.replace(/\/(chat\/completions|completions|embeddings|embed)\/?$/u, "");
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const attempts = [
      { url: `${base}/models`, pick: (payload) => (payload?.data || []).map((model) => String(model?.id || "")) },
      { url: `${base.replace(/\/v1$/u, "")}/api/tags`, pick: (payload) => (payload?.models || []).map((model) => String(model?.name || "")) },
    ];

    let lastDetail = "";
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.url, { headers, signal: AbortSignal.timeout(6000) });
        if (!response.ok) {
          lastDetail = `${attempt.url} 回應 ${response.status}`;
          continue;
        }
        const models = attempt.pick(await response.json()).filter(Boolean).sort();
        return { ok: true, endpoint: attempt.url, models, detail: models.length ? "" : "服務有回應，但沒有列出任何模型" };
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : String(error);
      }
    }
    return { ok: false, endpoint: "", models: [], detail: lastDetail || "無法連線到這個服務" };
  }

  /**
   * Ask an embedding API how wide its vectors actually are, by embedding one
   * short string and counting what comes back.
   *
   * There is no other way to know. An OpenAI-compatible service does not
   * advertise its width anywhere — `/models` lists names, not shapes — so
   * before this existed the width was discovered on the first real card and
   * enforced only from then on. Getting it wrong is not a small error: a
   * library built at one width cannot be compared against vectors of another,
   * so the choice has to be checkable *before* it is saved.
   */
  async function probeApiEmbedding({ api_url: apiUrl, api_key: apiKey = "", model = "", api_format: apiFormat = "openai" }) {
    const endpoint = String(apiUrl || "").trim();
    if (!/^https?:\/\//u.test(endpoint)) throw new Error("API 位址必須使用 http:// 或 https://");
    // A blank key in the draft means "keep using the saved one", the same way
    // saving does — otherwise probing would fail on every already-configured
    // service the moment the user reopens the form.
    const key = String(apiKey || "") || settings.custom.embedding.api_key || "";
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const probeText = "知識卡冊維度測試 dimension probe";
    const body = apiFormat === "tei" ? { inputs: [probeText] } : { model: String(model || ""), input: probeText };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const detail = await response.text().then((text) => text.slice(0, 300)).catch(() => "");
        return { ok: false, dimensions: 0, detail: `服務回應 ${response.status}${detail ? `：${detail}` : ""}` };
      }
      const payload = await response.json();
      const vector = apiFormat === "tei" ? payload?.[0] : payload?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        return { ok: false, dimensions: 0, detail: "服務有回應，但沒有回傳向量。請確認位址是 embeddings 端點，以及回傳格式選對了。" };
      }
      if (vector.some((value) => !Number.isFinite(Number(value)))) {
        return { ok: false, dimensions: 0, detail: "回傳的向量含有非數字內容。" };
      }
      return { ok: true, dimensions: vector.length, detail: "" };
    } catch (error) {
      return { ok: false, dimensions: 0, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  function getActive(kind) {
    const id = kind === "summary" ? settings.summary_model_id : settings.embedding_model_id;
    return findModel(id) || findModel(kind === "summary" ? BUILTIN_SUMMARY_MODEL : BUILTIN_EMBEDDING_MODEL);
  }

  function isInstalled(model) {
    // Bundled weights are already on disk, so the model is ready without ever
    // having been "downloaded".
    return Boolean(model?.builtin || isBundled(model) || settings.installed[model?.id]);
  }

  function humanSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  function modelPathTokens(model) {
    return [
      String(model.model_id || "").replaceAll("/", "--").toLowerCase(),
      String(model.model_id || "").toLowerCase(),
    ].filter(Boolean);
  }

  function inspectModel(modelId) {
    const model = findModel(modelId);
    if (!model) throw new Error("找不到指定模型");
    if (model.builtin) {
      return { model_id: modelId, status: "ready", installed: true, files: 0, bytes: 0, size_label: "不需下載", download_size_bytes: 0, resumable: false };
    }
    if (isBundled(model)) {
      const bytes = directorySize(path.join(bundledDir, BUNDLED_MODEL_REPOSITORY));
      return { model_id: modelId, status: "ready", installed: true, files: 0, bytes, size_label: `${humanSize(bytes)}（隨應用程式安裝）`, download_size_bytes: 0, resumable: false };
    }
    const tokens = modelPathTokens(model);
    let files = 0;
    let bytes = 0;
    const matchingRoots = new Set();
    const walk = (directory, depth = 0) => {
      if (depth > 8 || files > 50000) return;
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const normalized = fullPath.replaceAll("\\", "/").toLowerCase();
        const matches = tokens.some((token) => normalized.includes(token));
        if (entry.isDirectory()) {
          if (matches) matchingRoots.add(fullPath);
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && matches) {
          files += 1;
          try { bytes += fs.statSync(fullPath).size; } catch { /* File changed while scanning. */ }
        }
      }
    };
    walk(cacheDir);
    const installed = isInstalled(model);
    const status = installed && files > 0 ? "ready" : files > 0 ? "partial" : "missing";
    return {
      model_id: modelId,
      status,
      installed: installed && status === "ready",
      files,
      bytes,
      size_label: bytes ? humanSize(bytes) : "尚未建立快取",
      download_size_bytes: Number(model.download_size_bytes || 0),
      resumable: true,
      cache_entries: matchingRoots.size,
    };
  }

  function storageInfo() {
    try {
      const stats = fs.statfsSync(cacheDir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      return { path_label: "模型快取所在磁碟", free_bytes: freeBytes, free_size_label: humanSize(freeBytes), total_bytes: totalBytes, total_size_label: humanSize(totalBytes) };
    } catch {
      return { path_label: "模型快取所在磁碟", free_bytes: 0, free_size_label: "無法讀取", total_bytes: 0, total_size_label: "無法讀取" };
    }
  }

  function removeModel(modelId) {
    const model = findModel(modelId);
    if (!model) throw new Error("找不到指定模型");
    if (model.builtin) throw new Error("內建模型沒有可清理的檔案");
    if (isBundled(model)) throw new Error("這個模型隨應用程式一起安裝，沒有可清理的快取");
    if (settings.sources[model.kind] === "local" && getActive(model.kind).id === modelId) throw new Error("目前使用中的模型不能清理，請先切換到其他模型");
    if (downloadPromises.has(modelId)) throw new Error("模型仍在下載中，請先取消下載任務");
    const tokens = modelPathTokens(model);
    let entries = [];
    try { entries = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { /* Cache directory may not exist yet. */ }
    for (const entry of entries) {
      const fullPath = path.join(cacheDir, entry.name);
      const normalized = fullPath.replaceAll("\\", "/").toLowerCase();
      if (tokens.some((token) => normalized.includes(token))) fs.rmSync(fullPath, { recursive: true, force: true });
    }
    delete settings.installed[modelId];
    modelErrors.delete(modelId);
    operationStates.delete(modelId);
    saveSettings();
    return inspectModel(modelId);
  }

  async function getTransformers() {
    if (!transformersPromise) {
      transformersPromise = Promise.resolve().then(() => {
        const packagedModulePath = path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "@huggingface",
          "transformers",
          "dist",
          "transformers.node.cjs",
        );
        const isPackaged = __dirname.endsWith("app.asar") && fs.existsSync(packagedModulePath);
        if (isPackaged) {
          const packagedNodeModulesPath = path.join(process.resourcesPath, "app.asar", "node_modules");
          process.env.NODE_PATH = [packagedNodeModulesPath, process.env.NODE_PATH]
            .filter(Boolean)
            .join(path.delimiter);
          Module._initPaths();
        }
        const transformersModule = isPackaged ? require(packagedModulePath) : require("@huggingface/transformers");
        transformersModule.env.cacheDir = cacheDir;
        if (bundledDir) {
          // Weights that ship with the app are read straight from disk; anything
          // else still resolves remotely and lands in the cache as before.
          transformersModule.env.localModelPath = bundledDir;
          transformersModule.env.allowLocalModels = true;
        }
        transformersModule.env.allowRemoteModels = true;
        transformersModule.env.useFSCache = true;
        transformersModule.env.useWasmCache = true;
        return transformersModule;
      });
    }
    return transformersPromise;
  }

  async function loadPipeline(model) {
    if (model.builtin) throw new Error("內建模型不需要載入 pipeline");
    if (pipelinePromises.has(model.id)) return pipelinePromises.get(model.id);

    const pipelinePromise = getTransformers()
      .then(({ pipeline }) => pipeline(model.task, model.model_id, { dtype: model.dtype || "q8" }))
      .catch((error) => {
        pipelinePromises.delete(model.id);
        throw error;
      });
    pipelinePromises.set(model.id, pipelinePromise);
    return pipelinePromise;
  }

  function saveSettings() {
    writeJson(settingsPath, settings);
  }

  function setOperation(modelId, status) {
    operationStates.set(modelId, { status, updated_at: new Date().toISOString() });
  }

  async function download(modelId) {
    const model = findModel(modelId);
    if (!model) throw new Error("找不到指定模型");
    if (model.builtin) return describeModel(model);
    if (downloadPromises.has(model.id)) return downloadPromises.get(model.id);

    setOperation(model.id, "downloading");
    modelErrors.delete(model.id);
    const promise = (async () => {
      try {
        await loadPipeline(model);
        settings.installed[model.id] = { installed_at: new Date().toISOString(), model_id: model.model_id };
        saveSettings();
        setOperation(model.id, "ready");
        return describeModel(model);
      } catch (error) {
        operationStates.delete(model.id);
        modelErrors.set(model.id, error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        downloadPromises.delete(model.id);
      }
    })();
    downloadPromises.set(model.id, promise);
    return promise;
  }

  function describeModel(model) {
    const active = settings.sources[model.kind] === "local" && getActive(model.kind).id === model.id;
    const operation = operationStates.get(model.id);
    const installed = isInstalled(model);
    const error = modelErrors.get(model.id) || "";
    const loweredError = error.toLowerCase();
    const errorCode = loweredError.includes("space") ? "DISK_FULL" : loweredError.includes("onnx") || loweredError.includes("runtime") ? "RUNTIME" : loweredError.includes("network") || loweredError.includes("fetch") ? "NETWORK" : error ? "MODEL_LOAD" : "";
    const errorHint = errorCode === "DISK_FULL" ? "請清理模型檔案或釋放磁碟空間後重試。" : errorCode === "NETWORK" ? "下載中斷時會保留既有快取；確認網路後可直接重試。" : errorCode === "RUNTIME" ? "模型檔案可能與目前 runtime 不相容，請先檢查檔案或清理後重試。" : error ? "請檢查模型檔案；若仍失敗，可清理後重新下載。" : "";
    return {
      ...model,
      active,
      installed,
      recommended: hardware.recommended_summary === model.id || hardware.recommended_embedding === model.id,
      bundled: isBundled(model),
      status: operation?.status || (installed ? "ready" : "available"),
      error,
      error_code: errorCode,
      error_hint: errorHint,
      storage: inspectModel(model.id),
    };
  }

  function catalog() {
    return {
      hardware,
      active: {
        summary: getActive("summary").id,
        embedding: getActive("embedding").id,
      },
      active_source: { ...settings.sources },
      storage: storageInfo(),
      models: allModels().map(describeModel),
      dimension_guide: DIMENSION_GUIDE,
      api_providers: API_PROVIDERS,
      simple: {
        summary: SUMMARY_TIERS.map((tier) => {
          const model = allModels().find((candidate) => candidate.kind === "summary" && candidate.size_tier === tier.tier);
          return model ? { ...tier, model_id: model.id, model_label: model.label, size_label: model.size_label } : null;
        }).filter(Boolean),
        embedding: embeddingChoices(allModels()),
      },
    };
  }

  async function select(kind, modelId) {
    if (kind !== "summary" && kind !== "embedding") throw new Error("模型類型必須是 summary 或 embedding");
    const model = findModel(modelId);
    if (!model || model.kind !== kind) throw new Error("找不到符合類型的模型");
    if (!isInstalled(model)) {
      const error = new Error("請先下載模型，再啟用它");
      error.code = "MODEL_NOT_INSTALLED";
      throw error;
    }
    const previous = getActive(kind).id;
    const previousSource = settings.sources[kind];
    // Switching to a local model retires whatever width the custom API used.
    if (kind === "embedding") observedApiDimensions = 0;
    settings.sources[kind] = "local";
    if (kind === "summary") settings.summary_model_id = model.id;
    else settings.embedding_model_id = model.id;
    saveSettings();
    return {
      previous,
      current: model.id,
      previous_source: previousSource,
      current_source: "local",
      changed: previous !== model.id || previousSource !== "local",
      model: describeModel(model),
    };
  }

  function validateCustom(kind, payload) {
    const source = String(payload?.source || "local").trim().toLowerCase();
    const apiUrl = String(payload?.api_url || "").trim();
    const apiFormat = String(payload?.api_format || "openai").trim().toLowerCase();
    const model = String(payload?.model || "").trim();
    if (source !== "local" && source !== "api") throw new Error(`${kind} source 必須是 local 或 api`);
    if (source === "api") {
      if (!/^https?:\/\//u.test(apiUrl)) throw new Error(`${kind} API 位址必須使用 http:// 或 https://`);
      if (!model) throw new Error(`${kind} API 必須填寫模型名稱`);
      if (kind === "summary" && apiFormat !== "openai") throw new Error("摘要 API 目前只支援 OpenAI-compatible 格式");
      if (kind === "embedding" && !["openai", "tei"].includes(apiFormat)) throw new Error("embedding API 格式必須是 openai 或 tei");
    }
    return { api_url: apiUrl, api_format: apiFormat, model };
  }

  function settingsView() {
    return {
      summary: {
        source: settings.sources.summary,
        provider: settings.sources.summary === "api" ? "api-openai" : "local",
        api_url: settings.custom.summary.api_url,
        api_format: settings.custom.summary.api_format,
        model: settings.custom.summary.model,
        api_key_set: Boolean(settings.custom.summary.api_key),
      },
      embedding: {
        source: settings.sources.embedding,
        provider: settings.sources.embedding === "api" ? (settings.custom.embedding.api_format === "tei" ? "api-tei" : "api-openai") : "local",
        api_url: settings.custom.embedding.api_url,
        api_format: settings.custom.embedding.api_format,
        model: settings.custom.embedding.model,
        api_key_set: Boolean(settings.custom.embedding.api_key),
        dimensions: expectedEmbeddingDimensions(),
      },
    };
  }

  function settingsState() {
    return JSON.parse(JSON.stringify({ sources: settings.sources, custom: settings.custom }));
  }

  function restoreSettingsState(state) {
    settings.sources = JSON.parse(JSON.stringify(state.sources));
    settings.custom = JSON.parse(JSON.stringify(state.custom));
    saveSettings();
  }

  function updateSettings(payload) {
    const previous = settingsState();
    const nextCustom = {};
    for (const kind of ["summary", "embedding"]) {
      const input = payload?.[kind] || {};
      const validated = validateCustom(kind, input);
      const old = settings.custom[kind];
      let apiKey = String(input.api_key || "").trim();
      if (input.clear_api_key) apiKey = "";
      else if (!apiKey) apiKey = old.api_key;
      nextCustom[kind] = { ...validated, api_key: apiKey };
    }
    settings.sources = {
      summary: payload.summary.source,
      embedding: payload.embedding.source,
    };
    settings.custom = nextCustom;
    const previousEmbedding = { ...previous.custom.embedding };
    const nextEmbedding = { ...settings.custom.embedding };
    delete previousEmbedding.api_key;
    delete nextEmbedding.api_key;
    const embeddingChanged = previous.sources.embedding !== settings.sources.embedding
      || JSON.stringify(previousEmbedding) !== JSON.stringify(nextEmbedding);
    // Pointing at a different embedding API means the width recorded from the
    // old one no longer applies; the caller rebuilds every vector after this,
    // so the next response is free to set a new one.
    if (embeddingChanged) observedApiDimensions = 0;
    saveSettings();
    return { embedding_changed: embeddingChanged, settings: settingsView() };
  }

  async function requestApi(kind, text) {
    const config = settings.custom[kind];
    const headers = { "Content-Type": "application/json" };
    if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;
    const body = kind === "embedding"
      ? (config.api_format === "tei" ? { inputs: [text] } : { model: config.model, input: text })
      : {
        model: config.model,
        messages: [
          { role: "system", content: "你是知識卡編輯助手。只根據輸入內容，直接輸出包含 topic、title、question、summary、analogy、detail、tags 的 JSON 物件。所有欄位是字串，tags 是字串陣列。" },
          { role: "user", content: `請把以下筆記整理成一張繁體中文知識卡。\n\n${text}` },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      };
    let response = await fetch(config.api_url, { method: "POST", headers, body: JSON.stringify(body) });
    if (kind === "summary" && response.status === 400) {
      const fallbackBody = { ...body };
      delete fallbackBody.response_format;
      response = await fetch(config.api_url, { method: "POST", headers, body: JSON.stringify(fallbackBody) });
    }
    if (!response.ok) throw new Error(`API 回應 ${response.status}`);
    return response.json();
  }

  /**
   * Width every vector in the store is expected to have right now.
   *
   * A custom API does not announce its width, so the first successful response
   * sets it and later ones must agree — otherwise swapping the API behind the
   * app's back would quietly mix incompatible vectors together.
   */
  function expectedEmbeddingDimensions() {
    if (settings.sources.embedding === "api") return observedApiDimensions;
    const model = getActive("embedding");
    return model.builtin ? HASH_EMBEDDING_DIMENSIONS : Number(model.dimensions || 0);
  }

  /**
   * The hash embedding is a different *kind* of vector, not a smaller one:
   * mixing it into a store built by a real model produces similarity scores
   * that look plausible and mean nothing. So it is only ever an acceptable
   * substitute when it is already the active embedding.
   */
  function fallbackOrThrow(text, error, allowFallback) {
    const expected = expectedEmbeddingDimensions();
    if (allowFallback && expected === HASH_EMBEDDING_DIMENSIONS && settings.sources.embedding !== "api") {
      return hashEmbedding(text, HASH_EMBEDDING_DIMENSIONS);
    }
    throw error;
  }

  async function embed(text, { allowFallback = true } = {}) {
    if (settings.sources.embedding === "api") {
      try {
        const payload = await requestApi("embedding", String(text || ""));
        const vector = settings.custom.embedding.api_format === "tei"
          ? payload?.[0]
          : payload?.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length === 0) throw new Error("embedding API 沒有回傳向量");
        if (observedApiDimensions && vector.length !== observedApiDimensions) {
          throw new Error(`embedding 維度不符：取得 ${vector.length}，此資料庫使用 ${observedApiDimensions}`);
        }
        const numeric = vector.map(Number);
        if (numeric.some((value) => !Number.isFinite(value))) throw new Error("embedding 回傳了非數字內容");
        observedApiDimensions = numeric.length;
        return numeric;
      } catch (error) {
        modelErrors.set("custom-embedding", error instanceof Error ? error.message : String(error));
        return fallbackOrThrow(text, error, allowFallback);
      }
    }
    const model = getActive("embedding");
    if (model.builtin) return hashEmbedding(text, HASH_EMBEDDING_DIMENSIONS);
    try {
      const extractor = await loadPipeline(model);
      const output = await extractor(String(text || ""), { pooling: "mean", normalize: true });
      const vector = Array.from(output?.data || []);
      if (vector.length !== model.dimensions) throw new Error(`embedding 維度不符：取得 ${vector.length}，預期 ${model.dimensions}`);
      return vector;
    } catch (error) {
      modelErrors.set(model.id, error instanceof Error ? error.message : String(error));
      return fallbackOrThrow(text, error, allowFallback);
    }
  }

  function parseDraftOutput(generated, content, source) {
    const fallback = templateDraft(content, source);
    const lines = String(generated || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const normalizedGenerated = String(generated || "").replace(/[\s\p{P}\p{S}]+/gu, "").trim();
    const isChineseInput = /[\u4e00-\u9fff]/u.test(String(content || ""));
    const isUsableGenerated = normalizedGenerated.length >= 12 && (!isChineseInput || /[\u4e00-\u9fff]/u.test(String(generated || "")));
    const readField = (labels) => {
      const line = lines.find((item) => labels.some((label) => item.toLowerCase().startsWith(`${label.toLowerCase()}：`) || item.toLowerCase().startsWith(`${label.toLowerCase()}:`)));
      if (!line) return "";
      return line.replace(/^[^：:]+[：:]/u, "").trim();
    };
    const tags = readField(["標籤", "tags"])
      .split(/[、,，]/u)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8);
    return {
      topic: readField(["主題", "topic"]) || fallback.topic,
      title: readField(["標題", "title"]) || fallback.title,
      question: readField(["問題", "question"]) || fallback.question,
      summary: readField(["摘要", "summary"]) || (isUsableGenerated ? String(generated).slice(0, 260) : fallback.summary),
      analogy: readField(["比喻", "類比", "analogy"]) || fallback.analogy,
      detail: readField(["細節", "detail"]) || fallback.detail,
      source: fallback.source,
      tags: tags.length > 0 ? tags : fallback.tags,
    };
  }

  function parseApiDraft(payload, content, source) {
    const raw = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(raw) ? raw.map((part) => typeof part === "string" ? part : part?.text || "").join("") : String(raw || "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("摘要 API 沒有回傳可解析的 JSON");
    const value = JSON.parse(text.slice(start, end + 1));
    const fallback = templateDraft(content, source);
    const read = (key) => String(value?.[key] || fallback[key] || "").trim();
    const tags = Array.isArray(value?.tags) ? value.tags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 5) : fallback.tags;
    return {
      topic: read("topic"),
      title: read("title"),
      question: read("question"),
      summary: read("summary"),
      analogy: read("analogy"),
      detail: read("detail"),
      source: fallback.source,
      tags,
    };
  }

  async function draft(content, source) {
    if (settings.sources.summary === "api") {
      const payload = await requestApi("summary", String(content || ""));
      return { draft: parseApiDraft(payload, content, source), model: settings.custom.summary.model };
    }
    const model = getActive("summary");
    if (model.builtin) return { draft: templateDraft(content, source), model: model.label };
    try {
      const generator = await loadPipeline(model);
      const prompt = [
        "整理以下筆記，請只輸出六行，每行一個欄位。",
        "標題：短標題",
        "問題：一個值得用自己的話回答的問題",
        "摘要：一句話說清楚核心",
        "比喻：一個生活化比喻",
        "細節：補充機制或限制",
        "標籤：最多三個關鍵字",
        `筆記：${String(content).slice(0, 3000)}`,
      ].join("\n");
      const output = await generator(prompt, { max_new_tokens: 180, do_sample: false });
      const generated = output?.[0]?.generated_text || "";
      return { draft: parseDraftOutput(generated, content, source), model: model.label };
    } catch (error) {
      modelErrors.set(model.id, error instanceof Error ? error.message : String(error));
      return { draft: templateDraft(content, source), model: `${model.label}（失敗後改用內建整理）` };
    }
  }

  function health() {
    const summary = getActive("summary");
    const embedding = getActive("embedding");
    const customEmbedding = settings.custom.embedding;
    const customSummary = settings.custom.summary;
    return {
      embedding_model: settings.sources.embedding === "api" ? customEmbedding.model : embedding.id,
      embedding_provider: settings.sources.embedding === "api" ? (customEmbedding.api_format === "tei" ? "api-tei" : "api-openai") : embedding.provider,
      embedding_dimensions: expectedEmbeddingDimensions(),
      semantic_mode: settings.sources.embedding === "api" || !embedding.builtin,
      summary_provider: settings.sources.summary === "api" ? "api-openai" : summary.provider,
      summary_model: settings.sources.summary === "api" ? customSummary.model : summary.id,
      summary_status: settings.sources.summary === "api" ? "ready" : describeModel(summary).status,
      model_error: modelErrors.get("embedding-fallback") || modelErrors.get("custom-embedding") || modelErrors.get(summary.id) || modelErrors.get(embedding.id) || "",
    };
  }

  return {
    catalog,
    inspect: inspectModel,
    remove: removeModel,
    addCustomModel,
    removeCustomModel,
    probeApi,
    probeApiEmbedding,
    download,
    select,
    embed,
    draft,
    settings: settingsView,
    updateSettings,
    settingsState,
    restoreSettingsState,
    health,
    expectedEmbeddingDimensions,
    getActive: (kind) => getActive(kind),
    activeEmbeddingModelId: () => settings.sources.embedding === "api" ? `custom-api:${settings.custom.embedding.model}` : getActive("embedding").id,
    activeSummaryModelId: () => settings.sources.summary === "api" ? `custom-api:${settings.custom.summary.model}` : getActive("summary").id,
  };
}

module.exports = {
  API_PROVIDERS,
  EMBEDDING_LANGUAGES,
  EMBEDDING_TIERS,
  SUMMARY_TIERS,
  embeddingChoices,
  BUILTIN_EMBEDDING_MODEL,
  BUILTIN_SUMMARY_MODEL,
  DIMENSION_GUIDE,
  MODEL_CATALOG,
  createModelRuntime,
  lookupHuggingFace,
};
