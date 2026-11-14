/**
 * Pre-migration evidence for the wave-2 registry moves (FE-B5 editor, FE-B7 debug panels, FE-B8 dashboard,
 * FE-B9 menus). Each golden is captured once on the commit before the move and must stay equal afterwards.
 *
 * - `expectGolden` compares with `src/ui-plugins/testing/__golden__/evidence/<name>`; with
 *   `W16_CAPTURE_GOLDEN=1` a missing golden is written once (`wx`, existing files are never rewritten).
 *   On a mismatch the actual value is written to `tests/visual/.out/evidence/<name>` for review, and the
 *   assertion message carries the differing lines (`describeTextDiff`).
 * - `bootAppUi` is the production UI assembly (`createAppUiKernel()` with every official UI plugin installed,
 *   provided to the tree), so a feature that starts reading its slot after the move renders the same tree here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ReactElement, ReactNode } from 'react';
import { expect } from 'vitest';
import type { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';

export const EVIDENCE_DIR = path.resolve('src/ui-plugins/testing/__golden__/evidence');
const OUT_DIR = path.resolve('tests/visual/.out/evidence');
const capture = process.env.W16_CAPTURE_GOLDEN === '1';

function serialize(actual: unknown): string {
  return typeof actual === 'string' ? (actual.endsWith('\n') ? actual : `${actual}\n`) : `${JSON.stringify(actual, null, 2)}\n`;
}

/**
 * The region between the first and the last differing line of two texts, line-numbered and capped, for
 * assertion messages: JSON reporters (the server's land-test) keep the message but not vitest's diff.
 */
export function describeTextDiff(expected: string, actual: string, { context = 2, maxLines = 30 } = {}): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && start === b.length) return '(texts are equal)';
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const width = String(Math.max(a.length, b.length)).length;
  const row = (sign: string, n: number, line: string) => `${sign} ${String(n).padStart(width)} ${line}`;
  const side = (sign: string, lines: string[], from: number, to: number) => {
    const shown = lines.slice(from, Math.min(to, from + maxLines)).map((line, i) => row(sign, from + i + 1, line));
    if (to - from > maxLines) shown.push(`${sign} … ${to - from - maxLines} more line(s)`);
    return shown;
  };
  const before = a.slice(Math.max(0, start - context), start).map((line, i) => row(' ', Math.max(0, start - context) + i + 1, line));
  const after = a.slice(endA, endA + context).map((line, i) => row(' ', endA + i + 1, line));
  return [
    `first difference at line ${start + 1}: golden lines ${start + 1}–${endA}, actual lines ${start + 1}–${endB}`,
    ...before,
    ...side('-', a, start, endA),
    ...side('+', b, start, endB),
    ...after,
  ].join('\n');
}

export function expectGolden(name: string, actual: unknown): void {
  const file = path.join(EVIDENCE_DIR, name);
  const text = serialize(actual);
  if (capture && !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { flag: 'wx' });
    return;
  }
  expect(fs.existsSync(file), `missing golden ${path.relative(process.cwd(), file)} (capture on the pre-migration commit with W16_CAPTURE_GOLDEN=1)`).toBe(true);
  const expected = fs.readFileSync(file, 'utf8');
  let message: string | undefined;
  if (expected !== text) {
    fs.mkdirSync(path.dirname(path.join(OUT_DIR, name)), { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, name), text);
    message = `golden ${name} differs (actual written to ${path.relative(process.cwd(), path.join(OUT_DIR, name))})\n${describeTextDiff(expected, text)}\n`;
  }
  if (typeof actual === 'string') expect(text, message).toBe(expected);
  else expect(JSON.parse(text), message).toEqual(JSON.parse(expected));
}

export interface AppUi {
  kernel: UiKernel;
  wrap(node: ReactNode): ReactElement;
  dispose(): Promise<void>;
}

export async function bootAppUi(): Promise<AppUi> {
  const { createAppUiKernel } = await import('@/ui-kernel/bootstrap');
  const kernel = await createAppUiKernel();
  return {
    kernel,
    wrap: (node) => <UiKernelProvider kernel={kernel}>{node}</UiKernelProvider>,
    dispose: () => kernel.dispose(),
  };
}

/** Command name with sorted argument keys (values are not recorded), as in the FE-A1 IPC layer. */
export function callShape(command: string, payload?: Record<string, unknown>): string {
  const keys = payload && typeof payload === 'object' ? Object.keys(payload).sort() : [];
  return `${command}(${keys.join(',')})`;
}
