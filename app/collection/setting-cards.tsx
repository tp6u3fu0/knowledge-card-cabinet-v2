"use client";

/**
 * The settings page told in the same visual language as the collection.
 *
 * Everything a person picks in here — a model, a provider, a device — is shown
 * as a card, and the one currently in use sits in a slot at the top. The point
 * is not decoration: the collection page already taught the reader that a card
 * is "one thing you can pick up and turn over", so reusing it means the model
 * chooser needs no explaining. The glossary keeps the same language at a
 * smaller size: a card seen spine-on, which opens when the reader wants it.
 */

import { Children, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { SeededCoverArt, type CoverMotif } from "../cover-art";
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

/** The gap left between cards when the deck is open. */
const CARD_GAP_PX = 16;
/** The gap between rows of an open deck. */
const ROW_GAP_PX = 18;
/** Room the leaning pile is given at the top of the rail; matches globals.css. */
const RAIL_TOP_PX = 26;

/**
 * A pile of cards that deals itself out when you ask it to.
 *
 * Closed, it is a pile: one card's worth of space however long the catalogue
 * is. Open, it is a proper wall — every card at full width, in as many rows as
 * it takes. The first version fanned the cards along a single row, which was
 * fine for four and unreadable for eight: the step shrank until each card was a
 * sliver of its own right-hand edge and every title was clipped from the left.
 *
 * Opening is a click, not a hover, because opening now changes the height of
 * the page. A hover that reflows the section under the pointer is how a page is
 * made to feel unstable; a deliberate press is not.
 *
 * The layout is still transforms — a grid that reflowed would snap open with no
 * sense of the cards moving apart — so the positions have to be measured. A
 * percentage inside `translate` resolves against the card being moved rather
 * than the row it moves along, and silently comes out as zero.
 */
export function CardDeck({ kind, hint, children }: { kind: string; hint?: string; children: ReactNode }) {
  const items = Children.toArray(children);
  const drag = useDragState();
  const railRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [layout, setLayout] = useState({ step: 0, rowHeight: 0, perRow: 1 });
  const count = items.length;

  // A deck stays open while one of its cards is in the air, so letting go
  // outside it does not close the wall the card came from.
  const held = drag.kind === kind;
  const open = isOpen || held;

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    const measure = () => {
      const first = rail.firstElementChild as HTMLElement | null;
      // offsetWidth, not the bounding box: the cards are rotated in the pile.
      const cardWidth = first?.offsetWidth ?? 0;
      if (!cardWidth) return;
      const room = rail.clientWidth;
      const perRow = Math.max(1, Math.floor((room + CARD_GAP_PX) / (cardWidth + CARD_GAP_PX)));
      // Spread the slack between the columns instead of leaving it all on the
      // right — but only so far. Handing three columns the whole remainder puts
      // twice a card's width between neighbours, which stops reading as a row
      // of cards and starts reading as three unrelated things.
      const spread = perRow > 1 ? (room - cardWidth) / (perRow - 1) : 0;
      const step = Math.min(Math.max(cardWidth + CARD_GAP_PX, spread), cardWidth + CARD_GAP_PX * 3);
      setLayout({ step, perRow, rowHeight: (first?.offsetHeight ?? 0) + ROW_GAP_PX });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [count]);

  const rows = Math.max(1, Math.ceil(count / layout.perRow));
  const openHeight = layout.rowHeight ? RAIL_TOP_PX + rows * layout.rowHeight - ROW_GAP_PX : 0;

  return (
    <div className={`card-deck${open ? " is-open" : ""}`} data-deck-kind={kind}>
      <button
        className="card-deck__toggle"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="card-deck__toggle-mark" aria-hidden="true">{open ? "−" : "+"}</span>
        {open ? `收起這疊` : hint ?? "攤開這疊"}
        <small>共 {count} 張</small>
      </button>
      <div
        className="card-deck__rail"
        ref={railRef}
        style={open && openHeight ? { height: `${openHeight}px` } : undefined}
        // Tabbing into a closed pile opens it: the cards behind the top one are
        // reachable by keyboard, and landing on one you cannot see is worse
        // than a section opening without a click.
        onFocus={() => setOpen(true)}
      >
        {items.map((item, index) => (
          // Children.toArray keeps each child's own key, so a card keeps its
          // identity — and its half-finished return animation — when the
          // catalogue reorders around it.
          <div
            className="card-deck__item"
            key={(item as { key?: string | null }).key ?? index}
            style={{
              "--i": index,
              "--x": `${(index % layout.perRow) * layout.step}px`,
              "--y": `${Math.floor(index / layout.perRow) * layout.rowHeight}px`,
            } as CSSProperties}
          >
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
 * A term explained without taking the floor.
 *
 * These used to be full-size cards with a flip hint above and a "see the back"
 * button below — three pieces of chrome each, and on the data tab the
 * explanation of the word "checksum" was physically larger than the button that
 * makes the backup. A settings page is read for its controls; the glossary is
 * read once, by one reader, on their first run. So it keeps the card language
 * at the size of a spine: the cover art shrinks to a thumbnail, the question
 * stays visible, and the answer unfolds in place when it is actually wanted.
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
  const [open, setOpen] = useState(false);

  return (
    <div className={`glossary-note collection-card--${accent}${open ? " is-open" : ""}`} style={EXAMPLE_COVER_STYLE}>
      <button className="glossary-note__face" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="glossary-note__mark" aria-hidden="true">
          <SeededCoverArt seed={term} pattern="orbit" motifs={exampleMotifs(glyph)} />
        </span>
        <span className="glossary-note__copy">
          <span className="glossary-note__number">{number} · 術語</span>
          <strong>{term}</strong>
          <span>{question}</span>
        </span>
        <span className="glossary-note__toggle" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="glossary-note__body">
          <p>{answer}</p>
          {aside ? <p className="glossary-note__aside">{aside}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
