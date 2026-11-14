export type Tier = 'service' | 'desktop-only' | 'web-standard';

export interface Finding {
  rule: 'node-builtin' | 'native' | 'node-package' | 'node-global';
  module: string;
  category: string;
  tier: Tier;
  replacement: string;
  weight: number;
  specifier: string;
  line: number;
  typeOnly: boolean;
  kind: 'import' | 'require' | 'dynamic' | 'global';
}

export interface SourceAnalysis {
  findings: Finding[];
  runtimeSpecifiers: string[];
  syncCalls: number;
}

export interface ClosureViolation { file: string; key: string; line: number }

export const MOBILE_CORE: readonly string[];
export function nodeBuiltinName(specifier: string): string | null;
export function findingKey(finding: Pick<Finding, 'rule' | 'module' | 'typeOnly'>): string;
export function analyzeSource(rel: string, text: string): SourceAnalysis;
export function declaredPlatforms(text: string): string[] | null;
export function checkModulesClosure(root: string, entries: readonly string[]): ClosureViolation[];
export function checkProfileClosure(root: string, profilePath: string): Array<{ id: string; module: string; violations: ClosureViolation[] }>;
