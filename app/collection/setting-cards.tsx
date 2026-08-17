"use client";

/**
 * The settings page told in the same visual language as the collection.
 *
 * Everything a person picks in here — a model, a provider, a device — is shown
 * as a card, and the one currently in use sits in a slot at the top. The point
 * is not decoration: the collection page already taught the reader that a card
 * is "one thing you can pick up and turn over", so reusing it means the model
 * chooser needs no explaining. The glossary cards lean on the same habit — they
 * turn over, because that is what cards do here.
 */

import { Children, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { SeededCoverArt, type CoverMotif } from "../cover-art";
import { FlipCard } from "../card-face";
import { useCardDrag, useDragState, useSlotRegistration } from "./card-drag";
import type { VisualAccent } from "./types";

/**
 * The cover that marks a card as an illustration rather than one of your own.
 *
 * Real card covers are hashed from their content, so they are organic and never
 * quite symmetrical. This one is a deliberate octagon: perfectly regular in a
 * way no generated cover ever is, so an explainer card is recognisable as
 * "made to show you something" before a single word is read.
 */
const EXAMPLE_RING: Array<[number, number]> = [
  [50, 9], [79, 24], [91, 50], [79, 76], [50, 91], [21, 76], [9, 50], [21, 24],
];

export function exampleMotifs(accentShape: CoverMotif["shape"]): CoverMotif[] {
  return EXAMPLE_RING.map(([x, y], index) => ({
    // The chosen glyph sits at the four cardinal points; the diagonals keep a
    // neutral mark so the ring reads as a frame and not as noise.
    shape: index % 2 === 0 ? accentShape : "triple-dot",
    x,
    y,
    size: index % 2 === 0 ? 13 : 9.5,
    opacity: index % 2 === 0 ? 0.5 : 0.28,
    weight: index % 2 === 0 ? 0.8 : 0.4,
  }));
}

/** Example covers are lit from the same place every time; only real cards vary. */
const EXAMPLE_COVER_STYLE = {
  "--cover-focus-x": "50%",
  "--cover-focus-y": "38%",
} as CSSProperties;

/**
 * A slot holds the option that is actually in force, and accepts a card dropped
 * onto it.
 *
 * The drop target is the point of the slot, so it is rendered next to the cards
 * it accepts rather than at the top of the page — a drag that has to cross a
 * whole screen is one nobody completes twice. Dropping and clicking do the same
 * thing; the click path is what keyboards and screen readers use, so it can
 * never be removed in favour of the drag.
 */
export function CardSlot({
  kicker,
  label,
  hint,
  card,
  kind = "",
  onDrop,
}: {
  kicker: string;
  label: string;
  hint?: string;
  card: ReactNode;
  /** Which deck's cards this slot takes; a card of another kind is refused. */
  kind?: string;
  onDrop?: (modelId: string) => void;
}) {
  const slotId = useSlotRegistration(kind, onDrop);
  const drag = useDragState();
  const isArmed = Boolean(onDrop) && drag.kind === kind;
  const isOver = isArmed && drag.overSlot === slotId;

  return (
    <div className="card-slot">
      <div className="card-slot__label">
        <span className="model-settings-kicker">{kicker}</span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div
        className={[
          "card-slot__well",
          card ? "is-filled" : "",
          isArmed ? "is-armed" : "",
          isOver ? "is-over" : "",
        ].filter(Boolean).join(" ")}
        data-card-slot={onDrop ? slotId : undefined}
      >
        {card ?? <span className="card-slot__empty">{onDrop ? "把卡片拖到這裡" : "尚未選擇"}</span>}
      </div>
    </div>
  );
}

/** The gap left between cards when a deck is open and has room to spread. */
const FAN_GAP_PX = 16;

/**
 * A pile of cards that fans open when you reach for it.
 *
 * Stacked is how cards are kept when you are not using them, and it keeps a
 * long catalogue from turning the settings page into a wall of thumbnails. The
 * fan is laid out by transform rather than by changing the grid, because only
 * transforms can animate — a grid that reflows would snap open with no sense of
 * the cards sliding apart. The step shrinks as the deck narrows, so a wide
 * window spreads the cards fully and a narrow one keeps them overlapping
 * instead of pushing any of them out of view.
 */
export function CardDeck({ kind, hint, children }: { kind: string; hint?: string; children: ReactNode }) {
  const items = Children.toArray(children);
  const drag = useDragState();
  // A deck stays open while one of its cards is in the air, so the pointer
  // leaving the pile mid-drag does not collapse the row underneath it.
  const held = drag.kind === kind;
  const railRef = useRef<HTMLDivElement | null>(null);
  const [fan, setFan] = useState(0);
  const count = items.length;

  // How far apart the cards sit when the deck is open. This has to be measured
  // rather than written as a percentage: a percentage inside `translate`
  // resolves against the card being moved, not the row it is moving along, so
  // the arithmetic would come out as zero and the deck would never open.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    const measure = () => {
      // offsetWidth, not the bounding box: the cards are rotated in the pile.
      const cardWidth = (rail.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0;
      if (!cardWidth) return;
      const room = (rail.clientWidth - cardWidth) / Math.max(count - 1, 1);
      setFan(Math.max(0, Math.min(cardWidth + FAN_GAP_PX, room)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [count]);

  return (
    <div
      className={`card-deck${held ? " is-held" : ""}`}
      style={{ "--count": count, "--fan": `${fan}px` } as CSSProperties}
      data-deck-kind={kind}
    >
      {hint ? <span className="card-deck__hint">{hint}</span> : null}
      <div className="card-deck__rail" ref={railRef}>
        {items.map((item, index) => (
          // Children.toArray keeps each child's own key, so a card keeps its
          // identity — and its half-finished return animation — when the
          // catalogue reorders around it.
          <div className="card-deck__item" key={(item as { key?: string | null }).key ?? index} style={{ "--i": index } as CSSProperties}>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One pickable thing, drawn as a card.
 *
 * Omitting `onClick` renders a plain element instead of a button: the same card
 * is sometimes the control you press to choose a model and sometimes just the
 * read-out sitting in a slot, and a button inside a slot would be one more stop
 * for the keyboard with nothing behind it.
 */
export function SettingCard({
  accent,
  glyph,
  number,
  meta,
  title,
  caption,
  tags = [],
  state,
  active = false,
  disabled = false,
  compact = false,
  draggableId,
  dragKind = "",
  onClick,
}: {
  accent: VisualAccent;
  glyph: CoverMotif["shape"];
  number: string;
  meta: string;
  title: string;
  caption?: string;
  tags?: string[];
  state?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  compact?: boolean;
  /** Set to make the card carryable into a CardSlot of the same kind. */
  draggableId?: string;
  dragKind?: string;
  onClick?: () => void;
}) {
  const { ref: carryRef, onPointerDown, gap } = useCardDrag({ cardId: draggableId ?? "", kind: dragKind, disabled: !draggableId || disabled });
  const className = [
    "collection-card",
    "setting-card",
    `collection-card--${accent}`,
    compact ? "setting-card--compact" : "",
    active ? "is-active" : "",
    onClick ? "" : "setting-card--static",
    draggableId ? "setting-card--carryable" : "",
    gap ? "is-carried" : "",
  ].filter(Boolean).join(" ");

  const body = (
    <>
      <span className="collection-card__accent" aria-hidden="true" />
      <span className="collection-card__topline">
        <span>{number}</span>
        <span>{meta}</span>
      </span>
      <SeededCoverArt seed={title} pattern="orbit" motifs={exampleMotifs(glyph)} />
      <span className="collection-card__copy">
        <strong>{title}</strong>
        {caption ? <span>{caption}</span> : null}
      </span>
      <span className="collection-card__tags">
        {tags.map((tag) => <span key={tag}>{tag}</span>)}
        {state ? <span className="setting-card__state">{state}</span> : null}
      </span>
    </>
  );

  if (!onClick) {
    return <div className={className} style={EXAMPLE_COVER_STYLE}>{body}</div>;
  }

  return (
    <>
      <button
        className={className}
        ref={carryRef}
        style={EXAMPLE_COVER_STYLE}
        type="button"
        onClick={onClick}
        onPointerDown={onPointerDown}
        disabled={disabled}
        aria-pressed={active}
      >
        {body}
      </button>
      {/* Holds the card's place in the pile while it is in the air. */}
      {gap ? <span className="setting-card__gap" style={{ height: `${gap.height}px` }} aria-hidden="true" /> : null}
    </>
  );
}

/**
 * The blank at the end of the deck: the card you have not added yet.
 *
 * A model from Hugging Face becomes an ordinary card in the pile once it is
 * added, so the way to add one belongs in the pile too — as the empty sleeve
 * every card index has at the back, rather than as a form in a different
 * section that happens to produce cards somewhere else on the page.
 */
export function AddCard({ label, caption, open, onClick }: { label: string; caption: string; open: boolean; onClick: () => void }) {
  return (
    <button
      className={`collection-card setting-card setting-card--add${open ? " is-open" : ""}`}
      type="button"
      onClick={onClick}
      aria-expanded={open}
    >
      <span className="setting-card__add-mark" aria-hidden="true">+</span>
      <span className="collection-card__copy">
        <strong>{label}</strong>
        <span>{caption}</span>
      </span>
    </button>
  );
}

/**
 * A term explained on the back of a card.
 *
 * The settings page is full of words — 向量、維度、ONNX — that mean nothing to
 * someone who has not built one of these before, and a tooltip is the wrong
 * shape for a two-paragraph answer. Putting the answer on the back of a card
 * means it is available without being in the way.
 */
export function GlossaryCard({
  accent,
  glyph,
  number,
  term,
  question,
  answer,
  aside,
}: {
  accent: VisualAccent;
  glyph: CoverMotif["shape"];
  number: string;
  term: string;
  question: string;
  answer: string;
  aside?: string;
}) {
  const front = (
    <div className={`collection-card setting-card glossary-card collection-card--${accent}`} style={EXAMPLE_COVER_STYLE}>
      <span className="collection-card__accent" aria-hidden="true" />
      <span className="collection-card__topline">
        <span>{number}</span>
        <span>術語</span>
      </span>
      <SeededCoverArt seed={term} pattern="orbit" motifs={exampleMotifs(glyph)} />
      <span className="collection-card__copy">
        <strong>{term}</strong>
        <span>{question}</span>
      </span>
      <span className="collection-card__tags">
        <span>翻面看說明</span>
      </span>
    </div>
  );

  const back = (
    <div className={`collection-card collection-card--back glossary-card glossary-card--back collection-card--${accent}`}>
      <span className="collection-card__back-head">
        <span className="collection-card__accent" aria-hidden="true" />
        <span className="collection-card__topline">
          <span>{number}</span>
          <span>{term}</span>
        </span>
      </span>
      <span className="collection-card__plain-copy glossary-card__copy">
        <span className="collection-card__plain-lead">{answer}</span>
        {aside ? (
          <>
            <span className="collection-card__plain-rule" aria-hidden="true" />
            <span className="collection-card__plain-body">{aside}</span>
          </>
        ) : null}
      </span>
    </div>
  );

  return (
    <div className="glossary-card__shell">
      <FlipCard front={front} back={back} hint="拖曳翻面 · 看白話說明" />
    </div>
  );
}
