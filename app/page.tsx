"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

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

const railCards = Array.from({ length: 12 }, (_, index) => ({
  id: index,
  pattern: ["orbit", "grid", "ladder", "shelf"][index % 4],
  shade: ["rose", "peach", "lilac", "butter"][index % 4],
}));

const downloadUrl = process.env.NEXT_PUBLIC_DOWNLOAD_URL?.trim() ?? "";

function DecorativeCard({
  pattern,
  shade,
}: {
  pattern: string;
  shade: string;
}) {
  return (
    <div className={`rail-card rail-card--${shade}`} aria-hidden="true">
      <span className={`rail-pattern rail-pattern--${pattern}`} />
      <span className="rail-sheen" />
    </div>
  );
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
      className={`collection-card collection-card--${card.accent} ${
        active ? "is-active" : ""
      }`}
      type="button"
      onClick={onClick}
      onPointerMove={tiltCard}
      onPointerLeave={resetTilt}
      onPointerCancel={resetTilt}
      aria-label={`${card.title}。${card.question}。標籤：${card.tags.join("、")}`}
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

  return (
    <div className="relation-workspace">
      <div className="relation-canvas" aria-label="知識卡片關聯圖">
        <span className="relation-canvas__grid" aria-hidden="true" />
        {visiblePairs.map(([first, second]) => (
          <span
            className={`relation-line relation-line--${relationKey(first, second)}`}
            key={`${first}-${second}`}
            aria-hidden="true"
          />
        ))}
        {cards.map((card) => (
          <button
            className={`relation-node relation-node--${card.id} ${
              selectedId === card.id ? "is-selected" : ""
            }`}
            key={card.id}
            type="button"
            onClick={() => onSelect(card.id)}
            onPointerMove={tiltCard}
            onPointerLeave={resetTilt}
            onPointerCancel={resetTilt}
            aria-pressed={selectedId === card.id}
          >
            <span className="relation-node__number">{card.number}</span>
            <strong>{card.title}</strong>
            <span>{card.topic}</span>
            <small>{card.related.length} 個關聯</small>
          </button>
        ))}
      </div>
      <div className="relation-legend">
        {visiblePairs.map(([first, second]) => (
          <span key={`legend-${first}-${second}`}>
            <i aria-hidden="true" />
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
              <td>{card.related.length} 張卡片</td>
              <td className="table-source">{card.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CardViewer({
  card,
  onClose,
}: {
  card: KnowledgeCard;
  onClose: () => void;
}) {
  const [rotation, setRotation] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOrigin = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    rotation: { x: number; y: number };
  } | null>(null);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rotation,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current;
    if (!origin || origin.pointerId !== event.pointerId) return;

    const nextX = Math.max(-24, Math.min(24, origin.rotation.x - (event.clientY - origin.startY) * 0.2));
    const nextY = Math.max(-24, Math.min(24, origin.rotation.y + (event.clientX - origin.startX) * 0.2));
    setRotation({ x: nextX, y: nextY });
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin.current || dragOrigin.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragOrigin.current = null;
    setIsDragging(false);
  };

  return (
    <div className="card-viewer" onClick={onClose}>
      <div
        className="card-viewer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-viewer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="card-viewer__topline">
          <span>OPEN KNOWLEDGE CARD</span>
          <button className="card-viewer__close" type="button" onClick={onClose}>
            關閉 <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="card-viewer__content">
          <div className="card-viewer__card-wrap">
            <p className="card-viewer__hint">DRAG TO ROTATE · 拖曳卡片旋轉檢視</p>
            <div
              className={`featured-card featured-card--${card.accent} card-viewer__card ${
                isDragging ? "is-dragging" : ""
              }`}
              style={{
                transform: `perspective(1050px) rotateX(${rotation.x}deg) rotateY(${rotation.y}deg) rotate(-2deg)`,
                transition: isDragging ? "none" : undefined,
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onLostPointerCapture={handlePointerUp}
            >
              <div className="featured-card__header">
                <span>{card.number}</span>
                <span>{card.topic}</span>
              </div>
              <div className={`featured-art featured-art--${card.pattern}`}>
                <span className="featured-art__ring featured-art__ring--one" />
                <span className="featured-art__ring featured-art__ring--two" />
                <span className="featured-art__dot" />
              </div>
              <div className="featured-card__footer">
                <span>KNOWLEDGE CARD</span>
                <span>CURATED NOTE</span>
              </div>
            </div>
          </div>

          <article className="card-viewer__reading">
            <div className="reading-meta">
              <span>{card.topic}</span>
              <span>{card.tags.join(" · ")}</span>
            </div>
            <h2 id="card-viewer-title">{card.title}</h2>
            <p className="reading-question">{card.question}</p>
            <div className="reading-block reading-block--highlight">
              <span className="reading-label">一句話先懂</span>
              <p>{card.summary}</p>
            </div>
            <div className="reading-columns">
              <div className="reading-block">
                <span className="reading-label">用生活比喻</span>
                <p>{card.analogy}</p>
              </div>
              <div className="reading-block">
                <span className="reading-label">再往裡面看</span>
                <p>{card.detail}</p>
              </div>
            </div>
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

export default function Home() {
  const [selectedId, setSelectedId] = useState("attention");
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const selectedCard = knowledgeCards.find((card) => card.id === selectedId) ?? knowledgeCards[0];

  const openCard = (id: string) => {
    setSelectedId(id);
    setIsViewerOpen(true);
  };

  useEffect(() => {
    if (!isViewerOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsViewerOpen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isViewerOpen]);

  return (
    <main className="site-shell">
      <section className="card-rail" aria-label="收藏卡片裝飾">
        <div className="rail-row rail-row--left">
          {[...railCards, ...railCards].map((card, index) => (
            <DecorativeCard key={`left-${card.id}-${index}`} {...card} />
          ))}
        </div>
        <div className="rail-row rail-row--right">
          {[...railCards.slice(3), ...railCards, ...railCards.slice(0, 3)].map(
            (card, index) => (
              <DecorativeCard key={`right-${card.id}-${index}`} {...card} />
            ),
          )}
        </div>
        <div className="rail-caption" aria-hidden="true">
          <span>COLLECTED THOUGHTS</span>
          <span>研究中的小小收藏</span>
        </div>
      </section>

      <section className="intro-section" id="top">
        <nav className="site-nav" aria-label="主要導覽">
          <a className="brand" href="#top">
            <span className="brand-mark">◎</span>
            <span>知識卡冊</span>
          </a>
          <div className="nav-links">
            <a href="#product">產品功能</a>
            <a href="#preview">收藏預覽</a>
            <a href="#download">下載</a>
            <a href="#about">關於</a>
          </div>
        </nav>

        <div className="intro-copy">
          <p className="eyebrow">KNOWLEDGE CARD CABINET / DESKTOP APP</p>
          <h1>
            把知識整理好，
            <em>帶著自己的收藏走。</em>
          </h1>
          <p className="intro-lede">
            知識卡冊把筆記整理成可閱讀、可搜尋、可連結的知識卡，資料留在自己的裝置裡。
          </p>
          <div className="intro-actions">
            {downloadUrl ? (
              <a className="download-button" href={downloadUrl} target="_blank" rel="noreferrer">
                下載桌面版 <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <a className="download-button download-button--pending" href="#download">
                桌面版準備中 <span aria-hidden="true">↓</span>
              </a>
            )}
            <a className="text-link" href="/collection">
              先瀏覽收藏 <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <div className="intro-stats" aria-label="收藏摘要">
          <div>
            <strong>LOCAL</strong>
            <span>資料留在本機</span>
          </div>
          <div>
            <strong>AI</strong>
            <span>整理與關聯</span>
          </div>
          <div>
            <strong>∞</strong>
            <span>持續累積收藏</span>
          </div>
        </div>
      </section>

      <section className="knowledge-section" id="product">
        <div className="section-heading">
          <div>
            <p className="eyebrow">A KNOWLEDGE CARD IS A READING PATH</p>
            <h2>先回答問題，再慢慢展開。</h2>
          </div>
          <span className="section-note">
            問題、直覺、核心運作與來源，集中在同一個閱讀入口。
          </span>
        </div>

        <div className="featured-layout">
          <div
            className={`featured-card featured-card--${selectedCard.accent}`}
            role="button"
            tabIndex={0}
            aria-label={`開啟${selectedCard.title}知識卡`}
            onClick={() => openCard(selectedCard.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openCard(selectedCard.id);
              }
            }}
            onPointerMove={tiltCard}
            onPointerLeave={resetTilt}
            onPointerCancel={resetTilt}
          >
            <div className="featured-card__header">
              <span>{selectedCard.number}</span>
              <span>{selectedCard.topic}</span>
            </div>
            <div className={`featured-art featured-art--${selectedCard.pattern}`}>
              <span className="featured-art__ring featured-art__ring--one" />
              <span className="featured-art__ring featured-art__ring--two" />
              <span className="featured-art__dot" />
            </div>
            <div className="featured-card__footer">
              <span>KNOWLEDGE CARD</span>
              <span>可回來閱讀</span>
            </div>
          </div>

          <article className="knowledge-reading">
            <div className="reading-meta">
              <span>{selectedCard.topic}</span>
              <span>KNOWLEDGE CARD</span>
            </div>
            <h3>{selectedCard.title}</h3>
            <div className="reading-question-block">
              <span className="reading-label">它在回答什麼</span>
              <p className="reading-question">{selectedCard.question}</p>
            </div>
            <div className="reading-block reading-block--highlight">
              <span className="reading-label">一句話理解</span>
              <p>{selectedCard.summary}</p>
            </div>
            <div className="reading-columns">
              <div className="reading-block">
                <span className="reading-label">用例子理解</span>
                <p>{selectedCard.analogy}</p>
              </div>
              <div className="reading-block">
                <span className="reading-label">核心運作</span>
                <p>{selectedCard.detail}</p>
              </div>
            </div>
            <div className="reading-footer">
              <span>來源</span>
              <span>{selectedCard.source}</span>
            </div>
          </article>
        </div>
      </section>

      <section className="collection-preview-section" id="preview">
        <div className="section-heading section-heading--collection">
          <div>
            <p className="eyebrow">SEE THE COLLECTION IN ACTION</p>
            <h2>卡片與關聯，留在同一個收藏空間。</h2>
          </div>
          <div className="preview-heading-copy">
            <p>每張卡都是一個完整主題。你可以搜尋、整理，還能看見它們之間慢慢長出的關係。</p>
            <a className="preview-link" href="/collection">
              開啟瀏覽版應用程式 <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
        <div className="collection-grid collection-grid--preview">
          {knowledgeCards.slice(0, 3).map((card) => (
            <KnowledgeCardPreview
              key={card.id}
              card={card}
              active={card.id === selectedId}
              onClick={() => openCard(card.id)}
            />
          ))}
        </div>
      </section>

      <section className="download-section" id="download">
        <div className="download-section__intro">
          <p className="eyebrow">TAKE YOUR COLLECTION WITH YOU</p>
          <h2>把知識卡冊，變成一個可以帶走的應用程式。</h2>
          <p className="download-section__copy">
            公開網站會持續介紹產品與版本；桌面版則把收藏、搜尋與關聯留在你的裝置裡。
          </p>
          <div className="download-actions">
            {downloadUrl ? (
              <a className="download-button" href={downloadUrl} target="_blank" rel="noreferrer">
                下載最新版本 <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <a className="download-button download-button--pending" href="#download-status">
                安裝包準備中 <span aria-hidden="true">↓</span>
              </a>
            )}
            <a className="download-secondary" href="/collection">
              先使用瀏覽版
            </a>
          </div>
          <p className="download-status" id="download-status">
            {downloadUrl
              ? "目前版本提供桌面版下載。"
              : "桌面版正在整理成一站式安裝程式；現在可以先使用瀏覽版體驗收藏。"}
          </p>
        </div>
        <div className="download-specs" aria-label="產品特點">
          <div className="download-spec">
            <span>01</span>
            <strong>本機優先</strong>
            <p>收藏資料以自己的裝置為中心，不必先交給外部服務。</p>
          </div>
          <div className="download-spec">
            <span>02</span>
            <strong>AI 整理</strong>
            <p>把原始筆記整理成問題、摘要、例子與核心運作。</p>
          </div>
          <div className="download-spec">
            <span>03</span>
            <strong>語意關聯</strong>
            <p>讓卡片之間的相似概念變成可以繼續探索的路徑。</p>
          </div>
        </div>
      </section>

      <section className="about-section" id="about">
        <div className="about-mark">◎</div>
        <div>
          <p className="eyebrow">A QUIET TOOL FOR UNDERSTANDING</p>
          <h2>讓每次讀懂，都有地方留下來。</h2>
          <p>
            知識卡冊不是把資料堆得更多，而是替每個主題留下清楚的入口。從一個問題開始，慢慢整理成自己真的說得出來的理解。
          </p>
        </div>
        <span className="about-signature">made for slow understanding / built to be yours</span>
      </section>

      <footer className="site-footer">
        <span>知識卡冊 / a personal knowledge cabinet</span>
        <span>desktop app in progress</span>
      </footer>

      {isViewerOpen && <CardViewer card={selectedCard} onClose={() => setIsViewerOpen(false)} />}
    </main>
  );
}
