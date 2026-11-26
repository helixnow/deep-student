import type { ESLint } from 'eslint';

export declare const REPO_ROOT: string;
export declare const BASELINE_PATH: string;
export declare const LINTED: string[];
export declare const IGNORED: string[];
export declare function deprecatedLinter(options?: { cwd?: string }): ESLint;
export declare function lintDeprecated(options?: { patterns?: string[]; cwd?: string }):
  Promise<{ files: Record<string, string[]>; fatal: string[] }>;
export declare function readBaseline(): Record<string, number>;
export declare function compareWithBaseline(files: Record<string, string[]>, baseline: Record<string, number>): {
  over: { file: string; count: number; baseline: number; uses: string[] }[];
  stale: { file: string; count: number; baseline: number }[];
};
