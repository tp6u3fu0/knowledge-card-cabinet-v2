import type { CSSProperties, ReactNode } from "react";

export type CoverGlyph =
  | "steps"
  | "quad"
  | "nested"
  | "crosshair-box"
  | "link"
  | "target"
  | "triple-dot"
  | "constellation"
  | "folder"
  | "stack"
  | "arch"
  | "lines"
  | "corners"
  | "diagonal"
  | "pill"
  | "brackets"
  | "bars"
  | "crosshair";

export type CoverMotif = {
  shape: CoverGlyph;
  x: number;
  y: number;
  size: number;
  opacity: number;
  weight: number;
};

const dot = (cx: number, cy: number, r = 2) => (
  <circle className="cover-mosaic__glyph-dot" cx={cx} cy={cy} r={r} />
);

const glyphLibrary: Record<CoverGlyph, ReactNode> = {
  steps: (
    <>
      <rect x="4" y="4" width="5" height="5" rx="1.2" />
      <rect x="4" y="11" width="5" height="5" rx="1.2" />
      <rect x="11" y="11" width="5" height="5" rx="1.2" />
    </>
  ),
  quad: (
    <>
      <rect x="4" y="4" width="5" height="5" rx="1.2" />
      <rect x="11" y="4" width="5" height="5" rx="1.2" />
      <rect x="4" y="11" width="5" height="5" rx="1.2" />
      <rect x="11" y="11" width="5" height="5" rx="1.2" />
    </>
  ),
  nested: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" />
    </>
  ),
  "crosshair-box": (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </>
  ),
  link: (
    <>
      <rect x="4" y="4" width="5" height="5" rx="1.2" />
      <rect x="15" y="15" width="5" height="5" rx="1.2" />
      <line x1="9.5" y1="9.5" x2="14.5" y2="14.5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7" />
      {dot(12, 12)}
    </>
  ),
  "triple-dot": (
    <>
      {dot(6, 12)}
      {dot(12, 12)}
      {dot(18, 12)}
    </>
  ),
  constellation: (
    <>
      <line x1="7" y1="17" x2="12" y2="8" />
      <line x1="12" y1="8" x2="18" y2="14" />
      {dot(7, 17)}
      {dot(12, 8)}
      {dot(18, 14)}
    </>
  ),
  folder: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="2.5" />
      <rect x="5" y="4" width="6" height="4" rx="1.5" />
    </>
  ),
  stack: (
    <>
      <rect x="4" y="7" width="11" height="13" rx="2.5" />
      <rect x="9.5" y="4" width="11" height="13" rx="2.5" />
    </>
  ),
  arch: <path d="M4 20 L4 12 A8 8 0 0 1 20 12 L20 20" />,
  lines: (
    <>
      <line x1="5" y1="8" x2="19" y2="8" />
      <line x1="5" y1="12" x2="15" y2="12" />
      <line x1="5" y1="16" x2="11" y2="16" />
    </>
  ),
  corners: (
    <>
      <rect x="4" y="4" width="4" height="4" rx="1" />
      <rect x="16" y="4" width="4" height="4" rx="1" />
      <rect x="4" y="16" width="4" height="4" rx="1" />
      <rect x="16" y="16" width="4" height="4" rx="1" />
    </>
  ),
  diagonal: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      {dot(6, 6)}
      {dot(18, 18)}
    </>
  ),
  pill: (
    <>
      <rect x="4" y="9" width="16" height="6" rx="3" />
      {dot(8, 12, 1.6)}
    </>
  ),
  brackets: (
    <>
      <path d="M9 4 L5 4 L5 8" />
      <path d="M15 20 L19 20 L19 16" />
      {dot(12, 12)}
    </>
  ),
  bars: (
    <>
      <rect x="4" y="14" width="5" height="6" rx="1.2" />
      <rect x="9.5" y="9" width="5" height="11" rx="1.2" />
      <rect x="15" y="4" width="5" height="16" rx="1.2" />
    </>
  ),
  crosshair: (
    <>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle className="cover-mosaic__glyph-knockout" cx="12" cy="12" r="3.5" />
    </>
  ),
};

const glyphNames = Object.keys(glyphLibrary) as CoverGlyph[];

/**
 * Slots hug the border band; the middle of the cover stays clear for the mark.
 */
const motifLayout: Array<[number, number]> = [
  [12, 13],
  [38, 10],
  [64, 10],
  [88, 13],
  [90, 38],
  [90, 62],
  [88, 87],
  [64, 90],
  [38, 90],
  [12, 87],
  [10, 62],
  [10, 38],
];

