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

import type { CSSProperties, ReactNode } from "react";

import { SeededCoverArt, type CoverMotif } from "../cover-art";
import { FlipCard } from "../card-face";
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
 * A slot holds the option that is actually in force. An empty slot is drawn as
 * an empty slot — an outline the shape of the missing card — rather than hidden,
 * so "nothing is chosen yet" looks like a state rather than a rendering bug.
 */
export function CardSlot({
  kicker,
  label,
  hint,
  card,
}: {
  kicker: string;
  label: string;
  hint?: string;
  card: ReactNode;
}) {
  return (
    <div className="card-slot">
      <div className="card-slot__label">
        <span className="model-settings-kicker">{kicker}</span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className={`card-slot__well${card ? " is-filled" : ""}`}>
        {card ?? <span className="card-slot__empty">尚未選擇</span>}
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
  onClick?: () => void;
}) {
  const className = [
    "collection-card",
    "setting-card",
    `collection-card--${accent}`,
    compact ? "setting-card--compact" : "",
    active ? "is-active" : "",
    onClick ? "" : "setting-card--static",
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
    <button className={className} style={EXAMPLE_COVER_STYLE} type="button" onClick={onClick} disabled={disabled} aria-pressed={active}>
      {body}
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
