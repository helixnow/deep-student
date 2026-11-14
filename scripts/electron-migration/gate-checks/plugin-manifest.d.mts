export const SCHEMA_FILE: string;
export const BASELINE_FILE: string;
export const OFFICIAL_ROOTS: string[];
export const EXAMPLES_DIR: string;

export type Rule = 'schema' | 'id-context' | 'engines-unsatisfied' | 'range-empty' | 'requires-self' | 'manifest-missing' | 'json-invalid';
export interface Finding { rule: Rule; file: string; line: number; detail: string; message: string; severity?: 'error' | 'info' }
export interface Target { kind: 'official' | 'example'; file: string }
export interface Range { min: [number, number, number]; max: [number, number, number] | null }

export function parseVersion(text: string): { v: [number, number, number]; pre: string | null } | null;
export function parseRange(text: string): Range | null;
export function rangeIsEmpty(range: Range): boolean;
export function satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean | null;
export function schemaProblems(pkg: unknown): string[];
export function targets(root?: string): Target[];
export function checkManifest(input: { file: string; kind: Target['kind']; text: string; appVersion: string }): Finding[];
export function scan(root?: string): { appVersion: string; targets: Target[]; findings: Finding[] };
export function applyBaseline(findings: Finding[], baseline: { entries?: unknown[] }): { fresh: Finding[]; stale: unknown[] };
export function baselineFrom(findings: Finding[], previous?: { entries?: unknown[] }): { rule: Rule; file: string; detail: string; count: number }[];
export function baselineGrowth(previous: { entries?: unknown[] }, entries: unknown[]): unknown[];
export function run(options?: { root?: string }): {
  gate: 'plugin-manifest';
  findings: Finding[];
  all: Finding[];
  summary: { appVersion: string; official: number; examples: number; existing: number; byRule: Record<string, number>; baselined: number; fresh: number; stale: number };
  baseline: { description?: string; entries: { rule: Rule; file: string; detail: string; count: number }[] };
  hasBaseline: boolean;
};
