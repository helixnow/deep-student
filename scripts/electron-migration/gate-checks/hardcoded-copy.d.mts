export const BASELINE_FILE: string;
export const COPY_ATTRIBUTES: Set<string>;

export interface SourceEntry { file: string; text: string }

export type Rule = 'jsx-text' | 'jsx-expression' | 'jsx-attribute' | 'notification';

export interface Finding {
  rule: Rule;
  file: string;
  line: number;
  /** 命中的静态文本（模板占位记作 {}），截到 80 字符 */
  text: string;
  message: string;
  severity?: 'error' | 'info';
}

export interface BaselineEntry { rule: Rule; file: string; count: number; reason?: string }
export interface Baseline { description?: string; entries: BaselineEntry[] }

export function looksLikeCopy(text: string): boolean;
export function inScope(file: string): boolean;
export function copyLiterals(expr: unknown): { node: unknown; text: string }[];
export function scanHardcodedCopy(entries: SourceEntry[]): Finding[];
export function applyBaseline(findings: Finding[], baseline: Baseline): { fresh: Finding[]; stale: (BaselineEntry & { present: number; severity: 'info' })[] };
export function baselineFrom(findings: Finding[], previous?: Baseline): BaselineEntry[];
export function baselineGrowth(previous: Baseline | undefined, entries: BaselineEntry[]): { rule: Rule; file: string; from: number; to: number }[];
export function inventory(findings: Finding[], top?: number): {
  total: number;
  files: number;
  byRule: Partial<Record<Rule, number>>;
  top: { file: string; count: number }[];
};
export function run(options?: { root?: string }): {
  gate: 'hardcoded-copy';
  findings: Finding[];
  all: Finding[];
  summary: { files: number; existing: number; byRule: Partial<Record<Rule, number>>; baselined: number; fresh: number; stale: number };
  baseline: Baseline;
  hasBaseline: boolean;
};
