"use client";

import { useState, type PointerEvent } from "react";

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

const railCards = Array.from({ length: 12 }, (_, index) => ({
  id: index,
  pattern: ["orbit", "grid", "ladder", "shelf"][index % 4],
  shade: ["rose", "peach", "lilac", "butter"][index % 4],
}));

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

export default function Home() {
  const [selectedId, setSelectedId] = useState("attention");
  const selectedCard = knowledgeCards.find((card) => card.id === selectedId) ?? knowledgeCards[0];

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
            <a href="#today">今日知識</a>
            <a href="/collection">收藏瀏覽</a>
            <a href="#about">關於</a>
          </div>
        </nav>

        <div className="intro-copy">
          <p className="eyebrow">A PERSONAL KNOWLEDGE COLLECTION</p>
          <h1>
            把複雜的知識，
            <em>收藏成一張卡。</em>
          </h1>
          <p className="intro-lede">
            從論文、研究問題與好奇心出發，整理成一張張可以回來閱讀、慢慢理解的知識卡。
          </p>
          <a className="text-link" href="#today">
            開始閱讀 <span aria-hidden="true">↘</span>
          </a>
        </div>

        <div className="intro-stats" aria-label="收藏摘要">
          <div>
            <strong>04</strong>
            <span>示範收藏</span>
          </div>
          <div>
            <strong>02</strong>
            <span>研究主題</span>
          </div>
          <div>
            <strong>∞</strong>
            <span>還能繼續理解</span>
          </div>
        </div>
      </section>

      <section className="knowledge-section" id="today">
        <div className="section-heading">
          <div>
            <p className="eyebrow">TODAY&apos;S CARD</p>
            <h2>今天，先理解一件事。</h2>
          </div>
          <span className="section-note">收藏不是終點，是下次回來的入口。</span>
        </div>

        <div className="featured-layout">
          <div
            className={`featured-card featured-card--${selectedCard.accent}`}
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
              <span>已收藏</span>
            </div>
          </div>

          <article className="knowledge-reading">
            <div className="reading-meta">
              <span>{selectedCard.topic}</span>
              <span>{selectedCard.tags.join(" · ")}</span>
            </div>
            <h3>{selectedCard.title}</h3>
            <p className="reading-question">{selectedCard.question}</p>
            <div className="reading-block reading-block--highlight">
              <span className="reading-label">一句話先懂</span>
              <p>{selectedCard.summary}</p>
            </div>
            <div className="reading-columns">
              <div className="reading-block">
                <span className="reading-label">用生活比喻</span>
                <p>{selectedCard.analogy}</p>
              </div>
              <div className="reading-block">
                <span className="reading-label">再往裡面看</span>
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
            <p className="eyebrow">A SMALL PREVIEW</p>
            <h2>收藏瀏覽</h2>
          </div>
          <div className="preview-heading-copy">
            <p>每一張卡都是一個完整主題。進入資料庫，可以搜尋、整理並查看它們之間的關係。</p>
            <a className="preview-link" href="/collection">
              開啟完整收藏瀏覽 <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
        <div className="collection-grid collection-grid--preview">
          {knowledgeCards.slice(0, 3).map((card) => (
            <KnowledgeCardPreview
              key={card.id}
              card={card}
              active={card.id === selectedId}
              onClick={() => setSelectedId(card.id)}
            />
          ))}
        </div>
      </section>

      <section className="about-section" id="about">
        <div className="about-mark">◎</div>
        <div>
          <p className="eyebrow">A NOTE TO SELF</p>
          <h2>讓每次讀懂，都有地方留下來。</h2>
          <p>
            這裡的知識來自論文、研究與日常好奇。卡片只是外觀，真正想留下的是：我現在終於能用自己的話說明它了。
          </p>
        </div>
        <span className="about-signature">made for slow understanding</span>
      </section>

      <footer className="site-footer">
        <span>知識卡冊 / 研究中的收藏</span>
        <span>prototype 01</span>
      </footer>
    </main>
  );
}