const motifSize = 13.5;

function createSeededRandom(seed: string) {
  let state = 2166136261;

  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }

  return () => {
    state = Math.imul(state ^ (state >>> 16), 2246822519);
    state = Math.imul(state ^ (state >>> 13), 3266489917);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
}

function createFallbackMotifs(seed: string, density: number, pattern: string): CoverMotif[] {
  const random = createSeededRandom(`${seed}:${pattern}:emblem`);
  const count = 8 + Math.floor(density * 4.99);
  const slots = motifLayout.map((slot, index) => ({ slot, index, order: random() }));
  slots.sort((left, right) => left.order - right.order);

  return slots
    .slice(0, Math.min(count, motifLayout.length))
    .sort((left, right) => left.index - right.index)
    .map(({ slot: [x, y] }) => ({
      shape: glyphNames[Math.floor(random() * glyphNames.length)],
      x: Math.round((x + (random() - 0.5) * 4) * 100) / 100,
      y: Math.round((y + (random() - 0.5) * 4) * 100) / 100,
      size: motifSize,
      opacity: Math.round((0.42 + random() * 0.38) * 1000) / 1000,
      weight: random(),
    }));
}

function mosaicStyle(): CSSProperties {
  return {
    "--motif-ink": "color-mix(in srgb, var(--cover-color) 62%, #6f6a60)",
  } as CSSProperties;
}

/**
 * The mark at small sizes: nodes only, the trace lines drop out because they
 * turn to mush below ~24px.
 */
export function CardMark({ className }: { className?: string }) {
  return (
    <svg
      className={`card-mark${className ? ` ${className}` : ""}`}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
    >
      <rect className="card-mark__panel" x="16" y="12" width="68" height="76" rx="12" />
      <circle className="card-mark__node" cx="36" cy="62" r="9" />
      <circle className="card-mark__node" cx="50" cy="36" r="9" />
      <circle className="card-mark__node" cx="66" cy="56" r="9" />
    </svg>
  );
}

/** A single glyph from the library, for use outside the cover's border band. */
export function CoverGlyphMark({ shape, className }: { shape?: CoverGlyph; className?: string }) {
  return (
    <svg
      className={`cover-mosaic__glyph${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {(shape && glyphLibrary[shape]) ?? glyphLibrary.quad}
    </svg>
  );
}

/** The cabinet mark: a card panel with the three-node trace knocked out of it. */
function ProductMark() {
  return (
    <svg
      className="cover-mosaic__mark"
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
    >
      <rect className="cover-mosaic__mark-panel" x="16" y="12" width="68" height="76" rx="12" />
      <path className="cover-mosaic__mark-link" d="M36 62 L50 36 L66 56" />
      <circle className="cover-mosaic__mark-node" cx="36" cy="62" r="7.5" />
      <circle className="cover-mosaic__mark-node" cx="50" cy="36" r="7.5" />
      <circle className="cover-mosaic__mark-node" cx="66" cy="56" r="7.5" />
    </svg>
  );
}

function MotifMark({ motif }: { motif: CoverMotif }) {
  const glyph = glyphLibrary[motif.shape] ?? glyphLibrary.quad;
  const size = motif.size > 0 ? motif.size : motifSize;

  return (
    <svg
      className={`cover-mosaic__glyph${motif.weight > 0.7 ? " is-heavy" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{
        left: `${motif.x}%`,
        top: `${motif.y}%`,
        width: `${size}%`,
        opacity: motif.opacity,
        transform: "translate(-50%, -50%)",
      }}
    >
      {glyph}
    </svg>
  );
}

export function SeededCoverArt({
  seed,
  density = 0.75,
  pattern = "orbit",
  motifs,
}: {
  seed: string;
  density?: number;
  pattern?: string;
  motifs?: CoverMotif[];
}) {
  const resolvedMotifs = motifs?.length ? motifs : createFallbackMotifs(seed, density, pattern);

  return (
    <span
      className={`collection-card__art collection-card__art--${pattern}`}
      aria-hidden="true"
      style={mosaicStyle()}
    >
      <span className="cover-mosaic">
        <ProductMark />
        {resolvedMotifs.map((motif, index) => (
          <MotifMark key={`${motif.shape}-${index}`} motif={motif} />
        ))}
      </span>
    </span>
  );
}
