"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";

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
  tags: string[];
  status: string;
  related: string[];
};

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
    status: "已收藏",
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
    status: "閱讀中",
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
    status: "已收藏",
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
    status: "待整理",
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
      aria-pressed={active}
    >
      <span className="collection-card__accent" aria-hidden="true" />
      <span className="collection-card__topline">
        <span>{card.number}</span>
        <span>{card.topic}</span>
      </span>
      <span className={`collection-card__art collection-card__art--${card.pattern}`}>
        <span className="art-orb" />
        <span className="art-line art-line--one" />
        <span className="art-line art-line--two" />
      </span>
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

function RelationView({
  cards,
  selectedId,
  onSelect,
}: {
  cards: KnowledgeCard[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const visibleIds = new Set(cards.map((card) => card.id));
  const visiblePairs = relationPairs.filter(
    ([first, second]) => visibleIds.has(first) && visibleIds.has(second),
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [positions, setPositions] = useState(initialNodePositions);
  const [lineStyles, setLineStyles] = useState<Record<string, ConnectionStyle>>({});
  const visiblePairKey = visiblePairs.map(([first, second]) => `${first}-${second}`).join("|");

  const startDrag = (event: PointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0) return;
    const nodeBounds = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      offsetX: event.clientX - (nodeBounds.left + nodeBounds.width / 2),
      offsetY: event.clientY - (nodeBounds.top + nodeBounds.height / 2),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    tiltCard(event);
    const drag = dragRef.current;
    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    if (!drag || !canvasBounds) return;

    const nextX = ((event.clientX - canvasBounds.left - drag.offsetX) / canvasBounds.width) * 100;
    const nextY = ((event.clientY - canvasBounds.top - drag.offsetY) / canvasBounds.height) * 100;
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

  useLayoutEffect(() => {
    const updateLines = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const canvasBounds = canvas.getBoundingClientRect();
      const nextStyles: Record<string, ConnectionStyle> = {};

      visiblePairs.forEach(([first, second]) => {
        const startNode = nodeRefs.current[first];
        const endNode = nodeRefs.current[second];
        if (!startNode || !endNode) return;

        const startBounds = startNode.getBoundingClientRect();
        const endBounds = endNode.getBoundingClientRect();
        const start = {
          x: startBounds.left + startBounds.width / 2 - canvasBounds.left,
          y: startBounds.top + startBounds.height / 2 - canvasBounds.top,
        };
        const end = {
          x: endBounds.left + endBounds.width / 2 - canvasBounds.left,
          y: endBounds.top + endBounds.height / 2 - canvasBounds.top,
        };
        const deltaX = end.x - start.x;
        const deltaY = end.y - start.y;
        const distance = Math.hypot(deltaX, deltaY);
        if (distance < 1) return;

        const edgeDistance = (bounds: DOMRect) => {
          const horizontal = deltaX === 0 ? Number.POSITIVE_INFINITY : (bounds.width / 2) / Math.abs(deltaX);
          const vertical = deltaY === 0 ? Number.POSITIVE_INFINITY : (bounds.height / 2) / Math.abs(deltaY);
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
      <div className="relation-canvas" ref={canvasRef} aria-label="知識卡片關聯圖">
        <span className="relation-canvas__grid" aria-hidden="true" />
        {visiblePairs.map(([first, second]) => (
          <span
            className={`relation-line relation-line--${relationKey(first, second)}`}
            key={`${first}-${second}`}
            style={lineStyles[relationKey(first, second)]}
            aria-hidden="true"
          />
        ))}
        {cards.map((card) => (
          <button
            className={`relation-node relation-node--${card.id} ${selectedId === card.id ? "is-selected" : ""}`}
            key={card.id}
            type="button"
            onClick={() => onSelect(card.id)}
            onPointerDown={(event) => startDrag(event, card.id)}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
            onPointerLeave={stopDrag}
            onPointerCancel={stopDrag}
            ref={(node) => {
              nodeRefs.current[card.id] = node;
            }}
            style={positions[card.id] ? { left: `${positions[card.id].x}%`, top: `${positions[card.id].y}%` } : undefined}
            aria-pressed={selectedId === card.id}
          >
            <span className="relation-node__number">{card.number}</span>
            <strong>{card.title}</strong>
            <span>{card.topic}</span>
            <small>{card.related.length} 個關聯</small>
          </button>
        ))}
      </div>
      <p className="relation-hint">拖曳卡片調整位置 · 點擊卡片查看詳細內容</p>
      <div className="relation-legend">
        {visiblePairs.map(([first, second]) => (
          <span key={`legend-${first}-${second}`}>
            <i className={`relation-legend__sample relation-legend__sample--${relationKey(first, second)}`} aria-hidden="true" />
            {relationLabels[relationKey(first, second)]}
          </span>
        ))}
      </div>
    </div>
  );
}

function TableView({
  cards,
  onSelect,
}: {
  cards: KnowledgeCard[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="collection-table-wrap">
      <table className="collection-table">
        <thead>
          <tr>
            <th>卡片</th>
            <th>領域</th>
            <th>狀態</th>
            <th>關聯</th>
            <th>來源</th>
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
              <td>
                <span className={`status-pill status-pill--${card.status === "已收藏" ? "collected" : card.status === "閱讀中" ? "reading" : "pending"}`}>
                  {card.status}
                </span>
              </td>
              <td>{card.related.length} 張卡片</td>
              <td className="table-source">{card.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CollectionPage() {
  const [selectedId, setSelectedId] = useState("attention");
  const [collectionView, setCollectionView] = useState<"cards" | "relations" | "table">("cards");
  const [collectionQuery, setCollectionQuery] = useState("");
  const [activeTopic, setActiveTopic] = useState("全部");
  const topics = ["全部", ...Array.from(new Set(knowledgeCards.map((card) => card.topic)))];
  const filteredCards = knowledgeCards.filter((card) => {
    const searchText = `${card.title} ${card.question} ${card.source} ${card.tags.join(" ")}`.toLowerCase();
    const matchesQuery = searchText.includes(collectionQuery.trim().toLowerCase());
    const matchesTopic = activeTopic === "全部" || card.topic === activeTopic;
    return matchesQuery && matchesTopic;
  });

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
          <div className="view-switcher" aria-label="切換資料庫視圖">
            <span>VIEW</span>
            {([
              ["cards", "卡片"],
              ["relations", "關聯"],
              ["table", "資料表"],
            ] as const).map(([view, label]) => (
              <button
                className={collectionView === view ? "is-active" : ""}
                key={view}
                type="button"
                onClick={() => setCollectionView(view)}
                aria-pressed={collectionView === view}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredCards.length === 0 ? (
          <div className="database-empty">
            <strong>找不到符合的知識卡</strong>
            <span>試著換一個關鍵字，或清除目前的領域篩選。</span>
          </div>
        ) : collectionView === "cards" ? (
          <div className="collection-grid">
            {filteredCards.map((card) => (
              <KnowledgeCardPreview
                key={card.id}
                card={card}
                active={card.id === selectedId}
                onClick={() => setSelectedId(card.id)}
              />
            ))}
          </div>
        ) : collectionView === "relations" ? (
          <RelationView
            cards={filteredCards}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <TableView cards={filteredCards} onSelect={setSelectedId} />
        )}

        <div className="database-footer">
          <span>來源層：Notion 論文圖書館</span>
          <span>選取卡片後，可以回到首頁閱讀完整預覽</span>
        </div>
      </section>
    </main>
  );
}
