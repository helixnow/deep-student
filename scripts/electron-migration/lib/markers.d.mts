export function begin(key: string): string;
export function end(key: string): string;
export function block(key: string, body: string): string;
export function parseBlocks(text: string): Map<string, { start: number; end: number; inner: string }>;
export function mergeUnits(oldText: string, units: { key: string; text: string }[]): { text: string; added: number; updated: number; orphaned: string[] };
