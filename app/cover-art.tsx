import type { CSSProperties } from "react";

export type CoverMotif = {
  shape: "block" | "stair" | "corner" | "zigzag" | "stack" | "window" | "plus" | "frame";
  x: number;
  y: number;
  size: number;
  rotation: number;
  opacity: number;
  weight: number;
};

const motifShapes: CoverMotif["shape"][] = [
  "block",
  "stair",
  "corner",
  "zigzag",
  "stack",
  "window",
  "plus",
  "frame",
];

const motifSize = 8.4;

const motifLayout: Array<[number, number, number]> = [
  [11, 11, 0],
  [37, 11, 0],
  [63, 11, 0],
  [89, 11, 90],
  [89, 37, 90],
  [89, 63, 90],
  [89, 89, 180],
  [63, 89, 180],
  [37, 89, 180],
  [11, 89, 270],
  [11, 63, 270],
  [11, 37, 270],
];

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
  const random = createSeededRandom(`${seed}:${pattern}:edge-blocks`);
  const count = 12;

  return Array.from({ length: count }, (_, index) => {
    const [x, y, rotation] = motifLayout[index];

    return {
      shape: motifShapes[Math.floor(random() * motifShapes.length)],
      x,
      y,
      size: motifSize,
      rotation,
      opacity: 0.36 + random() * 0.42,
      weight: random(),
    };
  });
}

function mosaicStyle(): CSSProperties {
  return {
    "--motif-ink": "color-mix(in srgb, var(--cover-color) 78%, #292633)",
  } as CSSProperties;
}

function ProductMark({ pattern }: { pattern: string }) {
  const rotation = pattern === "grid" ? 0 : pattern === "ladder" ? -5 : pattern === "shelf" ? 5 : -3;

  return (
    <g className={`cover-mosaic__product cover-mosaic__product--${pattern}`}>
      <circle className="cover-mosaic__product-halo" cx="50" cy="50" r="19" />
      <rect className="cover-mosaic__product-card" x="39" y="37" width="22" height="27" rx="4" transform={`rotate(${rotation} 50 50)`} />
      <path className="cover-mosaic__product-fold" d="M 54 38 V 44 H 60" transform={`rotate(${rotation} 50 50)`} />
      <path className="cover-mosaic__product-line" d="M 44 49 H 55 M 44 54 H 52 M 44 59 H 56" transform={`rotate(${rotation} 50 50)`} />
      <circle className="cover-mosaic__product-core" cx="50" cy="50" r="2.6" />
    </g>
  );
}

function blockTiles(x: number, y: number, unit: number, points: Array<[number, number]>) {
  return points.map(([dx, dy], index) => (
    <rect
      key={`tile-${index}`}
      x={x + dx * unit - unit / 2}
      y={y + dy * unit - unit / 2}
      width={unit - 0.35}
      height={unit - 0.35}
      rx={unit * 0.08}
    />
  ));
}

function MotifMark({ motif }: { motif: CoverMotif }) {
  const className = `cover-mosaic__motif cover-mosaic__motif--${motif.shape}${motif.weight > 0.7 ? " is-heavy" : ""}`;
  const transform = `rotate(${motif.rotation} ${motif.x} ${motif.y})`;
  const unit = motif.size / 3;

  if (motif.shape === "block") {
    return <g className={className} opacity={motif.opacity} transform={transform}>{blockTiles(motif.x, motif.y, unit, [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]])}</g>;
  }

  if (motif.shape === "stair") {
    return <g className={className} opacity={motif.opacity} transform={transform}>{blockTiles(motif.x, motif.y, unit, [[-1, -1], [0, -1], [0, 0], [1, 0]])}</g>;
  }

  if (motif.shape === "corner") {
    return <g className={className} opacity={motif.opacity} transform={transform}>{blockTiles(motif.x, motif.y, unit, [[-1, -1], [-1, 0], [0, 0], [1, 0]])}</g>;
  }

  if (motif.shape === "zigzag") {
    return <g className={className} opacity={motif.opacity} transform={transform}>{blockTiles(motif.x, motif.y, unit, [[-1, 0], [0, 0], [0, -1], [1, -1]])}</g>;
  }

  if (motif.shape === "stack") {
    return <g className={className} opacity={motif.opacity} transform={transform}>{blockTiles(motif.x, motif.y, unit, [[-1, -1], [0, -1], [0, 0], [0, 1]])}</g>;
  }

  if (motif.shape === "window") {
    return (
      <g className={className} opacity={motif.opacity} transform={transform}>
        <rect x={motif.x - unit * 1.5} y={motif.y - unit * 1.5} width={unit * 3} height={unit * 3} rx={unit * 0.1} />
        <path d={`M ${motif.x} ${motif.y - unit * 1.5} V ${motif.y + unit * 1.5} M ${motif.x - unit * 1.5} ${motif.y} H ${motif.x + unit * 1.5}`} />
      </g>
    );
  }

  if (motif.shape === "plus") {
    return <g className={className} opacity={motif.opacity} transform={transform}>{blockTiles(motif.x, motif.y, unit, [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1]])}</g>;
  }

  return (
    <g className={className} opacity={motif.opacity} transform={transform}>
      <rect x={motif.x - unit * 1.5} y={motif.y - unit * 1.5} width={unit * 3} height={unit * 0.65} rx={unit * 0.08} />
      <rect x={motif.x - unit * 1.5} y={motif.y + unit * 0.85} width={unit * 3} height={unit * 0.65} rx={unit * 0.08} />
      <rect x={motif.x - unit * 1.5} y={motif.y - unit * 1.5} width={unit * 0.65} height={unit * 3} rx={unit * 0.08} />
      <rect x={motif.x + unit * 0.85} y={motif.y - unit * 1.5} width={unit * 0.65} height={unit * 3} rx={unit * 0.08} />
    </g>
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
    <span className={`collection-card__art collection-card__art--${pattern}`} aria-hidden="true">
      <svg className="cover-mosaic" viewBox="0 0 100 100" preserveAspectRatio="none" style={mosaicStyle()}>
        <ProductMark pattern={pattern} />
        <g className="cover-mosaic__motifs">
          {resolvedMotifs.map((motif, index) => (
            <MotifMark key={`${motif.shape}-${index}`} motif={motif} />
          ))}
        </g>
      </svg>
    </span>
  );
}
