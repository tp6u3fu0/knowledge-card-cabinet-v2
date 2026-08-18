"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  CardMark,
  CoverGlyphMark,
  SeededCoverArt,
  type CoverGlyph,
  type CoverMotif,
} from "./cover-art";
import { DEGREES_PER_CARD, settlePose, showsBack } from "./flip-math";

export type CardNeighbour = {
  id: string;
  title: string;
  topic: string;
  accent: string;
};

export type CoverSpec = {
  version: number;
  seed: string;
  pattern: string;
  accent: string;
  color: string;
  soft_color: string;
  background: string;
  density: number;
  orbit: number;
  motifs?: CoverMotif[];
};

/** The card the two faces are drawn from — both pages narrow to this shape. */
export type CardFaceData = {
  id: string;
  number: string;
  title: string;
  question: string;
  accent: string;
  pattern: string;
  topic: string;
  category?: string;
  tags: string[];
  cover?: CoverSpec;
};

export function getCoverStyle(cover?: CoverSpec): CSSProperties | undefined {
  if (!cover) return undefined;
  return {
    "--cover-color": cover.color,
    "--cover-soft-color": cover.soft_color,
    "--cover-background": cover.background,
    "--cover-focus-x": `${26 + cover.orbit * 48}%`,
    "--cover-focus-y": `${28 + cover.density * 34}%`,
  } as CSSProperties;
}

export function tiltCard(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  const bounds = card.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - 0.5;
  const y = (event.clientY - bounds.top) / bounds.height - 0.5;

  card.style.setProperty("--tilt-x", `${y * -11}deg`);
  card.style.setProperty("--tilt-y", `${x * 13}deg`);
}

export function resetTilt(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.setProperty("--tilt-x", "0deg");
  event.currentTarget.style.setProperty("--tilt-y", "0deg");
}

