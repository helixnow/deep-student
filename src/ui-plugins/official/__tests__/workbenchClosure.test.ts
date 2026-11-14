// @vitest-environment node
/**
 * FE-B4 evidence: the Workbench app chunk stays out of the code loaded at startup.
 *
 * Startup code = the entry's static closure (`src/main.tsx`) plus the boot chunk it imports right away (UI kernel
 * bootstrap + every official UI plugin). The golden lists the `src/features/workbench/**` modules in each, captured
 * before FE-B4; afterwards the sets may only shrink, and WorkbenchDesktop, `apps/registerAll`, the app register
 * modules (except the chat one the entry already reached) and every app window must stay out.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { relative, staticClosure } from './importGraph';

const GOLDEN = 'src/ui-plugins/official/__tests__/__golden__/workbench-closure.json';
const ENTRY = ['src/main.tsx'];
const BOOT = ['src/ui-kernel/bootstrap.ts', 'src/ui-plugins/official/install.ts'];
const workbench = (files: string[]) => files.filter((file) => file.startsWith('src/features/workbench/'));

describe('Workbench chunk vs startup closure (FE-B4)', () => {
  const entry = relative(staticClosure(ENTRY));
  const boot = relative(staticClosure(BOOT));
  const startup = new Set([...entry, ...boot]);

  it('adds no Workbench module to the entry or boot closure except the contribution bridge', () => {
    const current = { entry: workbench(entry), boot: workbench(boot) };
    if (process.env.FE_B4_CAPTURE_GOLDEN === '1') {
      fs.mkdirSync('src/ui-plugins/official/__tests__/__golden__', { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as typeof current;
    const bridge = 'src/features/workbench/core/appContributions.ts';
    expect(current.entry.filter((file) => !golden.entry.includes(file) && file !== bridge)).toEqual([]);
    expect(current.boot.filter((file) => !golden.entry.includes(file) && !golden.boot.includes(file) && file !== bridge)).toEqual([]);
    // The bridge is how the startup plugin reaches the lazy app modules; it must not drag anything in itself.
    expect(relative(staticClosure([bridge]))).toEqual([
      bridge,
      'src/features/workbench/core/appRegistry.ts',
      'src/ui-kernel/lazy.ts',
      'src/ui-sdk/lazy.ts',
    ]);
  });

  it('keeps WorkbenchDesktop, apps/registerAll, the app register modules and app windows lazy', () => {
    const lazyOnly = relative(fs.readdirSync('src/features/workbench/apps', { recursive: true, encoding: 'utf8' })
      .map((file) => `src/features/workbench/apps/${file}`)
      .filter((file) => /\/register\.tsx?$|AppWindow[^/]*\.tsx$|registerAll\.ts$/.test(file) && !file.endsWith('/chat/register.ts')));
    expect(lazyOnly.length).toBeGreaterThan(20);
    expect([...lazyOnly, 'src/features/workbench/components/WorkbenchDesktop.tsx'].filter((file) => startup.has(file))).toEqual([]);
  });
});
