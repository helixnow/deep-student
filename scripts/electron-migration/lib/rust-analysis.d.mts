export interface RustTest { kind: string; name: string | null; mods: string[]; line: number; attrLine: number }
export interface FileAnalysis {
  rel: string;
  lines: number;
  tests: RustTest[];
  defs: { name: string; kind: string; inline: string[]; vis: string; line: number; signature: string; implType?: string[] }[];
  uses: { segs: string[]; alias: string; glob: boolean; inline: string[]; vis: string; line: number }[];
  emits: { method: string; arg: string; line: number; index: number }[];
  listens: { method: string; name: string; line: number }[];
  modDecls: { name: string; inline: string[]; pathAttr: string | null }[];
  mods: { start: number; end: number; path: string[]; test: boolean }[];
  scopedRefs: { segs: string[]; index: number; line: number }[];
  identSites: Record<string, { line: number; index: number }[]>;
  strConsts: Record<string, string>;
  testCode: { start: number; end: number }[];
}
export const TEST_ATTR_RE: RegExp;
export function pathSegments(text: string): string[] | null;
export function analyzeFile(parser: unknown, rel: string, text: string, opts?: { refs?: boolean }): FileAnalysis;
export function crateRootName(rel: string): string | null;
export function buildModuleTree(analyses: FileAnalysis[]): Map<string, { path: string[]; inferred: boolean; crate: string; test?: boolean }>;
export class RustIndex {
  constructor(analyses: FileAnalysis[], fileMod: Map<string, { path: string[]; inferred: boolean; crate: string }>, laneOf: (rel: string) => string | null);
  defs: Map<string, { id: string; name: string; kind: string; file: string; lane: string | null; line: number; signature: string }>;
  resolveFrom(modPath: string[], segs: string[]): { def?: string; module?: string; viaGlob?: boolean } | null;
  resolveInFile(a: FileAnalysis, index: number, segs: string[]): { def?: string; module?: string; viaGlob?: boolean } | null;
}
export function testRows(analyses: FileAnalysis[], laneOf: (rel: string) => string | null): { id: string; lane: string; file: string; line: number; attrLine: number; kind: string; name: string | null; real: boolean }[];
export function resolveEmitName(e: { arg: string }, a: { strConsts: Record<string, string> }, globalConsts: Map<string, Set<string>>): { name: string; dynamic: boolean; via?: string; expr?: boolean };
