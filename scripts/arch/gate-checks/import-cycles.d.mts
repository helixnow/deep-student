export const BASELINE_FILE: string;

export interface ImportEdge { to: string; line: number }
export type ImportGraph = Map<string, ImportEdge[]>;

export interface Finding {
  rule: 'runtime-import-cycle';
  file: string;
  line: number;
  to: string;
  cycle: string[];
  crossPlugin: boolean;
  message: string;
  severity?: 'error' | 'info';
}

export interface BaselineEntry { file: string; to: string; count: number; reason?: string }
export interface Baseline { description?: string; entries: BaselineEntry[] }

export function entryPoints(root: string): string[];
export function resolveSpecifier(root: string, from: string, specifier: string): string | null;
export function runtimeImports(file: string, text: string): { specifier: string; line: number }[];
export function importGraph(root: string, entries?: string[]): ImportGraph;
export function cyclicComponents(graph: ImportGraph): string[][];
export function ownerOf(file: string): string;
export function scanImportCycles(graph: ImportGraph): { components: string[][]; findings: Finding[] };
export function applyBaseline(findings: Finding[], baseline: Baseline): { fresh: Finding[]; stale: (BaselineEntry & { present: number })[] };
export function baselineFrom(findings: Finding[], previous?: Baseline): BaselineEntry[];
export function baselineGrowth(previous: Baseline | undefined, entries: BaselineEntry[]): { file: string; to: string; from: number; count: number }[];
export function run(options?: { root?: string }): {
  gate: 'import-cycles';
  findings: Finding[];
  all: Finding[];
  components: string[][];
  summary: { entries: number; modules: number; components: number; cyclicEdges: number; crossPlugin: number; baselined: number; fresh: number; stale: number };
  baseline: Baseline;
  hasBaseline: boolean;
};
