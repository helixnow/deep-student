// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fsAllow } from '../../vitest.config';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function workspace() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'w09-fs-allow-')));
  roots.push(base);
  const root = path.join(base, 'wt', 'W99');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{}\n');
  return { base, root };
}

describe('vitest server.fs.allow', () => {
  it('a symlinked node_modules adds exactly its real directory next to the workspace root', () => {
    const { base, root } = workspace();
    const shared = path.join(base, 'shared', 'node_modules');
    mkdirSync(path.join(shared, 'katex', 'dist'), { recursive: true });
    symlinkSync(shared, path.join(root, 'node_modules'), 'dir');
    expect(fsAllow(root)).toEqual([root, shared]);
    expect(fsAllow(root)).not.toContain(base);
    expect(fsAllow(root)).not.toContain(path.join(base, 'shared'));
  });

  it('a regular node_modules keeps the default (workspace root only, de-duplicated)', () => {
    const { root } = workspace();
    mkdirSync(path.join(root, 'node_modules'));
    const allow = fsAllow(root);
    expect(allow[0]).toBe(root);
    expect(allow.every((dir) => dir === root || dir.startsWith(`${root}${path.sep}`))).toBe(true);
  });
});
