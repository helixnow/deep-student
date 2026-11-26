export const BASELINE_FILE: string;

export interface ContractCommand {
  name: string;
  args: { key: string; optional: boolean }[];
  injected?: { kind: string }[];
}

export interface InvokeSite {
  file: string;
  line: number;
  callee: string;
  function: string;
  dynamic: boolean;
  command?: string;
  expression?: string;
  keys?: { key: string; line: number }[];
  open?: boolean;
}

export type Rule = 'dynamic-command' | 'unknown-command' | 'unknown-arg' | 'missing-required';

export interface Finding {
  rule: Rule;
  file: string;
  line: number;
  function: string;
  command: string | null;
  key: string | null;
  message: string;
  severity?: 'error' | 'info';
}

export interface BaselineEntry {
  rule: Rule;
  file: string;
  function?: string;
  command?: string;
  key?: string;
  count?: number;
  reason?: string;
}

export interface Baseline { entries: BaselineEntry[]; [k: string]: unknown }

export function loadCommandContracts(root?: string): Map<string, ContractCommand>;
export function scanSources(entries: { file: string; text: string }[]): InvokeSite[];
export function scanFile(file: string, text: string): InvokeSite[];
export function judge(sites: InvokeSite[], contracts: Map<string, ContractCommand>): Finding[];
export interface OpenArgSite { file: string; line: number; function: string; command: string; keys: string[] }
export function openArgSites(sites: InvokeSite[], contracts?: Map<string, ContractCommand>): OpenArgSite[];
export function findingKey(f: Pick<Finding, 'rule' | 'file' | 'function' | 'command' | 'key'>): string;
export function applyBaseline(findings: Finding[], baseline: Baseline): { fresh: Finding[]; stale: (BaselineEntry & { present: number; severity: 'info' })[] };
export function baselineFrom(findings: Finding[], previous?: Baseline): BaselineEntry[];
export function frontendFiles(root?: string): string[];
export function run(options?: { root?: string }): {
  gate: string;
  findings: (Finding | (BaselineEntry & { line: number; message: string; severity: 'info' }))[];
  all: Finding[];
  review: OpenArgSite[];
  summary: { sites: number; literal: number; dynamic: number; existing: number; baselined: number; fresh: number; stale: number; review: number };
  baseline: Baseline;
};
