/**
 * FE-A1 boot gate (`tests/visual/lib/boot-check.mjs`): the static chunk-cycle scan and its report, on a
 * synthetic build directory (no Vite build, no browser).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chunkCycles, formatCycle } from '../../../../tests/visual/lib/boot-check.mjs';

const repoRoot = path.resolve(__dirname, '../../../..');
let dist: string | undefined;

function writeBuild(files: Record<string, string>, modules?: Record<string, string[]>) {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-boot-check-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  for (const [name, code] of Object.entries(files)) fs.writeFileSync(path.join(dist, 'assets', name), code);
  if (modules) {
    const chunks = Object.entries(modules).map(([name, ids]) => ({ fileName: `assets/${name}`, modules: Object.fromEntries(ids.map((id) => [id, 1])) }));
    fs.writeFileSync(path.join(dist, '.ds-chunks.json'), JSON.stringify({ chunks, assets: [] }));
  }
  return dist;
}

afterEach(() => {
  if (dist) fs.rmSync(dist, { recursive: true, force: true });
  dist = undefined;
});

describe('FE-A1 boot gate: chunk cycles', () => {
  it('finds a static cycle through import and re-export edges, with the loop and the imported bindings', () => {
    const build = writeBuild({
      'ui-boot-AAAA.js': 'import{a as p,d as e}from"./vendor-react-BBBB.js";import"./leaf-DDDD.js";export const b5=1;',
      'vendor-react-BBBB.js': 'export{b5 as zl}from"./vendor-micro-CCCC.js";const x=import("./lazy-EEEE.js");',
      'vendor-micro-CCCC.js': 'import{b5}from"./ui-boot-AAAA.js";export{b5};',
      'leaf-DDDD.js': 'export const leaf=1;',
      'lazy-EEEE.js': 'import{leaf}from"./leaf-DDDD.js";const back=()=>import("./ui-boot-AAAA.js");',
    }, {
      'ui-boot-AAAA.js': [`${repoRoot}/src/ui-kernel/bootstrap.ts`, `\0${path.dirname(repoRoot)}/deep-student/node_modules/void-elements/index.js?commonjs-es-import`, '\0commonjsHelpers.js'],
      'vendor-react-BBBB.js': [`${path.dirname(repoRoot)}/deep-student/node_modules/react/index.js`],
      'vendor-micro-CCCC.js': [],
    });
    const cycles = chunkCycles(build);
    expect(cycles).toHaveLength(1);
    const [cycle] = cycles;
    expect(cycle.members).toEqual(['ui-boot-AAAA.js', 'vendor-micro-CCCC.js', 'vendor-react-BBBB.js']);
    expect(cycle.loop).toEqual(['ui-boot-AAAA.js', 'vendor-react-BBBB.js', 'vendor-micro-CCCC.js', 'ui-boot-AAAA.js']);
    expect(cycle.steps.map((step) => step.imports)).toEqual([['a as p', 'd as e'], ['b5 as zl'], ['b5']]);
    expect(cycle.chunks?.['ui-boot-AAAA.js'].virtual[0]).toBe('\\0commonjsHelpers.js');
    const report = formatCycle(cycle);
    expect(report).toContain('loop: ui-boot-AAAA.js → vendor-react-BBBB.js → vendor-micro-CCCC.js → ui-boot-AAAA.js');
    expect(report).toContain('vendor-micro-CCCC.js imports {b5} from ui-boot-AAAA.js');
    expect(report).toContain('\\0node_modules/void-elements/index.js?commonjs-es-import');
    expect(report).toContain('e.g. src/ui-kernel/bootstrap.ts');
  });

  it('ignores dynamic imports and reports no cycle for an acyclic static graph', () => {
    const build = writeBuild({
      'main-AAAA.js': 'import{r}from"./vendor-react-BBBB.js";const page=()=>import("./page-CCCC.js");',
      'vendor-react-BBBB.js': 'export const r=1;',
      'page-CCCC.js': 'import{r}from"./vendor-react-BBBB.js";import"./main-AAAA.js";',
    });
    // page → main is static, main → page only dynamic: not a cycle.
    expect(chunkCycles(build)).toEqual([]);
  });
});
