"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { visualAccents, visualPatterns } from "./types";
import { CardSelect } from "./card-select";
import { RelationView } from "./relation-view";
import {
  CreateCardForm,
  BackgroundTaskPanel,
  ModelSettingsPanel,
  TrashPanel,
} from "./panels";
import { defaultRelationEdges, relationEdgeKey, relationKey } from "./relations";
import type {
  ApiCard,
  ApiProbeResult,
  ApiRelation,
  AppVersion,
  BackgroundTask,
  DuplicatePair,
  CardDraft,
  CardDraftResponse,
  CategoryRecord,
  CollectionView,
  KnowledgeCard,
  ModelCatalog,
  ModelKind,
  ModelOption,
  ModelStorage,
  ProviderSettingsDraft,
  RelationEdge,
  RuntimeSettings,
  EmbeddingProbeResult,
  SettingsDraft,
  SettingsTab,
  PairedDevice,
  PairingCode,
  LanSharingStatus,
  TrashCard,
} from "./types";
import {
  FlipCard,
  KnowledgeCardBack,
  KnowledgeCardFront,
  cornerGlyphFor,
  getCoverStyle,
} from "../card-face";


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
    category: "待分類",
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
    category: card.category ?? card.topic,
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
    created_at: card.created_at,
    updated_at: card.updated_at,
  };
}

/** How long the two full-screen surfaces take to leave, in step with globals.css. */
const VIEWER_EXIT_MS = 200;
const PANEL_EXIT_MS = 200;

