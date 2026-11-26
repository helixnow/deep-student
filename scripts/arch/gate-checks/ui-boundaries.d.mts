export const BASELINE_FILE: string;

export interface SourceEntry { file: string; text: string }

export type Rule = 'plugin-tauri-import' | 'ua-sniffing' | 'bare-custom-event' | 'plugin-import-boundary' | 'cross-feature-import';

export interface Finding {
  rule: Rule;
  file: string;
  line: number;
  message: string;
  /** import 规则：解析后的目标路径 */
  target?: string;
  /** import 规则的基线分键：插件规则为目标前三段路径，跨 feature 规则为 src/features/<B> */
  scope?: string;
  severity?: 'error' | 'info';
}

export interface BaselineEntry { rule: Rule; file: string; scope?: string; count: number; reason?: string }
export interface Baseline { description?: string; entries: BaselineEntry[] }

export function inScope(file: string): boolean;
export function pluginUnit(file: string): string | null;
export function featureOf(file: string): string | null;
export function resolveImport(from: string, specifier: string, known: Set<string>): string | null;
export function scanUiBoundaries(entries: SourceEntry[], options?: { known?: Set<string> }): Finding[];
export function applyBaseline(findings: Finding[], baseline: Baseline): { fresh: Finding[]; stale: (BaselineEntry & { present: number })[] };
export function baselineFrom(findings: Finding[], previous?: Baseline): BaselineEntry[];
export function baselineGrowth(previous: Baseline | undefined, entries: BaselineEntry[]): { rule: Rule; file: string; scope?: string; from: number; to: number }[];
export function run(options?: { root?: string }): {
  gate: 'ui-boundaries';
  findings: Finding[];
  all: Finding[];
  summary: { files: number; existing: number; byRule: Partial<Record<Rule, number>>; baselined: number; fresh: number; stale: number };
  baseline: Baseline;
  hasBaseline: boolean;
};
