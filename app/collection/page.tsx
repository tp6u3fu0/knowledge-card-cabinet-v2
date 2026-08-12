"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent, type WheelEvent } from "react";
import { SeededCoverArt, type CoverMotif } from "../cover-art";

type KnowledgeCard = {
  id: string;
  number: string;
  topic: string;
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
};

type CoverSpec = {
  version: number;
  seed: string;
  pattern: string;
  accent: string;
  color: string;
  soft_color: string;
  background: string;
  rotation: number;
  scale: number;
  density: number;
  orbit: number;
  motifs?: CoverMotif[];
};

type ApiCard = {
  id: string;
  number: string;
  topic: string;
  title: string;
  question?: string;
  summary?: string;
  analogy?: string;
  detail?: string;
  source?: string;
  tags?: string[];
  cover?: CoverSpec | null;
};

type ApiRelation = {
  relation_type: string;
  score: number;
  status: string;
  card: ApiCard;
};

type TrashCard = ApiCard & {
  deleted_at?: string | null;
};

type CardDraft = {
  id: string;
  number: string;
  topic: string;
  title: string;
  question: string;
  summary: string;
  analogy: string;
  detail: string;
  source: string;
  tags: string;
};

type CardDraftResponse = {
  detail?: string;
  model?: string;
  draft?: {
    topic?: string;
    title?: string;
    question?: string;
    summary?: string;
    analogy?: string;
    detail?: string;
    tags?: string[];
  };
};

type ModelKind = "summary" | "embedding";

type ModelOption = {
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
  active: boolean;
  installed: boolean;
  recommended: boolean;
  status: "available" | "downloading" | "ready";
  error?: string;
};

type ModelCatalog = {
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
  models: ModelOption[];
};

type ProviderSetting = {
  source: "local" | "api";
  provider: string;
  api_url: string;
  api_format: "openai" | "tei";
  model: string;
  api_key_set: boolean;
  dimensions?: number;
};

type RuntimeSettings = {
  summary: ProviderSetting;
  embedding: ProviderSetting;
};

type ProviderSettingsDraft = {
  source: "local" | "api";
  api_url: string;
  model: string;
  api_format: "openai" | "tei";
  api_key: string;
  clear_api_key: boolean;
};

type SettingsDraft = {
  summary: ProviderSettingsDraft;
  embedding: ProviderSettingsDraft;
};

type SettingsTab = "local" | "api" | "data";

const visualAccents = ["coral", "sky", "lavender", "mint"] as const;
const visualPatterns = ["orbit", "grid", "ladder", "shelf"] as const;

type CollectionView = "cards" | "relations" | "table";

function ViewIcon({ view }: { view: CollectionView }) {
  if (view === "cards") {
    return (
      <svg className="view-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
        <rect x="4.5" y="2.5" width="9" height="11" rx="1.7" />
        <path d="M3 5.5v8a2 2 0 0 0 2 2h6.5" />
        <path d="M7 6h4M7 8.5h3" />
      </svg>
    );
  }

  if (view === "relations") {
    return (
      <svg className="view-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
        <path d="m5.2 5.2 7.6 2.5M5.2 12.8l7.6-2.5" />
        <circle cx="4" cy="4.8" r="2" />
        <circle cx="14" cy="8.9" r="2" />
        <circle cx="4" cy="13.2" r="2" />
      </svg>
    );
  }

  return (
    <svg className="view-icon" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3" width="13" height="12" rx="1.5" />
      <path d="M2.5 7h13M2.5 11h13M7 3v12M11.5 3v12" />
    </svg>
  );
}

function DatabaseActionIcon({ kind }: { kind: "add" | "trash" }) {
  if (kind === "add") {
    return (
      <svg className="database-action-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
        <path d="M8 3v10M3 8h10" />
      </svg>
    );
  }

  return (
    <svg className="database-action-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5v5.2c0 .72.58 1.3 1.3 1.3h3.4c.72 0 1.3-.58 1.3-1.3V6.5M6.8 7.5v3.5M9.2 7.5v3.5" />
    </svg>
  );
}

function ModelSettingsIcon() {
  return (
    <svg className="database-action-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 4h10M3 8h10M3 12h10" />
      <circle cx="6" cy="4" r="1.3" />
      <circle cx="10" cy="8" r="1.3" />
      <circle cx="7.5" cy="12" r="1.3" />
    </svg>
  );
}

function createEmptyDraft(): CardDraft {
  return {
    id: "",
    number: "",
    topic: "",
    title: "",
    question: "",
    summary: "",
    analogy: "",
    detail: "",
    source: "",
    tags: "",
  };
}

function createSettingsDraft(settings?: RuntimeSettings | null): SettingsDraft {
  const providerDraft = (kind: ModelKind): ProviderSettingsDraft => {
    const value = settings?.[kind];
    return {
      source: value?.source ?? "local",
      api_url: value?.api_url ?? "",
      model: value?.model ?? "",
      api_format: value?.api_format ?? "openai",
      api_key: "",
      clear_api_key: false,
    };
  };

  return { summary: providerDraft("summary"), embedding: providerDraft("embedding") };
}

function mapApiCard(card: ApiCard, index: number, related: string[] = []): KnowledgeCard {
  const cover = card.cover ?? undefined;
  return {
    id: card.id,
    number: card.number,
    topic: card.topic,
    title: card.title,
    question: card.question ?? "",
    summary: card.summary ?? "",
    analogy: card.analogy ?? "",
    detail: card.detail ?? "",
    source: card.source ?? "",
    accent: cover?.accent ?? visualAccents[index % visualAccents.length],
    pattern: cover?.pattern ?? visualPatterns[index % visualPatterns.length],
    cover,
    tags: card.tags ?? [],
    related,
  };
}

function getCoverStyle(cover?: CoverSpec): CSSProperties | undefined {
  if (!cover) return undefined;
  return {
    "--cover-color": cover.color,
    "--cover-soft-color": cover.soft_color,
    "--cover-background": cover.background,
    "--cover-rotation": `${cover.rotation}deg`,
    "--cover-scale": cover.scale,
    "--cover-density": cover.density,
    "--cover-orbit": cover.orbit,
    "--cover-focus-x": `${26 + cover.orbit * 48}%`,
    "--cover-focus-y": `${28 + cover.density * 34}%`,
  } as CSSProperties;
}

