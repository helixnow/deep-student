import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { resolveImagePath } from '../src/exam-sheet-service.ts';

const base = mkdtempSync(join(tmpdir(), 'exam-sheet-paths-'));
const images = join(base, 'images');
mkdirSync(images, { recursive: true });
writeFileSync(join(images, 'report..final.png'), 'x');
afterAll(() => { /* the OS temp dir owns cleanup */ });

it('accepts archive-relative names that merely contain two dots', () => {
  expect(resolveImagePath(images, 'images/report..final.png')).toBe(join(realpathSync(images), 'report..final.png'));
});

it('rejects backslash traversal before touching the filesystem', () => {
  const warnings: string[] = [];
  expect(resolveImagePath(images, '..\\secret.png', { warn: message => warnings.push(message) })).toBe(images);
  expect(warnings.join('\n')).toContain('..');
});

it('keeps forward-slash traversal rejected', () => {
  expect(resolveImagePath(images, '../secret.png')).toBe(images);
});