/** Card front: emblem cover under the number, the question as the only copy. */
export function KnowledgeCardFront({
  card,
  active,
  onClick,
}: {
  card: CardFaceData;
  active: boolean;
  onClick: () => void;
}) {
  const meta = card.category ?? card.topic;

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
      aria-label={`${card.title}。${card.category ? `分類：${card.category}。` : ""}${card.question}。標籤：${card.tags.join("、")}`}
    >
      <span className="collection-card__accent" aria-hidden="true" />
      <span className="collection-card__topline">
        <span>{card.number}</span>
        <span>{meta}</span>
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

/**
 * Card back: the emblem drops from decoration to information — one corner glyph,
 * the middle given over to the plain-language read, neighbours along the bottom.
 */
export function KnowledgeCardBack({
  accent,
  number,
  lead,
  body,
  tags,
  neighbours,
  cornerShape,
  style,
  onOpenNeighbour,
}: {
  accent: string;
  number: string;
  lead: string;
  body: string;
  tags: string[];
  neighbours: CardNeighbour[];
  cornerShape?: CoverGlyph;
  style?: CSSProperties;
  onOpenNeighbour?: (id: string) => void;
}) {
  return (
    <div className={`collection-card collection-card--back collection-card--${accent}`} style={style}>
      <div className="collection-card__back-head">
        <span className="collection-card__accent" aria-hidden="true" />
        <CardMark className="collection-card__back-mark" />
      </div>
      <div className="collection-card__topline">
        <span>{number}</span>
        <span>白話講解</span>
      </div>

      <div className="collection-card__plain">
        <CoverGlyphMark shape={cornerShape} className="collection-card__plain-glyph" />
        <span className="collection-card__plain-label">
          <span className="collection-card__plain-dot" aria-hidden="true" />
          一句話
        </span>
        {/*
          The copy shares one bounded region rather than each paragraph owning a
          fixed number of lines. A card whose summary runs long simply gives less
          room to the body, and whatever does not fit fades out at the boundary —
          the card is a summary, and the full text sits in the reading pane
          beside it.
        */}
        <span className="collection-card__plain-copy">
          <p className="collection-card__plain-lead">{lead}</p>
          {body ? (
            <>
              <span className="collection-card__plain-rule" aria-hidden="true" />
              <p className="collection-card__plain-body">{body}</p>
            </>
          ) : null}
        </span>
        {tags.length > 0 ? (
          <span className="collection-card__plain-tags">
            {tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </span>
        ) : null}
      </div>

      {neighbours.length > 0 ? (
        <div className="collection-card__neighbours">
          <span className="collection-card__neighbours-label">延伸閱讀</span>
          {neighbours.slice(0, 3).map((neighbour) => (
            <button
              className={`collection-card__neighbour collection-card--${neighbour.accent}`}
              key={neighbour.id}
              type="button"
              disabled={!onOpenNeighbour}
              onClick={() => onOpenNeighbour?.(neighbour.id)}
            >
              <CardMark />
              <span>{neighbour.title}</span>
              <small>{neighbour.topic}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Which glyph guards the back's corner — the card's own first motif when it has one. */
export function cornerGlyphFor(motifs?: CoverMotif[]): CoverGlyph | undefined {
  return motifs?.[0]?.shape;
}

const SETTLE_MS = 480;
const HOVER_MS = 160;

/**
 * The layers that make up the card's edge, from the back face to the front.
 *
 * Enough of them that the gaps close: over a 5px thickness these land about a
 * third of a pixel apart, so from any angle they read as one solid edge rather
 * than as a stack. They stop just short of both faces (hence the half-step) so
 * no slice sits at exactly the same depth as a face and flickers against it.
 *
 * The tone runs dark at the back to near-paper at the front, which is how a
 * cut edge catches the light.
 */
const EDGE_SLICE_COUNT = 14;
const EDGE_SLICES = Array.from({ length: EDGE_SLICE_COUNT }, (_, index) => {
  const position = (index + 0.5) / EDGE_SLICE_COUNT;
  return {
    depth: (position - 0.5).toFixed(4),
    tone: `${Math.round(56 + 40 * position ** 0.7)}%`,
  };
});

/**
 * The card tumbles freely under the pointer in both axes and settles onto the
 * face it was left showing. With no drag in progress it leans toward the cursor.
 */
export function FlipCard({
  front,
  back,
  hint = "DRAG TO TURN · 拖曳卡片翻轉",
}: {
  front: ReactNode;
  back: ReactNode;
  hint?: string;
}) {
  const [rotation, setRotation] = useState({ x: 0, y: 0 });
  const [lean, setLean] = useState({ x: 0, y: 0 });
  const [sheen, setSheen] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
    from: { x: number; y: number };
    moved: boolean;
  } | null>(null);
  // Outlives dragRef so the click that follows pointerup can still be vetoed.
  const draggedRef = useRef(false);

  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settling]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    draggedRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: bounds.width || 1,
      height: bounds.height || 1,
      from: rotation,
      moved: false,
    };
    setDragging(true);
    setLean({ x: 0, y: 0 });
    // Best-effort: without capture the drag simply stops tracking off-element.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* no active pointer to capture */
    }
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const bounds = event.currentTarget.getBoundingClientRect();

    if (!drag || drag.pointerId !== event.pointerId) {
      // Not dragging: lean toward the cursor and slide the highlight with it.
      if (settling) return;
      const offsetX = (event.clientX - bounds.left) / bounds.width - 0.5;
      const offsetY = (event.clientY - bounds.top) / bounds.height - 0.5;
      setLean({ x: offsetY * -10, y: offsetX * 12 });
      setSheen({
        x: ((event.clientX - bounds.left) / bounds.width) * 100,
        y: ((event.clientY - bounds.top) / bounds.height) * 100,
      });
      return;
    }

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    draggedRef.current = true;
    setRotation({
      x: drag.from.x - (deltaY / drag.height) * DEGREES_PER_CARD,
      y: drag.from.y + (deltaX / drag.width) * DEGREES_PER_CARD,
    });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* capture already gone */
    }
    dragRef.current = null;
    setDragging(false);
    if (drag.moved) {
      setRotation((current) => settlePose(current.x, current.y));
      setSettling(true);
    }
  };

  const clearLean = () => {
    setLean({ x: 0, y: 0 });
    setSheen(null);
  };

  // A drag that ends on a face must not also fire that face's click handlers.
  const swallowDragClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!draggedRef.current) return;
    draggedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const flipped = showsBack(rotation.x, rotation.y);
  const turn = () =>
    setRotation((current) => {
      setSettling(true);
      return settlePose(current.x, current.y + 180);
    });

  const style = {
    transform: `rotateX(${rotation.x + lean.x}deg) rotateY(${rotation.y + lean.y}deg)`,
    transition: dragging ? "none" : `transform ${settling ? SETTLE_MS : HOVER_MS}ms ease-out`,
    "--sheen-x": `${sheen?.x ?? 50}%`,
    "--sheen-y": `${sheen?.y ?? 50}%`,
    "--sheen-opacity": sheen && !dragging ? 1 : 0,
  } as CSSProperties;

  return (
    <div className="card-viewer__card-wrap">
      <p className="card-viewer__hint">{hint}</p>
      <div
        className={`card-flip ${dragging ? "is-dragging" : ""}`}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={clearLean}
        onLostPointerCapture={endDrag}
        onClickCapture={swallowDragClick}
      >
        <div className="card-flip__inner" style={style}>
          {/* The card stock, extruded. Two faces alone have no thickness at
              all — turned past about 80 degrees the card vanishes into a
              hairline, which is the one angle a reader turns it to in order to
              see how thick it is. Four perpendicular quads fix that but are
              the wrong shape: they are straight planks, so they cut across the
              rounded corners and stick out past the outline. Instead the
              silhouette itself is repeated across the thickness. Every slice
              is the card's own rounded rectangle, so the edge follows the
              outline the whole way round and closes at the corners. */}
          {EDGE_SLICES.map((slice) => (
            <span
              key={slice.depth}
              aria-hidden="true"
              className="card-flip__slice"
              style={{ "--slice-depth": slice.depth, "--slice-tone": slice.tone } as CSSProperties}
            />
          ))}
          <div className="card-flip__face" aria-hidden={flipped}>
            {front}
          </div>
          <div className="card-flip__face card-flip__face--back" aria-hidden={!flipped}>
            {back}
          </div>
        </div>
      </div>
      <button className="card-flip__toggle" type="button" onClick={turn} aria-pressed={flipped}>
        {flipped ? "看正面" : "看背面"}
      </button>
    </div>
  );
}
