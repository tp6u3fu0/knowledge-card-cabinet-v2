import type { RelationEdge } from "./types";

export const relationPairs = [
  ["attention", "qkv"],
  ["attention", "transformer"],
  ["qkv", "transformer"],
  ["transformer", "rag"],
] as const;

export const relationLabels: Record<string, string> = {
  "attention-qkv": "拆解機制",
  "attention-transformer": "延伸架構",
  "qkv-transformer": "組成關係",
  "rag-transformer": "應用方法",
};

export const defaultRelationEdges: RelationEdge[] = relationPairs.map(([source_id, target_id]) => ({
  source_id,
  target_id,
  relation_type: "semantic",
  score: 0,
  status: "suggested",
}));

export function relationKey(first: string, second: string) {
  return [first, second].sort().join("-");
}

export function relationEdgeKey(edge: Pick<RelationEdge, "source_id" | "target_id" | "relation_type">) {
  return `${relationKey(edge.source_id, edge.target_id)}|${edge.relation_type}`;
}

export function relationEdgeLabel(edge: RelationEdge) {
  if (edge.reason) return edge.reason;
  return edge.relation_type === "manual"
    ? "自製關聯"
    : relationLabels[relationKey(edge.source_id, edge.target_id)] ?? "Embedding 關聯";
}
