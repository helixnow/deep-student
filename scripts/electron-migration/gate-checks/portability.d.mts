export interface Item { file: string; line: number; key: string; label: string; module?: string }
export interface Finding extends Item { rule: 'portability' | 'mobile-profile'; message: string }

export function exportHostSources(cwd: string, rev: string, dest: string): number;
export function scanNew(root: string, scannerAbs: string, baselineAbs: string | null, tmp: string): Item[];
export function scanProfile(root: string, scannerAbs: string, profile: string): Item[];
export function introduced<T>(head: T[], base: T[], keyOf: (e: T) => string): T[];
export function run(options: { root: string; base?: string | null; scanner?: string; profile?: string; baseline?: string }): {
  gate: 'portability';
  base: string | null;
  findings: Finding[];
  summary: { headNew: number; baseNew: number; headProfile: number; baseProfile: number; introduced: number };
};
