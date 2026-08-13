const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const BUILTIN_SUMMARY_MODEL = "summary-template";
const BUILTIN_EMBEDDING_MODEL = "embedding-hash-384";
const EMBEDDING_DIMENSIONS = 384;
const SETTINGS_VERSION = 1;

const MODEL_CATALOG = [
  {
    id: BUILTIN_SUMMARY_MODEL,
    kind: "summary",
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
];

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
      recommended_embedding: "embedding-multilingual-384",
      note: "可以嘗試較完整的摘要模型與多語言 embedding。首次下載與重建索引會需要較久時間。",
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

function createModelRuntime({ modelsDir, hashEmbedding, templateDraft }) {
  const cacheDir = path.join(modelsDir, "transformers-cache");
  const settingsPath = path.join(modelsDir, "settings.json");
  fs.mkdirSync(cacheDir, { recursive: true });

  const savedSettings = readJson(settingsPath, {});
  const savedCustom = savedSettings.custom && typeof savedSettings.custom === "object" ? savedSettings.custom : {};
  const savedSources = savedSettings.sources && typeof savedSettings.sources === "object" ? savedSettings.sources : {};
  let settings = {
    version: SETTINGS_VERSION,
    summary_model_id: MODEL_CATALOG.some((model) => model.id === savedSettings.summary_model_id && model.kind === "summary")
      ? savedSettings.summary_model_id
      : BUILTIN_SUMMARY_MODEL,
    embedding_model_id: MODEL_CATALOG.some((model) => model.id === savedSettings.embedding_model_id && model.kind === "embedding")
      ? savedSettings.embedding_model_id
      : BUILTIN_EMBEDDING_MODEL,
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
  let transformersPromise;

  function findModel(id) {
    return MODEL_CATALOG.find((model) => model.id === id);
  }

  function getActive(kind) {
    const id = kind === "summary" ? settings.summary_model_id : settings.embedding_model_id;
    return findModel(id) || findModel(kind === "summary" ? BUILTIN_SUMMARY_MODEL : BUILTIN_EMBEDDING_MODEL);
  }

  function isInstalled(model) {
    return Boolean(model?.builtin || settings.installed[model?.id]);
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
      models: MODEL_CATALOG.map(describeModel),
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
        dimensions: EMBEDDING_DIMENSIONS,
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

  async function embed(text, { allowFallback = true } = {}) {
    if (settings.sources.embedding === "api") {
      try {
        const payload = await requestApi("embedding", String(text || ""));
        const vector = settings.custom.embedding.api_format === "tei"
          ? payload?.[0]
          : payload?.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`embedding 維度不符：取得 ${vector?.length || 0}，預期 ${EMBEDDING_DIMENSIONS}`);
        }
        const numeric = vector.map(Number);
        if (numeric.some((value) => !Number.isFinite(value))) throw new Error("embedding 回傳了非數字內容");
        return numeric;
      } catch (error) {
        modelErrors.set("custom-embedding", error instanceof Error ? error.message : String(error));
        if (!allowFallback) throw error;
        return hashEmbedding(text);
      }
    }
    const model = getActive("embedding");
    if (model.builtin) return hashEmbedding(text);
    try {
      const extractor = await loadPipeline(model);
      const output = await extractor(String(text || ""), { pooling: "mean", normalize: true });
      const vector = Array.from(output?.data || []);
      if (vector.length !== model.dimensions) throw new Error(`embedding 維度不符：取得 ${vector.length}，預期 ${model.dimensions}`);
      return vector;
    } catch (error) {
      modelErrors.set(model.id, error instanceof Error ? error.message : String(error));
      if (!allowFallback) throw error;
      return hashEmbedding(text);
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
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      semantic_mode: settings.sources.embedding === "api" || !embedding.builtin,
      summary_provider: settings.sources.summary === "api" ? "api-openai" : summary.provider,
      summary_model: settings.sources.summary === "api" ? customSummary.model : summary.id,
      summary_status: settings.sources.summary === "api" ? "ready" : describeModel(summary).status,
      model_error: modelErrors.get("custom-embedding") || modelErrors.get(summary.id) || modelErrors.get(embedding.id) || "",
    };
  }

  return {
    catalog,
    inspect: inspectModel,
    remove: removeModel,
    download,
    select,
    embed,
    draft,
    settings: settingsView,
    updateSettings,
    settingsState,
    restoreSettingsState,
    health,
    getActive: (kind) => getActive(kind),
    activeEmbeddingModelId: () => settings.sources.embedding === "api" ? `custom-api:${settings.custom.embedding.model}` : getActive("embedding").id,
    activeSummaryModelId: () => settings.sources.summary === "api" ? `custom-api:${settings.custom.summary.model}` : getActive("summary").id,
  };
}

module.exports = {
  BUILTIN_EMBEDDING_MODEL,
  BUILTIN_SUMMARY_MODEL,
  MODEL_CATALOG,
  createModelRuntime,
};
