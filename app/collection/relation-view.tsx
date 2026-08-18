"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";

import { CardSelect } from "./card-select";

import { resetTilt, tiltCard } from "../card-face";
import { relationEdgeKey, relationEdgeLabel, relationKey } from "./relations";
import type { KnowledgeCard, RelationEdge, RelationFilter, RelationStrength } from "./types";

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

export function RelationView({
  cards,
  edges,
  selectedId,
  onSelect,
  onOpen,
  onRelationCreated,
}: {
  cards: KnowledgeCard[];
  edges: ReadonlyArray<RelationEdge>;
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onRelationCreated: () => void;
}) {
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("all");
  const [relationStrength, setRelationStrength] = useState<RelationStrength>("all");
  const [relationCategory, setRelationCategory] = useState("全部");
  const [isRelationComposerOpen, setIsRelationComposerOpen] = useState(false);
  const initialRelationSourceId = cards.some((card) => card.id === selectedId) ? selectedId : cards[0]?.id ?? "";
  const initialRelationTargetId = cards.find((card) => card.id !== initialRelationSourceId)?.id ?? "";
  const [relationSourceId, setRelationSourceId] = useState(initialRelationSourceId);
  const [relationTargetId, setRelationTargetId] = useState(initialRelationTargetId);
  const [isSavingRelation, setIsSavingRelation] = useState(false);
  const [relationError, setRelationError] = useState("");
  const [deletingRelationKey, setDeletingRelationKey] = useState("");
  const focusedCards = relationCategory === "全部" ? cards : cards.filter((card) => (card.category || "待分類") === relationCategory);
  const visibleIds = new Set(focusedCards.map((card) => card.id));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const relationCategories = ["全部", ...Array.from(new Set(cards.map((card) => card.category || "待分類")))];
  const manualEdges = edges.filter((edge) => edge.relation_type === "manual");
  const filteredEdges = edges.filter((edge) => (
    visibleIds.has(edge.source_id)
    && visibleIds.has(edge.target_id)
    && (relationFilter === "all" || edge.relation_type === relationFilter)
    && (relationStrength === "all" || edge.relation_type === "manual" || edge.score >= 0.7)
    && (relationCategory === "全部"
      || cardById.get(edge.source_id)?.category === relationCategory
      || cardById.get(edge.target_id)?.category === relationCategory)
  ));
  const displayEdges = Array.from(
    filteredEdges.reduce((map, edge) => {
      const pair = relationKey(edge.source_id, edge.target_id);
      const current = map.get(pair);
      if (!current || edge.relation_type === "manual") map.set(pair, edge);
      return map;
    }, new Map<string, RelationEdge>()),
  ).map(([, edge]) => edge);
  const visiblePairs = displayEdges.map(
    (edge) => [edge.source_id, edge.target_id] as const,
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
  // The line-drawing effect reads the live zoom without re-subscribing to it.
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  const showNodeLabels = zoom >= 1;
  const cardSignature = cards.map((card) => card.id).join("|");
  const visiblePairKey = visiblePairs.map(([first, second]) => `${first}-${second}`).join("|");

  // Re-deal the canvas when the card set changes. Adjusting during render is
  // React's documented alternative to resetting state from an effect, which
  // would render once with the stale layout first.
  const [lastCardSignature, setLastCardSignature] = useState(cardSignature);
  if (cardSignature !== lastCardSignature) {
    setLastCardSignature(cardSignature);
    setPositions(createNodePositions(cards));
    setPan({ x: 0, y: 0 });
  }

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

  const [lastZoom, setLastZoom] = useState(zoom);
  if (zoom !== lastZoom) {
    setLastZoom(zoom);
    setPan((current) => clampPanOffset(current));
  }

  const handleNodeClick = (id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelect(id);
    onOpen(id);
  };

  const handleCreateRelation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRelationError("");
    if (!relationSourceId || !relationTargetId || relationSourceId === relationTargetId) {
      setRelationError("請選擇兩張不同的卡片。");
      return;
    }

    setIsSavingRelation(true);
    try {
      const response = await fetch(
        `/api/cards/${encodeURIComponent(relationSourceId)}/relations/${encodeURIComponent(relationTargetId)}/confirm`,
        { method: "POST" },
      );
      const result = (await response.json().catch(() => ({}))) as { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "建立自製關聯失敗，請稍後再試。");
      setRelationFilter("manual");
      setIsRelationComposerOpen(false);
      onRelationCreated();
    } catch (error) {
      setRelationError(error instanceof Error ? error.message : "建立自製關聯失敗，請稍後再試。");
    } finally {
      setIsSavingRelation(false);
    }
  };

  const handleDeleteRelation = async (edge: RelationEdge) => {
    if (edge.relation_type !== "manual") return;
    const key = relationEdgeKey(edge);
    setDeletingRelationKey(key);
    setRelationError("");
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(edge.source_id)}/relations/${encodeURIComponent(edge.target_id)}`, { method: "DELETE" });
      const result = (await response.json().catch(() => ({}))) as { detail?: string };
      if (!response.ok) throw new Error(result.detail ?? "移除自製關聯失敗。")
      onRelationCreated();
    } catch (error) {
      setRelationError(error instanceof Error ? error.message : "移除自製關聯失敗。");
    } finally {
      setDeletingRelationKey("");
    }
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
    // visiblePairs is a fresh array on every render, so depending on it would
    // re-run this on each one. visiblePairKey is its content, which is what
    // actually decides whether the lines need redrawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePairKey, positions]);

  return (
    <div className="relation-workspace">
      <div className="relation-toolbar">
        <div className="relation-toolbar__group">
          <span className="relation-toolbar__label">關聯來源</span>
          <div className="relation-filter" aria-label="篩選關聯來源">
            {([
              ["all", "全部"],
              ["semantic", "Embedding 自動"],
              ["manual", "自製關聯"],
            ] as const).map(([filter, label]) => (
              <button
                className={relationFilter === filter ? "is-active" : ""}
                key={filter}
                type="button"
                onClick={() => setRelationFilter(filter)}
                aria-pressed={relationFilter === filter}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className={`relation-compose-button ${isRelationComposerOpen ? "is-active" : ""}`}
            type="button"
            onClick={() => {
              setRelationError("");
              const sourceId = cards.some((card) => card.id === relationSourceId)
                ? relationSourceId
                : (cards.some((card) => card.id === selectedId) ? selectedId : cards[0]?.id ?? "");
              const targetId = cards.some((card) => card.id === relationTargetId && card.id !== sourceId)
                ? relationTargetId
                : cards.find((card) => card.id !== sourceId)?.id ?? "";
              setRelationSourceId(sourceId);
              setRelationTargetId(targetId);
              setIsRelationComposerOpen((current) => !current);
            }}
          >
            <span aria-hidden="true">＋</span>
            自製關聯
          </button>
          <CardSelect
            className="relation-select-control"
            label="分類"
            value={relationCategory}
            onChange={setRelationCategory}
            options={relationCategories.map((category) => ({ value: category, label: category }))}
          />
          <button
            className={`relation-strength-toggle ${relationStrength === "strong" ? "is-active" : ""}`}
            type="button"
            onClick={() => setRelationStrength((current) => current === "strong" ? "all" : "strong")}
            aria-pressed={relationStrength === "strong"}
          >
            只看強關聯
          </button>
        </div>
        <div className="relation-toolbar__group relation-toolbar__group--scale">
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
      </div>
      {isRelationComposerOpen || manualEdges.length > 0 ? (
        <div className="relation-manager">
          {isRelationComposerOpen ? (
          <form className="relation-composer" onSubmit={(event) => void handleCreateRelation(event)}>
          <div className="relation-composer__copy">
            <strong>建立一條自己的連線</strong>
            <span>這不會刪除 embedding 自動關聯，只會額外保留一條人工關聯。</span>
          </div>
          <CardSelect
            label="從"
            placeholder="選擇卡片"
            required
            value={relationSourceId}
            onChange={setRelationSourceId}
            options={cards.map((card) => ({ value: card.id, label: card.title }))}
          />
          <span className="relation-composer__arrow" aria-hidden="true">→</span>
          <CardSelect
            label="連到"
            placeholder="選擇卡片"
            required
            value={relationTargetId}
            onChange={setRelationTargetId}
            options={cards.map((card) => ({ value: card.id, label: card.title }))}
          />
          <button className="relation-composer__submit" type="submit" disabled={isSavingRelation || cards.length < 2}>
            {isSavingRelation ? "建立中…" : "建立關聯"}
          </button>
          {relationError ? <span className="relation-composer__error" role="alert">{relationError}</span> : null}
          </form>
          ) : null}
          {relationError && !isRelationComposerOpen ? (
            <span className="relation-composer__error" role="alert">{relationError}</span>
          ) : null}
          <section className="relation-manual" aria-labelledby="relation-manual-title">
            <div className="relation-manual__heading">
              <strong id="relation-manual-title">已建立的自製關聯</strong>
              <small>{manualEdges.length} 條</small>
            </div>
            {manualEdges.length === 0 ? (
              <p className="relation-manual__empty">還沒有自製關聯。用上面的表單建立第一條。</p>
            ) : (
              <ul className="relation-manual__list">
                {manualEdges.map((edge) => {
                  const key = relationEdgeKey(edge);
                  const isDeleting = deletingRelationKey === key;

                  return (
                    <li className="relation-manual__item" key={key}>
                      <span className="relation-manual__pair">
                        <span>{cardById.get(edge.source_id)?.title ?? edge.source_id}</span>
                        <span className="relation-manual__arrow" aria-hidden="true">→</span>
                        <span>{cardById.get(edge.target_id)?.title ?? edge.target_id}</span>
                      </span>
                      <small>{relationEdgeLabel(edge)}</small>
                      <button
                        className="relation-manual__delete"
                        type="button"
                        onClick={() => void handleDeleteRelation(edge)}
                        disabled={isDeleting}
                        aria-label={`移除 ${cardById.get(edge.source_id)?.title ?? edge.source_id} 到 ${cardById.get(edge.target_id)?.title ?? edge.target_id} 的自製關聯`}
                      >
                        {isDeleting ? "移除中…" : "移除"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      ) : null}
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
          {displayEdges.map((edge) => {
            const pair = relationKey(edge.source_id, edge.target_id);
            // A manual link is an assertion, not a measurement, so it draws at a
            // fixed weight; a semantic one thickens with its similarity score.
            const strength = Math.min(1, Math.max(0, (edge.score - 0.5) / 0.4));
            // Borders snap to whole device pixels, so the range has to be wide
            // enough that weak and strong links land on different steps.
            const weight = edge.relation_type === "manual" ? 2 : 1 + strength * 2.4;

            return (
              <span
                className={`relation-line relation-line--${edge.relation_type}`}
                key={pair}
                style={{
                  ...lineStyles[pair],
                  "--relation-weight": `${weight.toFixed(2)}px`,
                  "--relation-strength": strength.toFixed(3),
                } as CSSProperties}
                aria-hidden="true"
              />
            );
          })}
          {focusedCards.map((card, index) => {
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
              className={`relation-node relation-node--${card.accent} ${previewPlacement} ${floatClass} ${selectedId === card.id ? "is-selected" : ""}`}
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
              style={{
                left: `${position.x}%`,
                top: `${position.y}%`,
                ...(card.cover ? { "--node-color": card.cover.color } : {}),
              } as CSSProperties}
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
    </div>
  );
}

