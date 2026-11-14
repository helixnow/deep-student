import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;

describe('package.json build scripts', () => {
  const viteBuilds = Object.entries(scripts).filter(([, cmd]) => /\bvite(\.js)?\s+build\b/.test(cmd));

  it('finds the vite build scripts', () => {
    expect(viteBuilds.map(([name]) => name)).toEqual(expect.arrayContaining(['build', 'build:demo']));
  });

  it.each(viteBuilds)('%s raises the V8 heap limit portably (the default OOMs)', (_name, cmd) => {
    // `NODE_OPTIONS=… vite build` is POSIX-only; a node flag works in cmd.exe and PowerShell too.
    expect(cmd).not.toMatch(/^\s*NODE_OPTIONS=/);
    const heap = /^node --max-old-space-size=(\d+) node_modules\/vite\/bin\/vite\.js build\b/.exec(cmd);
    expect(heap, cmd).not.toBeNull();
    expect(Number(heap![1])).toBeGreaterThanOrEqual(8192);
  });
});
