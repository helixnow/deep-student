import type { ESLint } from 'eslint';

export declare const LINTED: string[];
export declare const IGNORED: string[];
export declare function commandThrowLinter(options?: { baseline?: boolean; cwd?: string }): ESLint;
export declare function lintCommandThrows(options?: { baseline?: boolean; patterns?: string[]; cwd?: string }):
  Promise<{ files: Record<string, number[]>; fatal: string[] }>;
export interface CommandErrorInventoryRow { handlers: number; classified: number; imported: number; bare: number; bareThrows: number }
export declare function commandErrorInventory(options?: { cwd?: string }): Promise<Record<string, CommandErrorInventoryRow>>;
export declare function ownerOf(file: string): string;
export declare function readBaseline(): Record<string, number>;
export declare const SETTLE_GUARDS_PATH: string;
export declare function readSettleGuards(file?: string): { guards: Record<string, string>; unguarded: string[] };
export declare function unguardedOwners(owners: Record<string, CommandErrorInventoryRow>, guards: Record<string, string>): string[];
export declare function settleGuardProblem(owner: string, file: string, cwd?: string): string | null;
