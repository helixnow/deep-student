export interface Violation { rule: string; file: string; line: number; col: number; message: string; suppressed?: boolean }
export const RULES: Record<string, string>;
export const ALLOW_RE: RegExp;
export function isSourceFile(rel: string): boolean;
export function isTestFile(rel: string): boolean;
export function looksLikeSql(s: string): boolean;
export function isDoubleIdentifier(name: string): boolean;
export function checkFile(rel: string, text: string): Violation[];
