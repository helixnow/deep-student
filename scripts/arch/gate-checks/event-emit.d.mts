export const BASELINE_FILE: string;

export interface SourceEntry { file: string; text: string }

/** 字符串片段与通配（null）交替。 */
export type Pattern = (string | null)[];

export interface ListenSite {
  file: string;
  line: number;
  function: string;
  patterns: Pattern[] | null;
  expression: string;
}

export interface Emitters { patterns: Pattern[]; sites: number; dynamic: number }

export type Rule = 'dynamic-event' | 'unemitted-event';

export interface Finding {
  rule: Rule;
  file: string;
  line: number;
  function: string;
  event: string | null;
  message: string;
  severity?: 'error' | 'info';
}

export interface BaselineEntry {
  rule: Rule;
  file: string;
  function?: string;
  event?: string;
  count?: number;
  reason?: string;
}

export interface Baseline { entries: BaselineEntry[]; [k: string]: unknown }

export const REGISTRATION_ENTRIES: ({ file: string; export: string } | { file: string; hook: string; member: string })[];
export function display(pattern: Pattern): string;
export function matches(listener: Pattern, emitters: Pattern[]): boolean;
export function scanListeners(entries: SourceEntry[], onlyFiles?: Set<string> | null): { sites: ListenSite[] };
export function scanEmitters(entries: SourceEntry[], onlyFiles?: Set<string> | null): Emitters;
export function judge(listeners: { sites: ListenSite[] }, emitters: Emitters): Finding[];
export function findingKey(f: Pick<Finding, 'rule' | 'file' | 'function' | 'event'>): string;
export function applyBaseline(findings: Finding[], baseline: Baseline): { fresh: Finding[]; stale: (BaselineEntry & { present: number; severity: 'info' })[] };
export function baselineFrom(findings: Finding[], previous?: Baseline): BaselineEntry[];
export function emitterFiles(root?: string): string[];
export function run(options?: { root?: string }): {
  gate: string;
  findings: (Finding | (BaselineEntry & { line: number; message: string; severity: 'info' }))[];
  all: Finding[];
  summary: {
    listeners: number;
    emitters: number;
    dynamicEmitters: number;
    existing: number;
    unemitted: number;
    dynamic: number;
    baselined: number;
    fresh: number;
    stale: number;
  };
  baseline: Baseline;
};
