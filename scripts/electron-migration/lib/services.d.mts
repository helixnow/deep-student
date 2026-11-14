import type { FileAnalysis, RustIndex } from './rust-analysis.mjs';
export interface CrossRef { def: string; providerLane: string; lane: string; file: string; via: 'use' | 'path'; line: number; test: boolean; uncertain: boolean; sites: { line: number; test: boolean }[] }
export function crossLaneRefs(repo: {
  analyses: FileAnalysis[];
  fileMod: Map<string, { path: string[]; inferred: boolean; crate: string; test?: boolean }>;
  index: RustIndex;
  laneOf: (rel: string) => string | null;
}): { refs: CrossRef[]; globRefs: { module: string; providerLane: string; lane: string; file: string; line: number; test: boolean }[] };