const knowledgeCards: KnowledgeCard[] = [
  {
    id: "attention",
    number: "AI-001",
    topic: "人工智慧",
    title: "Attention 是什麼？",
    question: "AI 如何判斷哪些資訊比較重要？",
    summary:
      "Attention 讓模型在處理一段內容時，動態計算不同部分之間的關聯，而不是平均看待每一個詞。",
    analogy:
      "像人在閱讀一段話時，會自然把注意力放在「關鍵詞」上，並根據上下文重新判斷每個詞的意義。",
    detail:
      "它是 Transformer 能夠理解長距離關係的核心機制。模型會比較目前正在處理的內容，與其他詞或特徵之間的關聯程度，再把更有用的資訊集中到當下的表示裡。",
    source: "研究問題：注意力機制 · Attention Is All You Need",
    accent: "coral",
    pattern: "orbit",
    tags: ["入門", "核心概念"],
    related: ["qkv", "transformer"],
  },
  {
    id: "qkv",
    number: "AI-002",
    topic: "人工智慧",
    title: "Query、Key、Value",
    question: "Attention 到底在比較什麼？",
    summary:
      "Query 像正在尋找的問題，Key 像每份資訊的索引，Value 則是最後真正被取出的內容。",
    analogy:
      "像在圖書館找書：先拿著問題去比對書名與分類，再把符合的書內容帶回來。",
    detail:
      "三者把「我要找什麼」「哪些資訊符合」「符合後要拿走什麼」拆成不同角色，讓關聯計算更容易被組合與重複使用。",
    source: "研究問題：注意力機制 · Scaled Dot-Product Attention",
    accent: "sky",
    pattern: "grid",
    tags: ["機制", "公式"],
    related: ["attention", "transformer"],
  },
  {
    id: "transformer",
    number: "AI-003",
    topic: "人工智慧",
    title: "Transformer",
    question: "為什麼現在很多模型都以它為基礎？",
    summary:
      "Transformer 用注意力機制處理整段輸入，讓模型更容易平行運算，也能捕捉遠距離的上下文關係。",
    analogy:
      "不像一次只看前後兩個字，它比較像把整張句子地圖攤開，再找出彼此有關聯的地方。",
    detail:
      "Transformer 將注意力、位置資訊與多層前饋網路組合在一起，成為語言模型、影像模型與多模態模型常見的架構基礎。",
    source: "Attention Is All You Need · Transformer 模型架構圖解",
    accent: "lavender",
    pattern: "ladder",
    tags: ["架構", "延伸閱讀"],
    related: ["attention", "qkv", "rag"],
  },
  {
    id: "rag",
    number: "AI-004",
    topic: "生成式 AI",
    title: "RAG 為什麼需要檢索？",
    question: "模型不知道的事，能不能先去查資料？",
    summary:
      "RAG 先從指定資料來源找出相關內容，再把內容交給模型生成回答。",
    analogy:
      "像開卷考試：不是要求學生憑記憶回答，而是先允許他翻閱指定的資料。",
    detail:
      "檢索可以讓回答更貼近特定資料庫，但效果仍取決於資料品質、搜尋方式，以及模型是否正確使用找到的內容。",
    source: "論文閱讀與 AI 輔助工作流 · RAG 研究方向",
    accent: "mint",
    pattern: "shelf",
    tags: ["方法", "生成式 AI"],
    related: ["transformer"],
  },
];

const relationPairs = [
  ["attention", "qkv"],
  ["attention", "transformer"],
  ["qkv", "transformer"],
  ["transformer", "rag"],
] as const;

const relationLabels: Record<string, string> = {
  "attention-qkv": "拆解機制",
  "attention-transformer": "延伸架構",
  "qkv-transformer": "組成關係",
  "rag-transformer": "應用方法",
};

function relationKey(first: string, second: string) {
  return [first, second].sort().join("-");
}

function tiltCard(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  const bounds = card.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - 0.5;
  const y = (event.clientY - bounds.top) / bounds.height - 0.5;

  card.style.setProperty("--tilt-x", `${y * -11}deg`);
  card.style.setProperty("--tilt-y", `${x * 13}deg`);
}

function resetTilt(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.setProperty("--tilt-x", "0deg");
  event.currentTarget.style.setProperty("--tilt-y", "0deg");
}

function KnowledgeCardPreview({
  card,
  active,
  onClick,
}: {
  card: KnowledgeCard;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`collection-card collection-card--${card.accent} ${active ? "is-active" : ""}`}
      type="button"
      onClick={onClick}
      onPointerMove={tiltCard}
      onPointerLeave={resetTilt}
      onPointerCancel={resetTilt}
      style={getCoverStyle(card.cover)}
      aria-pressed={active}
      aria-label={`${card.title}。${card.question}。標籤：${card.tags.join("、")}`}
    >
      <span className="collection-card__accent" aria-hidden="true" />
      <span className="collection-card__topline">
        <span>{card.number}</span>
        <span>{card.topic}</span>
      </span>
      <SeededCoverArt
        seed={card.cover?.seed ?? card.id}
        density={card.cover?.density}
        pattern={card.cover?.pattern ?? card.pattern}
        motifs={card.cover?.motifs}
      />
      <span className="collection-card__copy">
        <strong>{card.title}</strong>
        <span>{card.question}</span>
      </span>
      <span className="collection-card__tags">
        {card.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </span>
    </button>
  );
}

function groupCardsByTopic(cards: KnowledgeCard[]) {
  const groups = new Map<string, KnowledgeCard[]>();

  cards.forEach((card) => {
    const group = groups.get(card.topic) ?? [];
    group.push(card);
    groups.set(card.topic, group);
  });

  return Array.from(groups, ([topic, groupedCards]) => ({ topic, cards: groupedCards }));
}

