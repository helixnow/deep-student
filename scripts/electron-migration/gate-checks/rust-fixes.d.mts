export const REGISTRY_DIR: string;
export const SCHEMA_FILE: string;

export interface Marker { id: string; file: string; line: number }
export interface Finding { rule: 'schema' | 'id' | 'marker' | 'test' | 'rust' | 'commit'; file: string; line: number; message: string; severity: 'error' }

export function scanMarkers(root: string): Marker[];
export function hasIdTitle(text: string, id: string): boolean;
export function checkRustFixes(root?: string): { entries: Record<string, unknown>[]; markers: Marker[]; findings: Finding[] };
export interface Commit { sha: string; short: string; date: string | null; subject: string | null; source: 'registered' | 'grep' }
export function commitExists(root: string, sha: string): boolean;
export function reviewCommits(root: string, entry: { id: string; commits?: string[] }, rev?: string): Commit[] | null;
export function commitsFor(root: string, id: string, rev?: string): Commit[] | null;
export function review(options?: { root?: string; rev?: string }): {
  gate: 'rust-fixes-review';
  rev: string;
  proposed: {
    id: string; kind: string; title: string; file: string; fixFiles: string[]; userVisible: string | null; dataCompat: string | null;
    g3: { affects: boolean | null; selectors: number }; tests: string[]; commits: Commit[] | null;
  }[];
  approved: string[];
  errors: number;
};
export function run(options?: { root?: string }): {
  gate: 'rust-fixes';
  findings: Finding[];
  entries: Record<string, unknown>[];
  markers: Marker[];
  summary: { entries: number; markers: number; byStatus: Record<string, number>; errors: number };
};