const knowledgeCards: KnowledgeCard[] = [
  {
    id: "attention",
    number: "AI-001",
    topic: "人工智慧",
    category: "人工智慧",
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
    category: "人工智慧",
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
    category: "人工智慧",
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
    category: "生成式 AI",
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


function groupCardsByCategory(cards: KnowledgeCard[]) {
  const groups = new Map<string, KnowledgeCard[]>();

  cards.forEach((card) => {
    const group = groups.get(card.category) ?? [];
    group.push(card);
    groups.set(card.category, group);
  });

  return Array.from(groups, ([category, groupedCards]) => ({ category, cards: groupedCards }));
}

/**
 * A category is a labelled section of flat cards, not a stack. Every cover
 * fingerprint stays visible and one click opens the card.
 */
function KnowledgeCardSection({
  category,
  cards,
  selectedId,
  onSelect,
  onOpen,
  searchReasons,
  order = 0,
}: {
  category: string;
  cards: KnowledgeCard[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  searchReasons?: Map<string, string[]>;
  /** Where this category sits down the page, for the entrance stagger. */
  order?: number;
}) {
  return (
    <section
      className="collection-category"
      // A category is only as wide as its cards need, so small ones sit side by
      // side instead of each owning a mostly-empty row.
      // Both counters are capped: an uncapped stagger over three hundred cards
      // would still be arriving a minute after the page loaded.
      style={{ "--cards": Math.min(cards.length, 5), "--s": Math.min(order, 4) } as CSSProperties}
      aria-label={`${category}，${cards.length} 張卡片`}
    >
      <div className="collection-category__head">
        <span className="collection-category__label">CATEGORY</span>
        <strong>{category}</strong>
        <small>{cards.length} 張</small>
        <span className="collection-category__rule" aria-hidden="true" />
      </div>
      <div className="collection-category__grid">
        {cards.map((card, index) => (
          <div className="collection-category__item" key={card.id} style={{ "--i": Math.min(index, 9) } as CSSProperties}>
            <KnowledgeCardFront
              card={card}
              active={card.id === selectedId}
              onClick={() => {
                onSelect(card.id);
                onOpen(card.id);
              }}
            />
            {searchReasons?.get(card.id)?.length ? (
              <small className="collection-category__reason">
                命中：{searchReasons.get(card.id)!.join(" · ")}
              </small>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function CollectionCardViewer({
  closing,
  card,
  relatedCards,
  onOpenRelated,
  onClose,
}: {
  card: KnowledgeCard;
  /** True while the panel is on its way out and must stay mounted. */
  closing: boolean;
  relatedCards: KnowledgeCard[];
  onOpenRelated: (id: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [card.id]);

  return (
    // The backdrop is presentational: dismissal also lives on the close button
    // and the Escape handler, so it needs no role or key handling of its own.
    <div
      className={`card-viewer ${closing ? "is-closing" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="card-viewer__panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-card-viewer-title"
      >
        <div className="card-viewer__topline">
          <span>OPEN KNOWLEDGE CARD</span>
          <button className="card-viewer__close" type="button" onClick={onClose}>
            關閉 <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="card-viewer__content">
          <FlipCard
            key={card.id}
            accent={card.accent}
            front={<KnowledgeCardFront card={card} active onClick={() => undefined} />}
            back={
              <KnowledgeCardBack
                accent={card.accent}
                number={card.number}
                lead={card.summary}
                body={card.analogy || card.detail}
                tags={card.tags}
                neighbours={relatedCards}
                cornerShape={cornerGlyphFor(card.cover?.motifs)}
                style={getCoverStyle(card.cover)}
                onOpenNeighbour={onOpenRelated}
              />
            }
          />
          <article className="card-viewer__reading">
            <div className="reading-meta">
              <span>{card.category}</span>
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
            <th>分類</th>
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
              <td>{card.category}</td>
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


export default function CollectionPage() {
  const [selectedId, setSelectedId] = useState("attention");
  const [viewerCardId, setViewerCardId] = useState("");
  const [collectionView, setCollectionView] = useState<"cards" | "relations" | "table">("cards");
  const [collectionQuery, setCollectionQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("全部");
  const [activeTag, setActiveTag] = useState("全部");
  const [searchSort, setSearchSort] = useState<"relevance" | "updated" | "title">("relevance");
  const [semanticSearchResult, setSemanticSearchResult] = useState<{ query: string; matches: Map<string, { score: number; reasons: string[] }> } | null>(null);
  const [categoryRecords, setCategoryRecords] = useState<CategoryRecord[]>([]);
  const [isCategoryManagerOpen, setIsCategoryManagerOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [selectedCategoryName, setSelectedCategoryName] = useState("");
  const [renamedCategoryName, setRenamedCategoryName] = useState("");
  const [mergeTargetCategory, setMergeTargetCategory] = useState("");
  const [categoryManagerError, setCategoryManagerError] = useState("");
  const [isCategorySaving, setIsCategorySaving] = useState(false);
  const [duplicatePairs, setDuplicatePairs] = useState<DuplicatePair[]>([]);
  const [isDuplicateNoticeOpen, setIsDuplicateNoticeOpen] = useState(false);
  const [cards, setCards] = useState<KnowledgeCard[]>(knowledgeCards);
  const [relationEdgesState, setRelationEdgesState] = useState<ReadonlyArray<RelationEdge>>(defaultRelationEdges);
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
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [isDevicesLoading, setIsDevicesLoading] = useState(false);
  const [isPairingCodeIssuing, setIsPairingCodeIssuing] = useState(false);
  const [revokingDeviceId, setRevokingDeviceId] = useState("");
  const [lanSharing, setLanSharing] = useState<LanSharingStatus | null>(null);
  const [isLanSharingChanging, setIsLanSharingChanging] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelActionId, setModelActionId] = useState("");
  const [backgroundTask, setBackgroundTask] = useState<BackgroundTask | null>(null);
  const [isViewerClosing, setIsViewerClosing] = useState(false);
  const [isSettingsClosing, setIsSettingsClosing] = useState(false);
  const [cardsRefreshKey, setCardsRefreshKey] = useState(0);
  const [appVersion, setAppVersion] = useState<AppVersion | null>(null);

  const isBackgroundTaskRunning = backgroundTask?.status === "queued" || backgroundTask?.status === "running";

  /**
   * Cards that look like the same card twice.
   *
   * This used to be one of four things a batch panel reported, behind a
   * selection and a preview. Tag spellings and the category fallback happen on
   * save now, and the relation suggestions were a copy of what the relation
   * view already draws — so what is left is the one thing that needs a person
   * to look, and it comes to them.
   */
  const loadDuplicates = async () => {
    try {
      const response = await fetch("/api/cards/duplicates", { cache: "no-store" });
      const result = (await response.json().catch(() => ({}))) as { duplicates?: DuplicatePair[] };
      setDuplicatePairs(Array.isArray(result.duplicates) ? result.duplicates : []);
    } catch {
      // A cabinet that cannot answer this is still perfectly usable.
      setDuplicatePairs([]);
    }
  };

  /**
   * Which build this is, and whether a newer one exists.
   *
   * Asked once when the collection opens, never on a timer. The answer is
   * cached for a day on the API side, so opening the app twice in an afternoon
   * is one request, and no answer at all is the ordinary offline case — which
   * is why a failure here sets nothing and says nothing.
   */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/app/version", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: AppVersion | null) => {
        if (!cancelled && payload && typeof payload.version === "string") setAppVersion(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
        try {
          const categoryResponse = await fetch("/api/categories", { cache: "no-store" });
          if (categoryResponse.ok) {
            const categoryPayload = (await categoryResponse.json()) as unknown;
            if (Array.isArray(categoryPayload)) setCategoryRecords(categoryPayload as CategoryRecord[]);
          }
        } catch {
          // The card list remains usable when an older runtime has no category endpoint.
        }

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
        const nextEdges: RelationEdge[] = [];
        const knownEdges = new Set<string>();
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

            const edge: RelationEdge = {
              source_id: cardId,
              target_id: targetId,
              relation_type: relation.relation_type === "manual" ? "manual" : "semantic",
              score: Number(relation.score ?? 0),
              status: relation.status,
              reason: relation.reason,
              created_at: relation.created_at,
              updated_at: relation.updated_at,
            };
            const edgeId = relationEdgeKey(edge);
            if (!knownEdges.has(edgeId)) {
              knownEdges.add(edgeId);
              nextEdges.push(edge);
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
        setRelationEdgesState(relationLoadFailed ? defaultRelationEdges : nextEdges);
        setSelectedId(loadedCards[0]?.id ?? "");
        void loadDuplicates();
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

  useEffect(() => {
    const query = collectionQuery.trim();
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, limit: "50", sort: searchSort });
        if (activeCategory !== "全部") params.set("category", activeCategory);
        if (activeTag !== "全部") params.set("tag", activeTag);
        const response = await fetch(`/api/search?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("semantic search failed");
        const result = (await response.json()) as Array<ApiCard & { score?: number; search_reasons?: string[] }>;
        if (!Array.isArray(result)) throw new Error("invalid semantic search response");
        setSemanticSearchResult({
          query,
          matches: new Map(result.map((card) => [card.id, { score: Number(card.score ?? 0), reasons: card.search_reasons ?? [] }])),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeCategory, activeTag, collectionQuery, searchSort]);

  const semanticSearchMatches = semanticSearchResult?.query === collectionQuery.trim()
    ? semanticSearchResult.matches
    : null;

  const categories = ["全部", ...Array.from(new Set([
    ...categoryRecords.map((category) => category.name),
    ...cards.map((card) => card.category || "待分類"),
  ]))];
  const tags = ["全部", ...Array.from(new Set(cards.flatMap((card) => card.tags)))];
  const filteredCards = cards.filter((card) => {
    const searchText = `${card.title} ${card.topic} ${card.category} ${card.question} ${card.summary} ${card.analogy} ${card.detail} ${card.source} ${card.tags.join(" ")}`.toLowerCase();
    const matchesQuery = searchText.includes(collectionQuery.trim().toLowerCase());
    const matchesCategory = activeCategory === "全部" || card.category === activeCategory;
    const matchesTag = activeTag === "全部" || card.tags.some((tag) => tag.toLocaleLowerCase() === activeTag.toLocaleLowerCase());
    const matchesSemanticSearch = !collectionQuery.trim() || !semanticSearchMatches || semanticSearchMatches.has(card.id);
    return matchesQuery && matchesCategory && matchesTag && matchesSemanticSearch;
  }).sort((first, second) => searchSort === "updated" ? String(second.updated_at ?? second.number).localeCompare(String(first.updated_at ?? first.number)) : searchSort === "title" ? first.title.localeCompare(second.title) : semanticSearchMatches ? (semanticSearchMatches.get(second.id)?.score ?? 0) - (semanticSearchMatches.get(first.id)?.score ?? 0) : first.number.localeCompare(second.number));
  const getSearchReasons = (card: KnowledgeCard) => {
    const reasons: string[] = [];
    const query = collectionQuery.trim().toLocaleLowerCase();
    const remoteReasons = semanticSearchMatches?.get(card.id)?.reasons ?? [];
    if (remoteReasons.length) reasons.push(...remoteReasons);
    else if (query && `${card.title} ${card.topic} ${card.category} ${card.question} ${card.summary} ${card.analogy} ${card.detail} ${card.source} ${card.tags.join(" ")}`.toLocaleLowerCase().includes(query)) reasons.push("關鍵字命中");
    if (activeCategory !== "全部" && card.category === activeCategory) reasons.push("同分類");
    if (activeTag !== "全部" && card.tags.some((tag) => tag.toLocaleLowerCase() === activeTag.toLocaleLowerCase())) reasons.push("共享標籤");
    return Array.from(new Set(reasons));
  };
  const cardGroups = groupCardsByCategory(filteredCards);
  const searchReasonsById = new Map(filteredCards.map((card) => [card.id, getSearchReasons(card)]));
  const viewerCard = cards.find((card) => card.id === viewerCardId);
  const viewerRelatedCards = viewerCard
    ? viewerCard.related
      .map((relatedId) => cards.find((card) => card.id === relatedId))
      .filter((card): card is KnowledgeCard => Boolean(card))
    : [];

  /**
   * Both full-screen surfaces leave before they unmount.
   *
   * The card that is on screen has to stay on screen while the panel sinks —
   * clearing the id first would blank the panel and then animate the blank —
   * so closing is a flag now and the unmount happens on a timer.
   */
  const closeViewer = useCallback(() => {
    if (isViewerClosing) return;
    setIsViewerClosing(true);
    window.setTimeout(() => {
      setIsViewerClosing(false);
      setViewerCardId("");
    }, VIEWER_EXIT_MS);
  }, [isViewerClosing]);

  const dismissSettings = useCallback(() => {
    if (isSettingsClosing) return;
    setIsSettingsClosing(true);
    window.setTimeout(() => {
      setIsSettingsClosing(false);
      setIsModelsOpen(false);
    }, PANEL_EXIT_MS);
  }, [isSettingsClosing]);

  useEffect(() => {
    if (!viewerCardId) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeViewer();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeViewer, viewerCardId]);

  useEffect(() => {
    if (!isModelsOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      // A background task deliberately does not hold this shut: it keeps
      // running, and the docked panel follows it outside the settings.
      if (event.key === "Escape" && !modelActionId && !isSettingsSaving && !isDatabaseExporting && !isDatabaseImporting && !isDatabaseResetting) {
        setModelError("");
        dismissSettings();
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissSettings, isBackgroundTaskRunning, isDatabaseExporting, isDatabaseImporting, isDatabaseResetting, isModelsOpen, isSettingsSaving, modelActionId]);

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
      category: card.category,
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

  /**
   * Follows a background task without holding anyone up.
   *
   * Downloading a 570 MB model and rebuilding every card's vector are minutes
   * of work. They used to be awaited inside the click handler, which left the
   * settings form disabled and the panel refusing to close until the work
   * finished — the app was unusable for the duration of a job that has nothing
   * to do with the rest of it. Now the handler fires the request, this picks
   * up the task id, and the progress panel is the only thing that waits.
   */
  const watchedTasksRef = useRef(new Map<string, Promise<BackgroundTask | null>>());
  const watchBackgroundTask = (
    taskId: string,
    { onDone, silent = false }: { onDone?: (task: BackgroundTask) => void; silent?: boolean } = {},
  ): Promise<BackgroundTask | null> => {
    const running = watchedTasksRef.current.get(taskId);
    if (running) return running;
    const fail = (message: string) => {
      if (!silent) setModelError(message);
      return null;
    };
    const watch = (async (): Promise<BackgroundTask | null> => {
      try {
        // Half an hour: a large model on a slow connection, plus the reindex.
        for (let attempt = 0; attempt < 1800; attempt += 1) {
          const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
          const task = (await response.json()) as BackgroundTask | { detail?: string };
          if (!response.ok || !("task_id" in task)) {
            throw new Error("detail" in task ? task.detail ?? "背景任務狀態讀取失敗。" : "背景任務狀態讀取失敗。");
          }
          setBackgroundTask(task);
          if (task.status === "succeeded") {
            onDone?.(task);
            return task;
          }
          if (task.status === "failed" || task.status === "cancelled") {
            return fail(task.error || task.message || "背景任務未完成。");
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        return fail("背景任務執行時間較長，請稍後重新查看狀態。");
      } catch (error) {
        return fail(error instanceof Error ? error.message : "背景任務狀態讀取失敗。");
      }
    })();
    watchedTasksRef.current.set(taskId, watch);
    void watch.finally(() => watchedTasksRef.current.delete(taskId));
    return watch;
  };

  const loadBackgroundTasks = async () => {
    try {
      const response = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const result = (await response.json()) as BackgroundTask[] | { detail?: string };
      if (!response.ok || !Array.isArray(result)) return;
      const latest = result.find((task) => task.status === "queued" || task.status === "running") ?? null;
      setBackgroundTask(latest);
      if (latest?.status === "queued" || latest?.status === "running") {
        // Reopening the app mid-job: pick the task back up where it was.
        void watchBackgroundTask(latest.task_id, {
          onDone: () => {
            setCardsRefreshKey((current) => current + 1);
            void loadModels(false);
          },
        });
      }
    } catch {
      // Model settings remain usable when task history is temporarily unavailable.
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBackgroundTasks();
    }, 0);
    return () => window.clearTimeout(timer);
    // Background task recovery intentionally runs once when the collection page mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const loadDevices = async () => {
    setIsDevicesLoading(true);
    try {
      const response = await fetch("/api/devices", { cache: "no-store" });
      const result = (await response.json()) as PairedDevice[] | { detail?: string };
      if (!response.ok || !Array.isArray(result)) throw new Error("detail" in result ? result.detail ?? "裝置清單載入失敗。" : "裝置清單載入失敗。");
      setDevices(result);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "裝置清單載入失敗，請稍後再試。");
    } finally {
      setIsDevicesLoading(false);
    }
  };

  const loadLanSharing = async () => {
    try {
      const response = await fetch("/api/network/lan", { cache: "no-store" });
      const result = (await response.json()) as LanSharingStatus | { detail?: string };
      if (!response.ok || !("enabled" in result)) throw new Error("detail" in result ? result.detail ?? "區網狀態讀取失敗。" : "區網狀態讀取失敗。");
      setLanSharing(result);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "區網狀態讀取失敗。");
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
    void Promise.all([loadModels(), loadRuntimeSettings(), loadBackgroundTasks(), loadDevices(), loadLanSharing()]);
  };

  const handleIssuePairingCode = async () => {
    setIsPairingCodeIssuing(true);
    setModelError("");
    try {
      const response = await fetch("/api/devices/pairing-code", { method: "POST" });
      const result = (await response.json()) as PairingCode | { detail?: string };
      if (!response.ok || !("code" in result) || !("expires_at" in result)) throw new Error("detail" in result ? result.detail ?? "配對碼產生失敗。" : "配對碼產生失敗。");
      setPairingCode(result);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "配對碼產生失敗，請稍後再試。");
    } finally {
      setIsPairingCodeIssuing(false);
    }
  };

  const handleRevokeDevice = async (id: string) => {
    setRevokingDeviceId(id);
    setModelError("");
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = (await response.json()) as { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "裝置撤銷失敗。");
      await loadDevices();
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "裝置撤銷失敗，請稍後再試。");
    } finally {
      setRevokingDeviceId("");
    }
  };

  /** Removes the record of a device that has already been revoked. */
  const handleForgetDevice = async (id: string) => {
    setRevokingDeviceId(id);
    setModelError("");
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(id)}?purge=1`, { method: "DELETE" });
      const result = (await response.json()) as { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "裝置紀錄刪除失敗。");
      await loadDevices();
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "裝置紀錄刪除失敗，請稍後再試。");
    } finally {
      setRevokingDeviceId("");
    }
  };

  const setLanSharingEnabled = async (enabled: boolean) => {
    setIsLanSharingChanging(true);
    setModelError("");
    try {
      const response = await fetch("/api/network/lan", { method: enabled ? "POST" : "DELETE" });
      const result = (await response.json()) as LanSharingStatus | { detail?: string };
      if (!response.ok || !("enabled" in result)) throw new Error("detail" in result ? result.detail ?? "區網分享設定失敗。" : "區網分享設定失敗。");
      setLanSharing(result);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "區網分享設定失敗。");
    } finally {
      setIsLanSharingChanging(false);
    }
  };

  const closeModels = () => {
    if (modelActionId || isSettingsSaving || isDatabaseExporting || isDatabaseImporting || isDatabaseResetting) return;
    dismissSettings();
    setModelError("");
    // A finished task can go; a running one keeps its panel, docked in the
    // corner of the collection, because it is still doing something.
    if (!isBackgroundTaskRunning) setBackgroundTask(null);
  };

  const updateSettingsDraft = (kind: ModelKind, field: keyof ProviderSettingsDraft, value: string | boolean) => {
    setSettingsDraft((current) => ({
      ...current,
      [kind]: { ...current[kind], [field]: value },
    }));
  };

  const handleCancelTask = async () => {
    if (!backgroundTask || !isBackgroundTaskRunning) return;
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(backgroundTask.task_id)}/cancel`, { method: "POST" });
      const result = (await response.json()) as BackgroundTask | { detail?: string };
      if (!response.ok || !("task_id" in result)) throw new Error("detail" in result ? result.detail ?? "背景任務取消失敗。" : "背景任務取消失敗。");
      setBackgroundTask(result);
      setModelActionId("");
      setModelError("");
      void loadModels(false);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "背景任務取消失敗，請稍後再試。");
    }
  };

  const handleRetryTask = async () => {
    if (!backgroundTask || isBackgroundTaskRunning || !backgroundTask.can_retry) return;
    setModelError("");
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(backgroundTask.task_id)}/retry`, { method: "POST" });
      const result = (await response.json()) as BackgroundTask | { detail?: string };
      if (!response.ok || !("task_id" in result)) throw new Error("detail" in result ? result.detail ?? "背景任務重試失敗。" : "背景任務重試失敗。");
      setBackgroundTask(result);
      setCreateSuccess(`已重新開始「${result.label || "背景任務"}」。`);
      void watchBackgroundTask(result.task_id, {
        onDone: (completed) => {
          setCreateSuccess(`${completed.label || "背景任務"}已重試完成。`);
          setModelError("");
          void loadModels(false);
          if (completed.operation === "model_select") setCardsRefreshKey((current) => current + 1);
        },
      });
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "背景任務重試失敗，請稍後再試。");
    }
  };

  const handleInspectModel = async (modelId: string) => {
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(modelId)}/inspect`, { cache: "no-store" });
      const result = (await response.json()) as ModelStorage | { detail?: string };
      if (!response.ok || !("status" in result)) throw new Error("detail" in result ? result.detail ?? "模型檔案檢查失敗。" : "模型檔案檢查失敗。");
      setModelCatalog((current) => current ? { ...current, models: current.models.map((model) => model.id === modelId ? { ...model, storage: result } : model) } : current);
      setCreateSuccess(`已檢查「${modelId}」：${result.size_label}，${result.status === "partial" ? "可續傳下載。" : result.status === "ready" ? "檔案完整。" : "尚未建立快取。"}`);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型檔案檢查失敗，請稍後再試。");
    }
  };

  const handleRemoveModel = async (modelId: string) => {
    if (!window.confirm("確定要清理這個模型的本機檔案嗎？之後仍可重新下載，既有卡片資料不會被刪除。")) return;
    setModelActionId(modelId);
    setModelError("");
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
      const result = (await response.json()) as { detail?: string; model?: ModelStorage };
      if (!response.ok || !result.model) throw new Error(result.detail ?? "模型檔案清理失敗。");
      setModelCatalog((current) => current ? { ...current, models: current.models.map((model) => model.id === modelId ? { ...model, installed: false, status: "available", storage: result.model, error: "" } : model) } : current);
      setCreateSuccess(`已清理「${modelId}」的本機模型檔案。`);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型檔案清理失敗，請稍後再試。");
    } finally {
      setModelActionId("");
    }
  };

  const handleAddCustomModel = async (input: { kind: ModelKind; model_id: string; label: string; dimensions: string }) => {
    setModelActionId("custom-add");
    setModelError("");
    try {
      const response = await fetch("/api/models/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: input.kind,
          model_id: input.model_id,
          label: input.label,
          dimensions: Number(input.dimensions) || 0,
        }),
      });
      const result = (await response.json()) as { detail?: string; models?: ModelCatalog; model?: ModelOption };
      if (!response.ok || !result.models) throw new Error(result.detail ?? "無法加入這個模型。");
      setModelCatalog(result.models);
      setCreateSuccess(`已加入「${result.model?.label ?? input.model_id}」，可以在清單中下載它。`);
      return true;
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "無法加入這個模型，請稍後再試。");
      return false;
    } finally {
      setModelActionId("");
    }
  };

  const handleRemoveCustomModel = async (modelId: string) => {
    if (!window.confirm("確定要從清單中移除這個模型嗎？已下載的檔案也會一併清理，卡片資料不會被刪除。")) return;
    setModelActionId(modelId);
    setModelError("");
    try {
      const response = await fetch(`/api/models/custom/${encodeURIComponent(modelId)}`, { method: "DELETE" });
      const result = (await response.json()) as { detail?: string; models?: ModelCatalog };
      if (!response.ok || !result.models) throw new Error(result.detail ?? "無法移除這個模型。");
      setModelCatalog(result.models);
      setCreateSuccess("已從清單中移除這個模型。");
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "無法移除這個模型，請稍後再試。");
    } finally {
      setModelActionId("");
    }
  };

  const handleProbeApi = async (kind: ModelKind): Promise<ApiProbeResult> => {
    const draft = settingsDraft[kind];
    try {
      const response = await fetch("/api/models/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_url: draft.api_url, api_key: draft.api_key }),
      });
      const result = (await response.json()) as ApiProbeResult & { detail?: string };
      if (!response.ok) return { ok: false, endpoint: "", models: [], detail: result.detail ?? "偵測失敗。" };
      return result;
    } catch {
      return { ok: false, endpoint: "", models: [], detail: "無法連線到本機 API。" };
    }
  };

  /**
   * Measures the vector width of the embedding API currently in the draft.
   *
   * Uses the draft rather than the saved settings on purpose: the point is to
   * find out what a service does *before* committing to it, since saving an
   * incompatible width is what forces every card's vector to be rebuilt.
   */
  const handleProbeEmbedding = async (): Promise<EmbeddingProbeResult> => {
    const draft = settingsDraft.embedding;
    const failure = (detail: string): EmbeddingProbeResult => ({ ok: false, dimensions: 0, detail, store_dimensions: 0, matches_store: null, card_count: 0 });
    try {
      const response = await fetch("/api/models/api/probe-embedding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_url: draft.api_url, api_key: draft.api_key, model: draft.model, api_format: draft.api_format }),
      });
      const result = (await response.json()) as EmbeddingProbeResult & { detail?: string };
      if (!response.ok) return failure(result.detail ?? "測量失敗。");
      return result;
    } catch {
      return failure("無法連線到本機 API。");
    }
  };

  const handleSaveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBackgroundTaskRunning) return;
    setIsSettingsSaving(true);
    setBackgroundTask(null);
    setModelError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsDraft),
      });
      const result = (await response.json()) as { detail?: string; settings?: RuntimeSettings; reindexed_cards?: number; task_id?: string };
      if (!response.ok || !result.settings) throw new Error(result.detail ?? "設定套用失敗。");
      setRuntimeSettings(result.settings);
      setSettingsDraft(createSettingsDraft(result.settings));
      setModelError("");
      if (result.task_id) {
        setCreateSuccess("設定已送出，正在背景重建語意關聯。可以關掉設定繼續使用卡片。");
        void watchBackgroundTask(result.task_id, { onDone: (task) => {
          const done = (task.result ?? {}) as { reindexed_cards?: number };
          setCreateSuccess(
            done.reindexed_cards
              ? `設定已套用，並重新建立 ${done.reindexed_cards} 張卡片的語意關聯。`
              : "設定已套用。",
          );
          setCardsRefreshKey((current) => current + 1);
          void loadRuntimeSettings();
        } });
        return;
      }
      setCreateSuccess("設定已套用。");
      if (settingsDraft.embedding.source === "api") setCardsRefreshKey((current) => current + 1);
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
      setRelationEdgesState([]);
      setSelectedId("");
      setViewerCardId("");
      setCollectionQuery("");
      setActiveCategory("全部");
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

      const previewResponse = await fetch("/api/database/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const preview = (await previewResponse.json().catch(() => ({}))) as {
        valid?: boolean;
        detail?: string;
        summary?: { cards?: number; relations?: number; duplicate_ids?: number; invalid_cards?: number; invalid_relations?: number; added_cards?: number; updated_cards?: number; skipped_cards?: number; removed_cards?: number; changed_cards?: number; added_categories?: number; removed_categories?: number };
        changes?: { updated_cards?: Array<{ id: string; title: string; fields: string[] }>; added_categories?: string[]; removed_categories?: string[] };
      };
      if (!previewResponse.ok || !preview.valid) {
        throw new Error(preview.detail ?? `匯入預覽未通過：${preview.summary?.duplicate_ids ?? 0} 個重複 ID、${preview.summary?.invalid_cards ?? 0} 張欄位不完整卡片。`);
      }
      const strategy = window.prompt(
        `備份檔案驗證通過，共 ${preview.summary?.cards ?? 0} 張卡片、${preview.summary?.relations ?? 0} 條關聯。\n請選擇匯入衝突策略：replace（取代全部）、skip（保留現有同 ID）、update（更新同 ID）：`,
        "replace",
      )?.trim().toLowerCase();
      if (!strategy || !["replace", "skip", "update"].includes(strategy)) return;
      payload = { ...(payload as Record<string, unknown>), conflict_strategy: strategy };

      const strategyPreviewResponse = await fetch("/api/database/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const strategyPreview = (await strategyPreviewResponse.json().catch(() => ({}))) as {
        valid?: boolean;
        detail?: string;
        summary?: { added_cards?: number; updated_cards?: number; skipped_cards?: number; removed_cards?: number; changed_cards?: number; added_categories?: number; removed_categories?: number; relations?: number };
        changes?: { updated_cards?: Array<{ id: string; title: string; fields: string[] }>; added_categories?: string[]; removed_categories?: string[] };
      };
      if (!strategyPreviewResponse.ok || !strategyPreview.valid) {
        throw new Error(strategyPreview.detail ?? "無法產生這個衝突策略的匯入預覽。");
      }
      const strategySummary = strategyPreview.summary ?? {};
      const changedPreview = (strategyPreview.changes?.updated_cards ?? [])
        .slice(0, 5)
        .map((item) => `- ${item.title || item.id}：${item.fields.join("、")}`)
        .join("\n");
      const confirmed = window.confirm(
        `即將以 ${strategy} 策略匯入：\n新增 ${strategySummary.added_cards ?? 0}、更新 ${strategySummary.updated_cards ?? 0}、略過 ${strategySummary.skipped_cards ?? 0}、移除 ${strategySummary.removed_cards ?? 0} 張卡片。\n分類新增 ${strategySummary.added_categories ?? 0}、移除 ${strategySummary.removed_categories ?? 0}，保留 ${strategySummary.relations ?? 0} 條關聯。${strategySummary.changed_cards ? `\n有 ${strategySummary.changed_cards} 張既有卡片內容不同：\n${changedPreview}` : ""}\n\n確定要匯入嗎？`,
      );
      if (!confirmed) return;

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
    if (isBackgroundTaskRunning) return;
    setModelActionId(modelId);
    setBackgroundTask(null);
    setModelError("");
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(modelId)}/download`, { method: "POST" });
      const result = (await response.json()) as { detail?: string; task_id?: string };
      if (!response.ok) throw new Error(result.detail ?? "模型下載無法開始。");

      if (!result.task_id) throw new Error("模型下載無法開始。");
      setCreateSuccess("下載已開始，進度在下方；可以關掉設定繼續使用卡片。");
      void watchBackgroundTask(result.task_id, { onDone: () => {
        void (async () => {
          const latest = await loadModels(false);
          const model = latest?.models.find((candidate) => candidate.id === modelId);
          if (model?.error) {
            setModelError(model.error);
            return;
          }
          setCreateSuccess(`已下載「${model?.label ?? modelId}」，現在可以啟用它。`);
        })();
      } });
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型下載失敗，請稍後再試。");
    } finally {
      setModelActionId("");
      void loadModels(false);
    }
  };

  const handleSelectModel = async (kind: ModelKind, modelId: string) => {
    if (isBackgroundTaskRunning) return;
    setModelActionId(modelId);
    setBackgroundTask(null);
    setModelError("");
    try {
      const response = await fetch("/api/models/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, model_id: modelId }),
      });
      const result = (await response.json()) as { detail?: string; selection?: { model?: ModelOption }; models?: ModelCatalog; task_id?: string };
      if (!response.ok) throw new Error(result.detail ?? "模型啟用失敗。");
      if (result.models) setModelCatalog(result.models);
      if (result.task_id) {
        setModelError("");
        setCreateSuccess(`「${result.selection?.model?.label ?? "本機模型"}」已啟用，正在背景重建語意索引。可以關掉設定繼續使用卡片。`);
        void watchBackgroundTask(result.task_id, { onDone: (task) => {
          const taskResult = task.result as { selection?: { model?: ModelOption }; models?: ModelCatalog; reindexed_cards?: number } | null | undefined;
          if (taskResult?.models) setModelCatalog(taskResult.models);
          setCreateSuccess(`已啟用「${taskResult?.selection?.model?.label ?? result.selection?.model?.label ?? "本機模型"}」。已完成 ${taskResult?.reindexed_cards ?? 0} 張卡片的語意索引更新。`);
          setCardsRefreshKey((current) => current + 1);
        } });
      } else {
        setCreateSuccess(`已啟用「${result.selection?.model?.label ?? "本機模型"}」。${kind === "embedding" ? "卡片關聯正在使用新的語意索引。" : ""}`);
      }
      if (kind === "embedding") setCardsRefreshKey((current) => current + 1);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "模型啟用失敗，請稍後再試。");
    } finally {
      setModelActionId("");
    }
  };

  const handleCreateCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newCategoryName.trim();
    if (!name) return;
    setIsCategorySaving(true);
    setCategoryManagerError("");
    try {
      const response = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = (await response.json().catch(() => ({}))) as CategoryRecord & { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "新增分類失敗。");
      setCategoryRecords((current) => [...current.filter((item) => item.name !== result.name), result]);
      setNewCategoryName("");
      setCreateSuccess(`已新增分類「${result.name}」。`);
    } catch (error) {
      setCategoryManagerError(error instanceof Error ? error.message : "新增分類失敗。");
    } finally {
      setIsCategorySaving(false);
    }
  };

  const handleRenameCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCategoryName || !renamedCategoryName.trim()) return;
    setIsCategorySaving(true);
    setCategoryManagerError("");
    try {
      const response = await fetch(`/api/categories/${encodeURIComponent(selectedCategoryName)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renamedCategoryName.trim() }),
      });
      const result = (await response.json().catch(() => ({}))) as { detail?: string; name?: string; source?: string; task_id?: string };
      if (!response.ok || !result.name) throw new Error(result.detail ?? "重新命名分類失敗。");
      if (result.task_id && !(await watchBackgroundTask(result.task_id, { silent: true }))) {
        throw new Error("重新命名分類未完成。");
      }
      setCategoryRecords((current) => current.map((item) => item.name === selectedCategoryName ? { ...item, name: result.name! } : item));
      setSelectedCategoryName("");
      setRenamedCategoryName("");
      setCardsRefreshKey((current) => current + 1);
      setCreateSuccess(`已將分類重新命名為「${result.name}」。`);
    } catch (error) {
      setCategoryManagerError(error instanceof Error ? error.message : "重新命名分類失敗。");
    } finally {
      setIsCategorySaving(false);
    }
  };

  const handleMergeCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCategoryName || !mergeTargetCategory || selectedCategoryName === mergeTargetCategory) return;
    setIsCategorySaving(true);
    setCategoryManagerError("");
    try {
      const response = await fetch("/api/categories/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: selectedCategoryName, target: mergeTargetCategory }),
      });
      const result = (await response.json().catch(() => ({}))) as { detail?: string; name?: string; affected_cards?: number; task_id?: string };
      if (!response.ok || !result.name) throw new Error(result.detail ?? "合併分類失敗。");
      if (result.task_id && !(await watchBackgroundTask(result.task_id, { silent: true }))) {
        throw new Error("合併分類未完成。");
      }
      setSelectedCategoryName("");
      setMergeTargetCategory("");
      setCardsRefreshKey((current) => current + 1);
      setCreateSuccess(`已合併分類，${result.affected_cards ?? 0} 張卡片歸入「${result.name}」。`);
    } catch (error) {
      setCategoryManagerError(error instanceof Error ? error.message : "合併分類失敗。");
    } finally {
      setIsCategorySaving(false);
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
      setRelationEdgesState((current) => current.filter((edge) => edge.source_id !== id && edge.target_id !== id));
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
        category: generated.category ?? generated.topic ?? current.category,
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
        category: cardDraft.category.trim() || cardDraft.topic.trim(),
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
        setRelationEdgesState((current) => {
          const next = current.filter((edge) => edge.source_id !== updatedCard.id && edge.target_id !== updatedCard.id);
          suggestedIds.forEach((targetId) => {
            if (!next.some((edge) => edge.relation_type === "semantic" && relationKey(edge.source_id, edge.target_id) === relationKey(updatedCard.id, targetId))) {
              next.push({
                source_id: updatedCard.id,
                target_id: targetId,
                relation_type: "semantic",
                score: 0,
                status: "suggested",
              });
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
      setRelationEdgesState((current) => {
        const next = [...current];
        suggestedIds.forEach((targetId) => {
          if (!next.some((edge) => edge.relation_type === "semantic" && relationKey(edge.source_id, edge.target_id) === relationKey(createdCard.id, targetId))) {
            next.push({
              source_id: createdCard.id,
              target_id: targetId,
              relation_type: "semantic",
              score: 0,
              status: "suggested",
            });
          }
        });
        return next;
      });
      setSelectedId(createdCard.id);
      setActiveCategory("全部");
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
        {/*
          Not a link. The product has no front page — `/` redirects straight
          back here — so both of these used to be a way of clicking on the page
          you were already on. What belongs in that corner instead is the one
          thing the reader cannot otherwise find out: which build this is.
        */}
        <span className="brand">
          <span className="brand-mark">◎</span>
          <span>知識卡冊</span>
        </span>
        <span className="collection-page-label">DATABASE / COLLECTION</span>
        {appVersion ? (
          appVersion.update_available && appVersion.release_url ? (
            <a
              className="collection-page-version collection-page-version--update"
              href={appVersion.release_url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="collection-page-version__dot" aria-hidden="true" />
              有新版本 {appVersion.latest_version} ↗
            </a>
          ) : (
            <span className="collection-page-version">v{appVersion.version}</span>
          )
        ) : null}
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
          <CardSelect
            className="database-filter-select database-category-filter"
            label="分類"
            value={activeCategory}
            onChange={setActiveCategory}
            options={categories.map((category) => ({ value: category, label: category }))}
          />
          <CardSelect
            className="database-filter-select"
            label="標籤"
            value={activeTag}
            onChange={setActiveTag}
            options={tags.map((tag) => ({ value: tag, label: tag }))}
          />
          <CardSelect
            className="database-filter-select"
            label="排序"
            value={searchSort}
            onChange={(next) => setSearchSort(next as typeof searchSort)}
            options={[
              { value: "relevance", label: "預設順序" },
              { value: "updated", label: "最近更新" },
              { value: "title", label: "標題 A-Z" },
            ]}
          />
          <button className={`database-category-button ${isCategoryManagerOpen ? "is-active" : ""}`} type="button" onClick={() => { setCategoryManagerError(""); setIsCategoryManagerOpen((current) => !current); }}>
            管理分類
          </button>
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
        {duplicatePairs.length ? (
          <section className="duplicate-notice" aria-label="疑似重複的卡片">
            <button
              className="duplicate-notice__face"
              type="button"
              aria-expanded={isDuplicateNoticeOpen}
              onClick={() => setIsDuplicateNoticeOpen((current) => !current)}
            >
              <span className="duplicate-notice__count">{duplicatePairs.length}</span>
              <span>組卡片看起來重複了</span>
              <span className="duplicate-notice__toggle">{isDuplicateNoticeOpen ? "收起" : "看看是哪些"}</span>
            </button>
            {isDuplicateNoticeOpen ? (
              <ul className="duplicate-notice__list">
                {duplicatePairs.slice(0, 8).map((pair) => (
                  <li key={`${pair.source_id}-${pair.target_id}`}>
                    <button type="button" onClick={() => setViewerCardId(pair.source_id)}>{pair.source_title || pair.source_id}</button>
                    <span aria-hidden="true">↔</span>
                    <button type="button" onClick={() => setViewerCardId(pair.target_id)}>{pair.target_title || pair.target_id}</button>
                    <small>{pair.reason}{pair.reason === "標題相同" ? "" : ` · 用字重疊 ${Math.round(pair.score * 100)}%`}</small>
                  </li>
                ))}
                {duplicatePairs.length > 8 ? <li className="duplicate-notice__more">還有 {duplicatePairs.length - 8} 組</li> : null}
              </ul>
            ) : null}
          </section>
        ) : null}
        {isCategoryManagerOpen ? (
          <section className="category-manager" aria-label="分類管理">
            <div className="category-manager__heading">
              <div><span className="eyebrow">CATEGORY CONTROL</span><strong>分類管理</strong></div>
              <small>未分類卡片會集中在「待分類」，不會被誤刪。</small>
            </div>
            <div className="category-manager__list">
              {categories.filter((category) => category !== "全部").map((category) => {
                const count = categoryRecords.find((item) => item.name === category)?.card_count ?? cards.filter((card) => (card.category || "待分類") === category).length;
                return <button key={category} type="button" className={selectedCategoryName === category ? "is-active" : ""} onClick={() => { setSelectedCategoryName(category); setRenamedCategoryName(category); setMergeTargetCategory(""); }}>{category}<small>{count} 張</small></button>;
              })}
            </div>
            <div className="category-manager__forms">
              <form onSubmit={(event) => void handleCreateCategory(event)}><label><span>新增分類</span><input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="例如：資料工程" /></label><button type="submit" disabled={isCategorySaving}>新增</button></form>
              {selectedCategoryName && selectedCategoryName !== "待分類" ? <>
                <form onSubmit={(event) => void handleRenameCategory(event)}><label><span>重新命名「{selectedCategoryName}」</span><input value={renamedCategoryName} onChange={(event) => setRenamedCategoryName(event.target.value)} /></label><button type="submit" disabled={isCategorySaving}>套用</button></form>
                <form onSubmit={(event) => void handleMergeCategory(event)}><CardSelect label="合併到" placeholder="選擇目標分類" value={mergeTargetCategory} onChange={setMergeTargetCategory} options={categories.filter((category) => category !== "全部" && category !== selectedCategoryName).map((category) => ({ value: category, label: category }))} /><button type="submit" disabled={isCategorySaving || !mergeTargetCategory}>合併</button></form>
              </> : null}
            </div>
            {categoryManagerError ? <p className="category-manager__error" role="alert">{categoryManagerError}</p> : null}
          </section>
        ) : null}
        {isCreateCardOpen ? (
          <CreateCardForm
            draft={cardDraft}
            categoryOptions={categories.filter((category) => category !== "全部")}
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
          <div
            className={`settings-modal-backdrop ${isSettingsClosing ? "is-closing" : ""}`}
            role="presentation"
            onMouseDown={(event) => { if (event.target === event.currentTarget) closeModels(); }}
          >
            <ModelSettingsPanel
              catalog={modelCatalog}
              runtimeSettings={runtimeSettings}
              settingsDraft={settingsDraft}
              settingsTab={settingsTab}
              backgroundTask={backgroundTask}
              isBackgroundTaskRunning={isBackgroundTaskRunning}
              isLoading={isModelsLoading}
              isSettingsSaving={isSettingsSaving}
              isDatabaseExporting={isDatabaseExporting}
              isDatabaseImporting={isDatabaseImporting}
              isDatabaseResetting={isDatabaseResetting}
              hasDatabaseBackup={hasDatabaseBackup}
              databaseBackupAcknowledged={databaseBackupAcknowledged}
              databaseResetConfirmation={databaseResetConfirmation}
              devices={devices}
              pairingCode={pairingCode}
              isDevicesLoading={isDevicesLoading}
              isPairingCodeIssuing={isPairingCodeIssuing}
              revokingDeviceId={revokingDeviceId}
              error={modelError}
              actionId={modelActionId}
              onClose={closeModels}
              onDownload={(id) => void handleDownloadModel(id)}
              onSelect={(kind, id) => void handleSelectModel(kind, id)}
              onInspect={(id) => void handleInspectModel(id)}
              onRemove={(id) => void handleRemoveModel(id)}
              onAddCustomModel={handleAddCustomModel}
              onRemoveCustomModel={(id) => void handleRemoveCustomModel(id)}
              onProbeApi={handleProbeApi}
              onProbeEmbedding={handleProbeEmbedding}
              onCancelTask={() => void handleCancelTask()}
              onRetryTask={() => void handleRetryTask()}
              onDismissTask={() => setBackgroundTask(null)}
              onSettingsTabChange={setSettingsTab}
              onDraftChange={updateSettingsDraft}
              onSaveSettings={handleSaveSettings}
              onExportDatabase={() => void handleExportDatabase()}
              onImportDatabase={(file) => void handleImportDatabase(file)}
              onDatabaseBackupAcknowledgedChange={setDatabaseBackupAcknowledged}
              onDatabaseResetConfirmationChange={setDatabaseResetConfirmation}
              onResetDatabase={() => void handleResetDatabase()}
              onIssuePairingCode={() => void handleIssuePairingCode()}
              onRevokeDevice={(id) => void handleRevokeDevice(id)}
              onForgetDevice={(id) => void handleForgetDevice(id)}
              lanSharing={lanSharing}
              isLanSharingChanging={isLanSharingChanging}
              onEnableLan={() => void setLanSharingEnabled(true)}
              onDisableLan={() => void setLanSharingEnabled(false)}
            />
          </div>
        ) : null}

        {/* The job outlives the settings panel, so its progress has to as well.
            Docked in the corner of the collection with the same controls: a
            download or a reindex is something you start and then get on with
            reading, not something you sit and watch. */}
        {!isModelsOpen && backgroundTask ? (
          <div className="background-task-dock">
            <BackgroundTaskPanel
              task={backgroundTask}
              onCancel={() => void handleCancelTask()}
              onRetry={() => void handleRetryTask()}
              onDismiss={() => setBackgroundTask(null)}
            />
            <button className="background-task-dock__open" type="button" onClick={openModels}>
              開啟設定
            </button>
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
            <span>試著換一個關鍵字，或清除目前的分類篩選。</span>
          </div>
        ) : collectionView === "cards" ? (
          <div className="collection-categories">
            {cardGroups.map((group, order) => (
              <KnowledgeCardSection
                key={group.category}
                order={order}
                category={group.category}
                cards={group.cards}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOpen={setViewerCardId}
                searchReasons={searchReasonsById}
              />
            ))}
            {collectionQuery || activeCategory !== "全部" || activeTag !== "全部" ? (
              <p className="collection-search-reasons">目前篩選：{[
                ...getSearchReasons(filteredCards[0] ?? cards[0] ?? knowledgeCards[0]),
                activeTag !== "全部" ? `標籤「${activeTag}」` : "",
                searchSort === "updated" ? "最近更新" : searchSort === "title" ? "標題排序" : "",
              ].filter(Boolean).join(" · ") || "篩選條件"}</p>
            ) : null}
          </div>
        ) : collectionView === "relations" ? (
          <RelationView
            cards={filteredCards}
            edges={relationEdgesState}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={setViewerCardId}
            onRelationCreated={() => setCardsRefreshKey((current) => current + 1)}
          />
        ) : (
          <TableView
            cards={filteredCards}
            onSelect={setSelectedId}
            onEdit={openEditCard}
            onDelete={(id) => void handleDeleteCard(id)}
          />
        )}

      </section>
      {viewerCard ? (
        <CollectionCardViewer
          card={viewerCard}
          closing={isViewerClosing}
          relatedCards={viewerRelatedCards}
          onOpenRelated={setViewerCardId}
          onClose={closeViewer}
        />
      ) : null}
    </main>
  );
}