function KnowledgeCardStack({
  topic,
  cards,
  selectedId,
  onSelect,
  onOpen,
}: {
  topic: string;
  cards: KnowledgeCard[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const stackSignature = cards.map((card) => card.id).join("|");

  useEffect(() => {
    setIsExpanded(false);
  }, [stackSignature]);

  const handleCardClick = (card: KnowledgeCard) => {
    if (cards.length > 1 && !isExpanded) {
      setIsExpanded(true);
      return;
    }
    onSelect(card.id);
    onOpen(card.id);
  };

  return (
    <div
      className={`collection-card-stack ${cards.length > 1 ? "is-stack" : "is-single"} ${isExpanded ? "is-expanded" : ""}`}
      role="group"
      aria-label={`${topic}，${cards.length} 張卡片`}
    >
      {isExpanded ? (
        <div className="collection-card-stack__header">
          <div className="collection-card-stack__heading">
            <span>TOPIC</span>
            <strong>{topic}</strong>
            <small>{cards.length} 張卡片</small>
          </div>
          <button
            className="collection-card-stack__toggle"
            type="button"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded(false)}
          >
            收起
          </button>
        </div>
      ) : null}
      <div className="collection-card-stack__items">
        {cards.map((card) => (
          <div className="collection-card-stack__item" key={card.id}>
            <KnowledgeCardPreview
              card={card}
              active={card.id === selectedId}
              onClick={() => handleCardClick(card)}
            />
          </div>
        ))}
      </div>
      {!isExpanded && cards.length > 1 ? (
        <span className="collection-card-stack__count" aria-hidden="true">
          {cards.length} 張
        </span>
      ) : null}
    </div>
  );
}

type NodePosition = { x: number; y: number };

type ConnectionStyle = {
  left: number;
  top: number;
  transform: string;
  width: number;
};

const initialNodePositions: Record<string, NodePosition> = {
  attention: { x: 49, y: 50 },
  qkv: { x: 18, y: 24 },
  transformer: { x: 75, y: 24 },
  rag: { x: 78, y: 76 },
};

function createNodePositions(cards: KnowledgeCard[]): Record<string, NodePosition> {
  const usesDemoLayout = cards.length <= 4 && cards.every((card) => initialNodePositions[card.id]);
  if (usesDemoLayout) {
    return Object.fromEntries(cards.map((card) => [card.id, initialNodePositions[card.id]]));
  }

  const fallbackPositions: NodePosition[] = [
    { x: 22, y: 46 },
    { x: 51, y: 20 },
    { x: 78, y: 48 },
    { x: 48, y: 80 },
  ];
  if (cards.length <= fallbackPositions.length) {
    return Object.fromEntries(cards.map((card, index) => [card.id, fallbackPositions[index]]));
  }

  const ringRadiusX = 34;
  const ringRadiusY = 31;
  return Object.fromEntries(cards.map((card, index) => {
    const angle = -Math.PI / 2 + 0.18 + (index * Math.PI * 2) / cards.length;
    const radialVariation = 1 + ((index % 3) - 1) * 0.055;
    return [card.id, {
      x: 50 + Math.cos(angle) * ringRadiusX * radialVariation,
      y: 50 + Math.sin(angle) * ringRadiusY * (index % 2 === 0 ? 1.04 : 0.98),
    }];
  }));
}

function RelationView({
  cards,
  pairs,
  selectedId,
  onSelect,
  onOpen,
}: {
  cards: KnowledgeCard[];
  pairs: ReadonlyArray<readonly [string, string]>;
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const visibleIds = new Set(cards.map((card) => card.id));
  const visiblePairs = pairs.filter(
    ([first, second]) => visibleIds.has(first) && visibleIds.has(second),
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [positions, setPositions] = useState(() => createNodePositions(cards));
  const [lineStyles, setLineStyles] = useState<Record<string, ConnectionStyle>>({});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const showNodeLabels = zoom >= 1;
  const cardSignature = cards.map((card) => card.id).join("|");
  const visiblePairKey = visiblePairs.map(([first, second]) => `${first}-${second}`).join("|");

  useEffect(() => {
    setPositions(createNodePositions(cards));
    setPan({ x: 0, y: 0 });
  }, [cardSignature]);

  const startDrag = (event: PointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0) return;
    suppressClickRef.current = false;
    const nodeBounds = event.currentTarget.getBoundingClientRect();
    const sceneBounds = sceneRef.current?.getBoundingClientRect();
    const sceneScale = zoom;
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: sceneBounds
        ? (event.clientX - (nodeBounds.left + nodeBounds.width / 2)) / sceneScale
        : event.clientX - (nodeBounds.left + nodeBounds.width / 2),
      offsetY: sceneBounds
        ? (event.clientY - (nodeBounds.top + nodeBounds.height / 2)) / sceneScale
        : event.clientY - (nodeBounds.top + nodeBounds.height / 2),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    tiltCard(event);
    const drag = dragRef.current;
    const sceneBounds = sceneRef.current?.getBoundingClientRect();
    if (!drag || !sceneBounds) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.moved = true;
    suppressClickRef.current = true;

    const sceneScale = zoom;
    const sceneWidth = sceneBounds.width / sceneScale;
    const sceneHeight = sceneBounds.height / sceneScale;
    const nextX = (((event.clientX - sceneBounds.left) / sceneScale - drag.offsetX) / sceneWidth) * 100;
    const nextY = (((event.clientY - sceneBounds.top) / sceneScale - drag.offsetY) / sceneHeight) * 100;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    setPositions((current) => ({
      ...current,
      [drag.id]: {
        x: clamp(nextX, 10, 90),
        y: clamp(nextY, 12, 88),
      },
    }));
  };

  const stopDrag = (event: PointerEvent<HTMLElement>) => {
    resetTilt(event);
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  };

  const getPanBounds = () => {
    const canvas = canvasRef.current;
    if (!canvas || zoom <= 1) return { x: 0, y: 0 };
    return {
      x: (canvas.clientWidth * (zoom - 1)) / 2,
      y: (canvas.clientHeight * (zoom - 1)) / 2,
    };
  };

  const clampPanOffset = (offset: { x: number; y: number }) => {
    const bounds = getPanBounds();
    return {
      x: Math.min(bounds.x, Math.max(-bounds.x, offset.x)),
      y: Math.min(bounds.y, Math.max(-bounds.y, offset.y)),
    };
  };

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    const origin = clampPanOffset(pan);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  };

  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const currentPan = panRef.current;
    if (!currentPan) return;
    setPan(clampPanOffset({
      x: currentPan.originX + event.clientX - currentPan.startX,
      y: currentPan.originY + event.clientY - currentPan.startY,
    }));
  };

  const stopPan = (event: PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const clampZoom = (value: number) => Math.min(1.6, Math.max(0.7, value));
  const adjustZoom = (amount: number) => {
    setZoom((current) => clampZoom(Number((current + amount).toFixed(2))));
  };
  const handleCanvasWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    adjustZoom(event.deltaY > 0 ? -0.08 : 0.08);
  };

  useEffect(() => {
    setPan((current) => clampPanOffset(current));
  }, [zoom]);

  const handleNodeClick = (id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(id);
    onOpen(id);
  };

  useLayoutEffect(() => {
    const updateLines = () => {
      const canvas = canvasRef.current;
      const scene = sceneRef.current;
      if (!canvas || !scene) return;
      const sceneScale = zoomRef.current;
      const sceneBounds = scene.getBoundingClientRect();
      const nextStyles: Record<string, ConnectionStyle> = {};

      visiblePairs.forEach(([first, second]) => {
        const startNode = nodeRefs.current[first];
        const endNode = nodeRefs.current[second];
        if (!startNode || !endNode) return;

        const startBounds = startNode.getBoundingClientRect();
        const endBounds = endNode.getBoundingClientRect();
        const start = {
          x: (startBounds.left - sceneBounds.left + startBounds.width / 2) / sceneScale,
          y: (startBounds.top - sceneBounds.top + startBounds.height / 2) / sceneScale,
        };
        const end = {
          x: (endBounds.left - sceneBounds.left + endBounds.width / 2) / sceneScale,
          y: (endBounds.top - sceneBounds.top + endBounds.height / 2) / sceneScale,
        };
        const deltaX = end.x - start.x;
        const deltaY = end.y - start.y;
        const distance = Math.hypot(deltaX, deltaY);
        if (distance < 1) return;

        const edgeDistance = (bounds: DOMRect) => {
          const width = bounds.width / sceneScale;
          const height = bounds.height / sceneScale;
          const horizontal = deltaX === 0 ? Number.POSITIVE_INFINITY : (width / 2) / Math.abs(deltaX);
          const vertical = deltaY === 0 ? Number.POSITIVE_INFINITY : (height / 2) / Math.abs(deltaY);
          return Math.min(horizontal, vertical);
        };

        const startEdge = edgeDistance(startBounds);
        const endEdge = edgeDistance(endBounds);
        const startPoint = {
          x: start.x + deltaX * startEdge,
          y: start.y + deltaY * startEdge,
        };
        const endPoint = {
          x: end.x - deltaX * endEdge,
          y: end.y - deltaY * endEdge,
        };

        nextStyles[relationKey(first, second)] = {
          left: startPoint.x,
          top: startPoint.y,
          transform: `rotate(${Math.atan2(endPoint.y - startPoint.y, endPoint.x - startPoint.x) * (180 / Math.PI)}deg)`,
          width: Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y),
        };
      });

      setLineStyles((current) => {
        const currentValue = JSON.stringify(current);
        const nextValue = JSON.stringify(nextStyles);
        return currentValue === nextValue ? current : nextStyles;
      });
    };

    updateLines();
    const observer = new ResizeObserver(updateLines);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [visiblePairKey, positions]);

  return (
    <div className="relation-workspace">
      <div className="relation-toolbar">
        <span className="relation-toolbar__label">VIEW SCALE</span>
        <div className="relation-zoom" aria-label="調整關聯圖縮放">
          <button type="button" aria-label="縮小關聯圖" onClick={() => adjustZoom(-0.1)} disabled={zoom <= 0.7}>
            −
          </button>
          <output>{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="放大關聯圖" onClick={() => adjustZoom(0.1)} disabled={zoom >= 1.6}>
            ＋
          </button>
          <button className="relation-zoom__reset" type="button" onClick={() => setZoom(1)} disabled={zoom === 1}>
            重設
          </button>
        </div>
      </div>
      <div
        className={`relation-canvas ${showNodeLabels ? "" : "relation-canvas--compact"} ${isPanning ? "is-panning" : ""}`}
        ref={canvasRef}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
        onContextMenu={(event) => event.preventDefault()}
        onWheel={handleCanvasWheel}
        aria-label="知識卡片關聯圖"
      >
        <div
          className="relation-canvas__scene"
          ref={sceneRef}
          style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
        >
          <span className="relation-canvas__grid" aria-hidden="true" />
          {visiblePairs.map(([first, second]) => (
            <span
              className={`relation-line relation-line--${relationKey(first, second)}`}
              key={`${first}-${second}`}
              style={lineStyles[relationKey(first, second)]}
              aria-hidden="true"
            />
          ))}
          {cards.map((card, index) => {
          const position = positions[card.id] ?? {
            x: 18 + ((index * 29) % 64),
            y: 18 + ((index * 37) % 64),
          };
          const relatedCount = visiblePairs.filter(
            ([first, second]) => first === card.id || second === card.id,
          ).length;
          const previewPlacement = position.y > 55 ? "relation-node--preview-above" : "relation-node--preview-below";
          const floatClass = `relation-node--float-${index % 4}`;

            return (
            <button
              className={`relation-node relation-node--${card.id} ${previewPlacement} ${floatClass} ${selectedId === card.id ? "is-selected" : ""}`}
              key={card.id}
              type="button"
              onClick={() => handleNodeClick(card.id)}
              onPointerDown={(event) => startDrag(event, card.id)}
              onPointerMove={moveDrag}
              onPointerUp={stopDrag}
              onPointerLeave={stopDrag}
              onPointerCancel={stopDrag}
              ref={(node) => {
                nodeRefs.current[card.id] = node;
              }}
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              aria-pressed={selectedId === card.id}
              aria-label={`${card.title}，${card.topic}，${relatedCount} 個關聯`}
            >
              <span className="relation-node__label" aria-hidden="true">{card.title}</span>
              <span className="relation-node__dot" aria-hidden="true" />
              <span className="relation-node__preview" aria-hidden="true">
                <span className="relation-node__number">{card.number}</span>
                <strong>{card.title}</strong>
                <span className="relation-node__topic">{card.topic}</span>
                <small>{relatedCount} 個關聯</small>
              </span>
            </button>
            );
          })}
        </div>
      </div>
      <p className="relation-hint">靠近節點查看摘要 · 點擊節點開啟內容 · 拖曳節點調整位置 · 右鍵拖曳平移畫布 · Ctrl/Cmd + 滾輪縮放</p>
      <div className="relation-legend">
        {visiblePairs.map(([first, second]) => (
          <span key={`legend-${first}-${second}`}>
            <i className={`relation-legend__sample relation-legend__sample--${relationKey(first, second)}`} aria-hidden="true" />
            {relationLabels[relationKey(first, second)] ?? "語意關聯"}
          </span>
        ))}
      </div>
    </div>
  );
}

function CollectionCardViewer({
  card,
  relatedCards,
  onOpenRelated,
  onClose,
}: {
  card: KnowledgeCard;
  relatedCards: KnowledgeCard[];
  onOpenRelated: (id: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [card.id]);

  return (
    <div className="card-viewer" onClick={onClose}>
      <div
        className="card-viewer__panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-card-viewer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="card-viewer__topline">
          <span>OPEN KNOWLEDGE CARD</span>
          <button className="card-viewer__close" type="button" onClick={onClose}>
            關閉 <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="card-viewer__content">
          <div className="card-viewer__card relation-card-viewer__card">
            <KnowledgeCardPreview card={card} active onClick={() => undefined} />
          </div>
          <article className="card-viewer__reading">
            <div className="reading-meta">
              <span>{card.topic}</span>
              <span>{card.tags.join(" · ")}</span>
            </div>
            <h2 id="collection-card-viewer-title">{card.title}</h2>
            <div className="reading-question-block">
              <span className="reading-label">它在回答什麼</span>
              <p className="reading-question">{card.question}</p>
            </div>
            <div className="reading-block reading-block--highlight">
              <span className="reading-label">一句話理解</span>
              <p>{card.summary}</p>
            </div>
            <div className="reading-columns">
              <div className="reading-block">
                <span className="reading-label">用例子理解</span>
                <p>{card.analogy}</p>
              </div>
              <div className="reading-block">
                <span className="reading-label">核心運作</span>
                <p>{card.detail}</p>
              </div>
            </div>
            {relatedCards.length > 0 ? (
              <section className="reading-related" aria-labelledby="collection-card-related-title">
                <div className="reading-related__heading">
                  <span className="reading-label" id="collection-card-related-title">延伸閱讀</span>
                  <small>{relatedCards.length} 張相關卡片</small>
                </div>
                <div className="reading-related__list">
                  {relatedCards.map((relatedCard) => (
                    <button
                      className={`reading-related__item reading-related__item--${relatedCard.accent}`}
                      key={relatedCard.id}
                      type="button"
                      onClick={() => onOpenRelated(relatedCard.id)}
                    >
                      <span>{relatedCard.number}</span>
                      <strong>{relatedCard.title}</strong>
                      <small>{relatedCard.topic}</small>
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="reading-footer">
              <span>來源</span>
              <span>{card.source}</span>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}

function TableView({
  cards,
  onSelect,
  onEdit,
  onDelete,
}: {
  cards: KnowledgeCard[];
  onSelect: (id: string) => void;
  onEdit: (card: KnowledgeCard) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="collection-table-wrap">
      <table className="collection-table">
        <thead>
          <tr>
            <th>卡片</th>
            <th>領域</th>
            <th>關聯</th>
            <th>來源</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.id}>
              <td>
                <button
                  className={`table-card-button table-card-button--${card.accent}`}
                  type="button"
                  onClick={() => onSelect(card.id)}
                >
                  <span>{card.number}</span>
                  <strong>{card.title}</strong>
                </button>
              </td>
              <td>{card.topic}</td>
              <td>{card.related.length} 張卡片</td>
              <td className="table-source">{card.source}</td>
              <td>
                <button
                  className="table-card-edit"
                  type="button"
                  onClick={() => onEdit(card)}
                >
                  編輯
                </button>
                <button
                  className="table-card-delete"
                  type="button"
                  onClick={() => onDelete(card.id)}
                >
                  移到垃圾桶
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrashPanel({
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

function ModelOptionCard({
  model,
  actionId,
  onDownload,
  onSelect,
}: {
  model: ModelOption;
  actionId: string;
  onDownload: (id: string) => void;
  onSelect: (kind: ModelKind, id: string) => void;
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
      {model.error ? <small className="model-option__error">上次載入失敗：{model.error}</small> : null}
      <div className="model-option__actions">
        {model.active ? (
          <span className="model-option__active">目前使用中</span>
        ) : model.status === "downloading" || isBusy ? (
          <span className="model-option__pending">下載／準備中…</span>
        ) : model.installed ? (
          <button type="button" onClick={() => onSelect(model.kind, model.id)}>
            啟用這個模型
          </button>
        ) : (
          <button type="button" onClick={() => onDownload(model.id)}>
            下載模型
          </button>
        )}
      </div>
    </article>
  );
}

function DataManagementPanel({
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

function ModelSettingsPanel({
  catalog,
  runtimeSettings,
  settingsDraft,
  settingsTab,
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
            <button className="create-card-submit" type="submit" disabled={isSettingsSaving}>
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
                <ModelOptionCard key={model.id} model={model} actionId={actionId} onDownload={onDownload} onSelect={onSelect} />
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
                <ModelOptionCard key={model.id} model={model} actionId={actionId} onDownload={onDownload} onSelect={onSelect} />
              ))}
            </div>
          </div>
          <p className="model-settings-footnote">本機模型執行在 CPU／ONNX runtime；切換到自訂 API 時，只有產生摘要或向量的請求會送到你填入的服務。</p>
        </>
      ) : null}
    </section>
  );
}

function CreateCardForm({
  draft,
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

export default function CollectionPage() {
  const [selectedId, setSelectedId] = useState("attention");
  const [viewerCardId, setViewerCardId] = useState("");
  const [collectionView, setCollectionView] = useState<"cards" | "relations" | "table">("cards");
  const [collectionQuery, setCollectionQuery] = useState("");
  const [activeTopic, setActiveTopic] = useState("全部");
  const [cards, setCards] = useState<KnowledgeCard[]>(knowledgeCards);
  const [relationPairsState, setRelationPairsState] = useState<ReadonlyArray<readonly [string, string]>>(relationPairs);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [isCreateCardOpen, setIsCreateCardOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [cardDraft, setCardDraft] = useState<CardDraft>(createEmptyDraft);
  const [sourceText, setSourceText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const [trashCards, setTrashCards] = useState<TrashCard[]>([]);
  const [isTrashLoading, setIsTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [isModelsOpen, setIsModelsOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(() => createSettingsDraft());
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("local");
  const [isModelsLoading, setIsModelsLoading] = useState(false);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [isDatabaseExporting, setIsDatabaseExporting] = useState(false);
  const [isDatabaseImporting, setIsDatabaseImporting] = useState(false);
  const [isDatabaseResetting, setIsDatabaseResetting] = useState(false);
  const [hasDatabaseBackup, setHasDatabaseBackup] = useState(false);
  const [databaseBackupAcknowledged, setDatabaseBackupAcknowledged] = useState(false);
  const [databaseResetConfirmation, setDatabaseResetConfirmation] = useState("");
  const [modelError, setModelError] = useState("");
  const [modelActionId, setModelActionId] = useState("");
  const [cardsRefreshKey, setCardsRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadCards() {
      setIsLoading(true);
      setLoadError("");
      try {
        const response = await fetch("/api/cards", { cache: "no-store" });
        if (!response.ok) throw new Error("cards request failed");
        const payload = (await response.json()) as ApiCard[];
        if (!Array.isArray(payload)) throw new Error("invalid cards response");

        const relationSnapshots = await Promise.all(
          payload.map(async (card) => {
            try {
              const relationResponse = await fetch(
                `/api/cards/${encodeURIComponent(card.id)}/related`,
                { cache: "no-store" },
              );
              if (!relationResponse.ok) {
                return { cardId: card.id, relations: [] as ApiRelation[], failed: true };
              }
              const relations = (await relationResponse.json()) as unknown;
              return {
                cardId: card.id,
                relations: Array.isArray(relations) ? relations as ApiRelation[] : [],
                failed: !Array.isArray(relations),
              };
            } catch {
              return { cardId: card.id, relations: [] as ApiRelation[], failed: true };
            }
          }),
        );

        const activeIds = new Set(payload.map((card) => card.id));
        const relatedByCard = new Map<string, Set<string>>();
        const nextPairs: Array<readonly [string, string]> = [];
        const knownPairs = new Set<string>();
        const relationLoadFailed = relationSnapshots.some((snapshot) => snapshot.failed);

        relationSnapshots.forEach(({ cardId, relations }) => {
          relations.forEach((relation) => {
            const targetId = relation.card?.id;
            if (!targetId || targetId === cardId || !activeIds.has(targetId)) return;

            const sourceRelations = relatedByCard.get(cardId) ?? new Set<string>();
            sourceRelations.add(targetId);
            relatedByCard.set(cardId, sourceRelations);

            const targetRelations = relatedByCard.get(targetId) ?? new Set<string>();
            targetRelations.add(cardId);
            relatedByCard.set(targetId, targetRelations);

            const pairId = relationKey(cardId, targetId);
            if (!knownPairs.has(pairId)) {
              knownPairs.add(pairId);
              nextPairs.push([cardId, targetId]);
            }
          });
        });

        if (cancelled) return;
        const loadedCards = payload.map((card, index) => mapApiCard(
          card,
          index,
          Array.from(relatedByCard.get(card.id) ?? []),
        ));
        if (cancelled) return;
        setCards(loadedCards);
        setRelationPairsState(relationLoadFailed ? relationPairs : nextPairs);
        setSelectedId(loadedCards[0]?.id ?? "");
      } catch {
        if (!cancelled) setLoadError("目前無法載入本機資料，先顯示示範卡片。請重新啟動本機 API。");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadCards();
    return () => {
      cancelled = true;
    };
  }, [cardsRefreshKey]);

  const topics = ["全部", ...Array.from(new Set(cards.map((card) => card.topic)))];
  const filteredCards = cards.filter((card) => {
    const searchText = `${card.title} ${card.question} ${card.source} ${card.tags.join(" ")}`.toLowerCase();
    const matchesQuery = searchText.includes(collectionQuery.trim().toLowerCase());
    const matchesTopic = activeTopic === "全部" || card.topic === activeTopic;
    return matchesQuery && matchesTopic;
  });
  const cardGroups = groupCardsByTopic(filteredCards);
  const viewerCard = cards.find((card) => card.id === viewerCardId);
  const viewerRelatedCards = viewerCard
    ? viewerCard.related
      .map((relatedId) => cards.find((card) => card.id === relatedId))
      .filter((card): card is KnowledgeCard => Boolean(card))
    : [];

  useEffect(() => {
    if (!viewerCardId) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewerCardId("");
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [viewerCardId]);

  useEffect(() => {
    if (!isModelsOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !modelActionId && !isSettingsSaving && !isDatabaseExporting && !isDatabaseImporting && !isDatabaseResetting) {
        setIsModelsOpen(false);
        setModelError("");
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDatabaseExporting, isDatabaseImporting, isDatabaseResetting, isModelsOpen, isSettingsSaving, modelActionId]);

  useEffect(() => {
    if (!createSuccess) return;

    const timeoutId = window.setTimeout(() => {
      setCreateSuccess("");
    }, 5000);

    return () => window.clearTimeout(timeoutId);
  }, [createSuccess]);

  const updateCardDraft = (field: keyof CardDraft, value: string) => {
    setCardDraft((current) => ({ ...current, [field]: value }));
  };

  const openCreateCard = () => {
    setCreateError("");
    setCreateSuccess("");
    setEditingId("");
    setCardDraft(createEmptyDraft());
    setSourceText("");
    setIsTrashOpen(false);
    setIsModelsOpen(false);
    setIsCreateCardOpen(true);
  };

  const openEditCard = (card: KnowledgeCard) => {
    setCreateError("");
    setCreateSuccess("");
    setEditingId(card.id);
    setCardDraft({
      id: card.id,
      number: card.number,
      topic: card.topic,
      title: card.title,
      question: card.question,
      summary: card.summary,
      analogy: card.analogy,
      detail: card.detail,
      source: card.source,
      tags: card.tags.join(", "),
    });
    setSourceText("");
    setIsTrashOpen(false);
    setIsModelsOpen(false);
    setIsCreateCardOpen(true);
  };

  const closeCreateCard = () => {
    if (isSaving || isDrafting) return;
    setCreateError("");
    setEditingId("");
    setIsCreateCardOpen(false);
  };

  const loadTrash = async () => {
    setIsTrashLoading(true);
    setTrashError("");
    try {
      const response = await fetch("/api/trash", { cache: "no-store" });
      const result = (await response.json()) as TrashCard[] | { detail?: string };
      if (!response.ok || !Array.isArray(result)) {
        throw new Error("detail" in result ? result.detail ?? "垃圾桶載入失敗。" : "垃圾桶載入失敗。");
      }
      setTrashCards(result);
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : "垃圾桶載入失敗，請稍後再試。");
    } finally {
      setIsTrashLoading(false);
    }
  };

  const openTrash = () => {
    setIsModelsOpen(false);
    setIsTrashOpen(true);
    void loadTrash();
  };

  const loadModels = async (showLoading = true): Promise<ModelCatalog | null> => {
    if (showLoading) setIsModelsLoading(true);
    setModelError("");
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      const result = (await response.json()) as ModelCatalog | { detail?: string };
      if (!response.ok || !("models" in result)) {
        throw new Error("detail" in result ? result.detail ?? "模型狀態載入失敗。" : "模型狀態載入失敗。");
      }
      setModelCatalog(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型狀態載入失敗，請稍後再試。";
      setModelError(message);
      return null;
    } finally {
      if (showLoading) setIsModelsLoading(false);
    }
  };

  const loadRuntimeSettings = async (): Promise<RuntimeSettings | null> => {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const result = (await response.json()) as RuntimeSettings | { detail?: string };
      if (!response.ok || !("summary" in result) || !("embedding" in result)) {
        throw new Error("detail" in result ? result.detail ?? "設定載入失敗。" : "設定載入失敗。");
      }
      setRuntimeSettings(result);
      setSettingsDraft(createSettingsDraft(result));
      return result;
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "設定載入失敗，請稍後再試。");
      return null;
    }
  };

  const openModels = () => {
    setIsModelsOpen(true);
    setIsCreateCardOpen(false);
    setIsTrashOpen(false);
    setSettingsTab("local");
    setHasDatabaseBackup(false);
    setDatabaseBackupAcknowledged(false);
    setDatabaseResetConfirmation("");
    void Promise.all([loadModels(), loadRuntimeSettings()]);
  };

  const closeModels = () => {
    if (modelActionId || isSettingsSaving || isDatabaseExporting || isDatabaseImporting || isDatabaseResetting) return;
    setIsModelsOpen(false);
    setModelError("");
  };

  const updateSettingsDraft = (kind: ModelKind, field: keyof ProviderSettingsDraft, value: string | boolean) => {
    setSettingsDraft((current) => ({
      ...current,
      [kind]: { ...current[kind], [field]: value },
    }));
  };

  const handleSaveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSettingsSaving(true);
    setModelError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsDraft),
      });
      const result = (await response.json()) as { detail?: string; settings?: RuntimeSettings; reindexed_cards?: number };
      if (!response.ok || !result.settings) throw new Error(result.detail ?? "設定套用失敗。");
      setRuntimeSettings(result.settings);
      setSettingsDraft(createSettingsDraft(result.settings));
      setCreateSuccess(
        result.reindexed_cards
          ? `設定已套用，並重新建立 ${result.reindexed_cards} 張卡片的語意關聯。`
          : "設定已套用。",
      );
      if (settingsDraft.embedding.source === "api" || result.reindexed_cards) {
        setCardsRefreshKey((current) => current + 1);
      }
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "設定套用失敗，請稍後再試。");
    } finally {
      setIsSettingsSaving(false);
    }
  };

  const handleExportDatabase = async () => {
    setIsDatabaseExporting(true);
    setModelError("");
    try {
      const response = await fetch("/api/database/export", { cache: "no-store" });
      const result = (await response.json()) as {
        detail?: string;
        exported_at?: string;
      };
      if (!response.ok || !result.exported_at) {
        throw new Error(result.detail ?? "資料匯出失敗。");
      }

      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const download = document.createElement("a");
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      download.href = URL.createObjectURL(blob);
      download.download = `knowledge-card-cabinet-${stamp}.json`;
      document.body.appendChild(download);
      download.click();
      download.remove();
      URL.revokeObjectURL(download.href);
      setHasDatabaseBackup(true);
      setDatabaseBackupAcknowledged(false);
      setDatabaseResetConfirmation("");
      setCreateSuccess("已匯出本機資料備份，請確認檔案已保存後再進行重置。");
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "資料匯出失敗，請稍後再試。");
    } finally {
      setIsDatabaseExporting(false);
    }
  };

  const handleResetDatabase = async () => {
    if (!hasDatabaseBackup || !databaseBackupAcknowledged || databaseResetConfirmation !== "RESET DATABASE") return;

    setIsDatabaseResetting(true);
    setModelError("");
    try {
      const response = await fetch("/api/database/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: databaseResetConfirmation }),
      });
      const result = (await response.json()) as { detail?: string; removed?: { cards?: number; relations?: number } };
      if (!response.ok || !result.removed) {
        throw new Error(result.detail ?? "資料庫重置失敗。");
      }

      setCards([]);
      setTrashCards([]);
      setRelationPairsState([]);
      setSelectedId("");
      setViewerCardId("");
      setCollectionQuery("");
      setActiveTopic("全部");
      setHasDatabaseBackup(false);
      setDatabaseBackupAcknowledged(false);
      setDatabaseResetConfirmation("");
      setIsModelsOpen(false);
      setCreateSuccess(`本機資料庫已重置，清除了 ${result.removed.cards ?? 0} 張卡片與 ${result.removed.relations ?? 0} 條關聯。`);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "資料庫重置失敗，請稍後再試。");
    } finally {
      setIsDatabaseResetting(false);
    }
  };

  const handleImportDatabase = async (file: File) => {
    if (!window.confirm("匯入備份會取代目前本機的卡片、垃圾桶與關聯，確定要繼續嗎？")) return;

    setIsDatabaseImporting(true);
    setModelError("");
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error("這不是有效的 JSON 備份檔。");
      }

      if (!payload || typeof payload !== "object" || !("format_version" in payload) || !("cards" in payload)) {
        throw new Error("這份檔案不是知識卡冊的備份格式。");
      }

      const response = await fetch("/api/database/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        detail?: string;
        imported?: { cards?: number; deleted_cards?: number; relations?: number };
      };
      if (!response.ok || !result.imported) {
        throw new Error(result.detail ?? "資料匯入失敗。");
      }

      setTrashCards([]);
      setSelectedId("");
      setViewerCardId("");
      setIsModelsOpen(false);
      setCardsRefreshKey((current) => current + 1);
      setCreateSuccess(`已匯入 ${result.imported.cards ?? 0} 張卡片與 ${result.imported.relations ?? 0} 條關聯。`);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "資料匯入失敗，請稍後再試。");
    } finally {
      setIsDatabaseImporting(false);
    }
  };

  const handleDownloadModel = async (modelId: string) => {
    setModelActionId(modelId);
    setModelError("");
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(modelId)}/download`, { method: "POST" });
      const result = (await response.json()) as { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "模型下載無法開始。");

      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const latest = await loadModels(false);
        const model = latest?.models.find((candidate) => candidate.id === modelId);
        if (model?.status === "ready") {
          setCreateSuccess(`已下載「${model.label}」，現在可以啟用它。`);
          return;
        }
        if (model?.error) throw new Error(model.error);
      }
      throw new Error("模型下載時間較長，請稍後重新開啟模型設定查看狀態。");
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型下載失敗，請稍後再試。");
    } finally {
      setModelActionId("");
      void loadModels(false);
    }
  };

  const handleSelectModel = async (kind: ModelKind, modelId: string) => {
    setModelActionId(modelId);
    setModelError("");
    try {
      const response = await fetch("/api/models/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, model_id: modelId }),
      });
      const result = (await response.json()) as { detail?: string; selection?: { model?: ModelOption }; models?: ModelCatalog };
      if (!response.ok) throw new Error(result.detail ?? "模型啟用失敗。");
      if (result.models) setModelCatalog(result.models);
      setCreateSuccess(`已啟用「${result.selection?.model?.label ?? "本機模型"}」。${kind === "embedding" ? "卡片關聯正在使用新的語意索引。" : ""}`);
      if (kind === "embedding") setCardsRefreshKey((current) => current + 1);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型啟用失敗，請稍後再試。");
    } finally {
      setModelActionId("");
    }
  };

  const handleDeleteCard = async (id: string) => {
    if (!window.confirm("要把這張卡片移到垃圾桶嗎？之後仍然可以復原。")) return;

    setDeletingId(id);
    setTrashError("");
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = (await response.json()) as { detail?: string; card?: TrashCard };
      if (!response.ok || !result.card) {
        throw new Error(result.detail ?? "移到垃圾桶失敗，請稍後再試。");
      }

      const nextCard = cards.find((card) => card.id !== id);
      setCards((current) => current.filter((card) => card.id !== id));
      setRelationPairsState((current) => current.filter(([first, second]) => first !== id && second !== id));
      setTrashCards((current) => [result.card!, ...current.filter((card) => card.id !== id)]);
      setSelectedId((current) => current === id ? nextCard?.id ?? "" : current);
      setCreateSuccess(`已將「${result.card.title}」移到垃圾桶。`);
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : "移到垃圾桶失敗，請稍後再試。");
    } finally {
      setDeletingId("");
    }
  };

  const handleRestoreCard = async (id: string) => {
    setRestoringId(id);
    setTrashError("");
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(id)}/restore`, { method: "POST" });
      const result = (await response.json()) as { detail?: string; card?: ApiCard };
      if (!response.ok || !result.card) {
        throw new Error(result.detail ?? "復原卡片失敗，請稍後再試。");
      }

      const restoredCard = mapApiCard(result.card, cards.length);
      setCards((current) => [restoredCard, ...current.filter((card) => card.id !== restoredCard.id)]);
      setTrashCards((current) => current.filter((card) => card.id !== restoredCard.id));
      setSelectedId(restoredCard.id);
      setCreateSuccess(`已復原「${restoredCard.title}」。`);
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : "復原卡片失敗，請稍後再試。");
    } finally {
      setRestoringId("");
    }
  };

  const handlePermanentlyDeleteCard = async (id: string) => {
    if (!window.confirm("永久刪除後將無法復原，確定要繼續嗎？")) return;

    setDeletingId(id);
    setTrashError("");
    try {
      const response = await fetch(`/api/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = (await response.json()) as { detail?: string };
      if (!response.ok) {
        throw new Error(result.detail ?? "永久刪除失敗，請稍後再試。");
      }
      setTrashCards((current) => current.filter((card) => card.id !== id));
      setCreateSuccess("卡片已永久刪除。 ");
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : "永久刪除失敗，請稍後再試。");
    } finally {
      setDeletingId("");
    }
  };

  const handleGenerateDraft = async () => {
    setCreateError("");
    const content = sourceText.trim();
    if (content.length < 20) {
      setCreateError("請先貼上至少 20 個字的筆記內容。 ");
      return;
    }

    setIsDrafting(true);
    try {
      const response = await fetch("/api/cards/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, source: cardDraft.source.trim() }),
      });
      const result = (await response.json()) as CardDraftResponse;
      if (!response.ok || !result.draft) {
        throw new Error(result.detail ?? "本機整理失敗，請稍後再試。");
      }

      const generated = result.draft;
      setCardDraft((current) => ({
        ...current,
        topic: generated.topic ?? current.topic,
        title: generated.title ?? current.title,
        question: generated.question ?? current.question,
        summary: generated.summary ?? current.summary,
        analogy: generated.analogy ?? current.analogy,
        detail: generated.detail ?? current.detail,
        tags: generated.tags?.join(", ") ?? current.tags,
      }));
      setCreateSuccess(`已用 ${result.model ?? "本機模型"} 產生草稿，請檢查內容後再儲存。`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "本機整理失敗，請稍後再試。");
    } finally {
      setIsDrafting(false);
    }
  };

  const handleCreateCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");

    const normalizedId = cardDraft.id.trim();
    if (!editingId && cards.some((card) => card.id === normalizedId)) {
      setCreateError("這個卡片 ID 已經存在，請換一個 ID。");
      return;
    }

    setIsSaving(true);
    try {
      const cardFields = {
        number: cardDraft.number.trim(),
        topic: cardDraft.topic.trim(),
        title: cardDraft.title.trim(),
        question: cardDraft.question.trim(),
        summary: cardDraft.summary.trim(),
        analogy: cardDraft.analogy.trim(),
        detail: cardDraft.detail.trim(),
        source: cardDraft.source.trim(),
        tags: cardDraft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      };
      const response = await fetch(
        editingId ? `/api/cards/${encodeURIComponent(editingId)}` : "/api/cards",
        {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editingId ? cardFields : { id: normalizedId, ...cardFields }),
        }),
        },
      );
      const result = (await response.json()) as {
        detail?: string;
        card?: ApiCard;
        suggested_relations?: Array<{ id: string }>;
      };
      if (!response.ok || !result.card) {
        throw new Error(result.detail ?? (editingId ? "更新卡片失敗，請稍後再試。" : "新增卡片失敗，請稍後再試。"));
      }

      const suggestedIds = (result.suggested_relations ?? []).map((relation) => relation.id);
      if (editingId) {
        const updatedCard = mapApiCard(result.card, cards.findIndex((card) => card.id === editingId), suggestedIds);
        setCards((current) => current.map((card) => {
          if (card.id === updatedCard.id) return updatedCard;
          const related = card.related.filter((relatedId) => relatedId !== updatedCard.id);
          if (suggestedIds.includes(card.id)) related.push(updatedCard.id);
          return { ...card, related: Array.from(new Set(related)) };
        }));
        setRelationPairsState((current) => {
          const next = current.filter(([first, second]) => first !== updatedCard.id && second !== updatedCard.id);
          suggestedIds.forEach((targetId) => {
            if (!next.some(([first, second]) => relationKey(first, second) === relationKey(updatedCard.id, targetId))) {
              next.push([updatedCard.id, targetId]);
            }
          });
          return next;
        });
        setSelectedId(updatedCard.id);
        setCardDraft(createEmptyDraft());
        setSourceText("");
        setEditingId("");
        setIsCreateCardOpen(false);
        setCreateSuccess(`已更新「${updatedCard.title}」，並重新建立語意索引。`);
        return;
      }

      const createdCard = mapApiCard(result.card, cards.length, suggestedIds);
      setCards((current) => [
        createdCard,
        ...current
          .filter((card) => card.id !== createdCard.id)
          .map((card) => suggestedIds.includes(card.id)
            ? { ...card, related: Array.from(new Set([...card.related, createdCard.id])) }
            : card),
      ]);
      setRelationPairsState((current) => {
        const next = [...current];
        suggestedIds.forEach((targetId) => {
          if (!next.some(([first, second]) => relationKey(first, second) === relationKey(createdCard.id, targetId))) {
            next.push([createdCard.id, targetId]);
          }
        });
        return next;
      });
      setSelectedId(createdCard.id);
      setActiveTopic("全部");
      setCollectionQuery("");
      setCardDraft(createEmptyDraft());
      setSourceText("");
      setIsCreateCardOpen(false);
      setCreateSuccess(`已新增「${createdCard.title}」，並完成語意索引。`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "新增卡片失敗，請稍後再試。");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="collection-page-shell">
      <header className="collection-page-header">
        <a className="brand" href="/">
          <span className="brand-mark">◎</span>
          <span>知識卡冊</span>
        </a>
        <span className="collection-page-label">DATABASE / COLLECTION</span>
        <a className="collection-page-back" href="/">
          ↖ 回到首頁
        </a>
      </header>

      <section className="collection-section collection-page-section">
        <div className="section-heading section-heading--collection">
          <div>
            <p className="eyebrow">THE KNOWLEDGE DATABASE</p>
            <h1>收藏瀏覽</h1>
          </div>
          <div className="database-summary">
            <span className="database-live-dot" aria-hidden="true" />
            <span>本機收藏資料庫</span>
            <strong>{filteredCards.length.toString().padStart(2, "0")}</strong>
            <small>筆知識</small>
          </div>
        </div>

        <div className="database-toolbar">
          <label className="database-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={collectionQuery}
              onChange={(event) => setCollectionQuery(event.target.value)}
              placeholder="搜尋卡片、主題或來源"
              aria-label="搜尋收藏卡片"
            />
          </label>
          <div className="topic-filters" aria-label="依領域篩選">
            {topics.map((topic) => (
              <button
                className={activeTopic === topic ? "is-active" : ""}
                key={topic}
                type="button"
                onClick={() => setActiveTopic(topic)}
                aria-pressed={activeTopic === topic}
              >
                {topic}
              </button>
            ))}
          </div>
          <button className="database-add-button" type="button" onClick={openCreateCard}>
            <DatabaseActionIcon kind="add" />
            <span>新增卡片</span>
          </button>
          <button className="database-trash-button" type="button" onClick={openTrash}>
            <DatabaseActionIcon kind="trash" />
            <span>垃圾桶{trashCards.length > 0 ? ` ${trashCards.length}` : ""}</span>
          </button>
          <button className="database-model-button" type="button" onClick={openModels}>
            <ModelSettingsIcon />
            <span>設定</span>
          </button>
          <div className="view-switcher" aria-label="切換資料庫視圖">
            <span>VIEW</span>
            {([
              ["cards", "卡片視圖"],
              ["relations", "關聯圖視圖"],
              ["table", "資料表視圖"],
            ] as const).map(([view, label]) => (
              <button
                className={collectionView === view ? "is-active" : ""}
                key={view}
                type="button"
                onClick={() => setCollectionView(view)}
                aria-pressed={collectionView === view}
                aria-label={label}
                title={label}
              >
                <ViewIcon view={view} />
              </button>
            ))}
          </div>
        </div>

        {loadError ? <p className="database-notice" role="status">{loadError}</p> : null}
        {createSuccess ? <p className="database-notice database-notice--success" role="status">{createSuccess}</p> : null}
        {isCreateCardOpen ? (
          <CreateCardForm
            draft={cardDraft}
            sourceText={sourceText}
            isEditing={Boolean(editingId)}
            isSaving={isSaving}
            isDrafting={isDrafting}
            error={createError}
            onSourceChange={setSourceText}
            onGenerate={() => void handleGenerateDraft()}
            onChange={updateCardDraft}
            onClose={closeCreateCard}
            onSubmit={handleCreateCard}
          />
        ) : null}
        {isTrashOpen ? (
          <TrashPanel
            cards={trashCards}
            isLoading={isTrashLoading}
            error={trashError}
            restoringId={restoringId}
            deletingId={deletingId}
            onClose={() => setIsTrashOpen(false)}
            onRestore={(id) => void handleRestoreCard(id)}
            onDelete={(id) => void handlePermanentlyDeleteCard(id)}
          />
        ) : null}
        {isModelsOpen ? (
          <div className="settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModels(); }}>
            <ModelSettingsPanel
              catalog={modelCatalog}
              runtimeSettings={runtimeSettings}
              settingsDraft={settingsDraft}
              settingsTab={settingsTab}
              isLoading={isModelsLoading}
              isSettingsSaving={isSettingsSaving}
              isDatabaseExporting={isDatabaseExporting}
              isDatabaseImporting={isDatabaseImporting}
              isDatabaseResetting={isDatabaseResetting}
              hasDatabaseBackup={hasDatabaseBackup}
              databaseBackupAcknowledged={databaseBackupAcknowledged}
              databaseResetConfirmation={databaseResetConfirmation}
              error={modelError}
              actionId={modelActionId}
              onClose={closeModels}
              onDownload={(id) => void handleDownloadModel(id)}
              onSelect={(kind, id) => void handleSelectModel(kind, id)}
              onSettingsTabChange={setSettingsTab}
              onDraftChange={updateSettingsDraft}
              onSaveSettings={handleSaveSettings}
              onExportDatabase={() => void handleExportDatabase()}
              onImportDatabase={(file) => void handleImportDatabase(file)}
              onDatabaseBackupAcknowledgedChange={setDatabaseBackupAcknowledged}
              onDatabaseResetConfirmationChange={setDatabaseResetConfirmation}
              onResetDatabase={() => void handleResetDatabase()}
            />
          </div>
        ) : null}

        {isLoading ? (
          <div className="database-empty">
            <strong>正在載入收藏</strong>
            <span>正在從本機資料庫讀取知識卡。</span>
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="database-empty">
            <strong>找不到符合的知識卡</strong>
            <span>試著換一個關鍵字，或清除目前的領域篩選。</span>
          </div>
        ) : collectionView === "cards" ? (
          <div className="collection-grid collection-grid--stacked">
            {cardGroups.map((group) => (
              <KnowledgeCardStack
                key={group.topic}
                topic={group.topic}
                cards={group.cards}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOpen={setViewerCardId}
              />
            ))}
          </div>
        ) : collectionView === "relations" ? (
          <RelationView
            cards={filteredCards}
            pairs={relationPairsState}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={setViewerCardId}
          />
        ) : (
          <TableView
            cards={filteredCards}
            onSelect={setSelectedId}
            onEdit={openEditCard}
            onDelete={(id) => void handleDeleteCard(id)}
          />
        )}

        <div className="database-footer">
          <span>來源層：Notion 論文圖書館</span>
          <span>選取卡片後，可以回到首頁閱讀完整預覽</span>
        </div>
      </section>
      {viewerCard ? (
        <CollectionCardViewer
          card={viewerCard}
          relatedCards={viewerRelatedCards}
          onOpenRelated={setViewerCardId}
          onClose={() => setViewerCardId("")}
        />
      ) : null}
    </main>
  );
}
