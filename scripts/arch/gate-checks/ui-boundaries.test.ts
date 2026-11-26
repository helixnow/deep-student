import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_FILE, baselineGrowth, run, scanUiBoundaries, type Finding } from './ui-boundaries.mjs';

const SCRIPT = path.resolve(__dirname, 'ui-boundaries.mjs');
const rules = (findings: Finding[]) => findings.map((f) => `${f.rule} ${f.file}:${f.line}`);

describe('ui-boundaries gate: rules', () => {
  it('plugin code must not import @tauri-apps directly (static, re-export, dynamic, require)', () => {
    const findings = scanUiBoundaries([
      { file: 'src/ui-plugins/official/x/index.ts', text: "import { invoke } from '@tauri-apps/api/core';\nexport { listen } from '@tauri-apps/api/event';\nconst m = await import('@tauri-apps/plugin-fs');\nrequire('@tauri-apps/api/window');\nimport sdk from '@deepstudent/ui';" },
      { file: 'src/plugins/notes/api.ts', text: "import type { Event } from '@tauri-apps/api/event';" },
      { file: 'src/features/chat/a.ts', text: "import { invoke } from '@tauri-apps/api/core';" },
      { file: 'src/ui-plugins/testing/harness.ts', text: "import { invoke } from '@tauri-apps/api/core';" },
      { file: 'src/ui-plugins/official/x/__tests__/a.test.ts', text: "import { invoke } from '@tauri-apps/api/core';" },
    ]);
    expect(rules(findings)).toEqual([
      'plugin-tauri-import src/ui-plugins/official/x/index.ts:1',
      'plugin-tauri-import src/ui-plugins/official/x/index.ts:2',
      'plugin-tauri-import src/ui-plugins/official/x/index.ts:3',
      'plugin-tauri-import src/ui-plugins/official/x/index.ts:4',
    ]);
  });

  it('UA sniffing is only allowed in platform modules', () => {
    const text = "const a = navigator.userAgent;\nconst b = window.navigator.platform;\nconst c = globalThis.navigator?.userAgentData;\nconst d = navigator['vendor'];\nconst ok = navigator.clipboard;";
    const findings = scanUiBoundaries([
      { file: 'src/components/a.tsx', text },
      { file: 'src/utils/platform.ts', text },
      { file: 'src/platform/detect.ts', text },
      { file: 'src/components/__tests__/a.test.tsx', text },
    ]);
    expect(rules(findings)).toEqual([
      'ua-sniffing src/components/a.tsx:1',
      'ua-sniffing src/components/a.tsx:2',
      'ua-sniffing src/components/a.tsx:3',
      'ua-sniffing src/components/a.tsx:4',
    ]);
  });

  it('bare CustomEvent is only allowed inside the app event module', () => {
    const text = "window.dispatchEvent(new CustomEvent('x', { detail: 1 }));\nnew window.CustomEvent('y');\nlet t: CustomEvent<number>;";
    const findings = scanUiBoundaries([
      { file: 'src/features/a.ts', text },
      { file: 'src/events/app.ts', text },
      { file: 'src/demo/a.ts', text },
    ]);
    expect(rules(findings)).toEqual(['bare-custom-event src/features/a.ts:1', 'bare-custom-event src/features/a.ts:2']);
  });

  it('plugins import only their own directory, the SDK, shared/lib and other plugins\' api.ts', () => {
    const known = new Set([
      'src/plugins/notes/plugin.ts', 'src/plugins/notes/view.tsx', 'src/plugins/anki/api.ts', 'src/plugins/anki/internal.ts',
      'src/ui-sdk/index.ts', 'src/shared/ui/Button.tsx', 'src/lib/utils.ts', 'src/features/notes/NotesHome.tsx',
      'src/ui-kernel/kernel.ts', 'src/ui-plugins/official/chat/index.ts', 'src/ui-plugins/official/chat/api.ts', 'src/ui-plugins/official/install.ts',
    ]);
    const findings = scanUiBoundaries([
      {
        file: 'src/plugins/notes/plugin.ts',
        text: [
          "import { View } from './view';",
          "import { definePlugin } from '@/ui-sdk';",
          "import { Button } from '@/shared/ui/Button';",
          "import { cn } from '../../lib/utils';",
          "import type { AnkiUi } from '@/plugins/anki/api';",
          "import React from 'react';",
          "import { helper } from '@/plugins/anki/internal';",
          "import type { Kernel } from '@/ui-kernel/kernel';",
          "const Home = () => import('@/features/notes/NotesHome');",
          "export { chatUi } from '@/ui-plugins/official/chat/api';",
          "import { helper as again } from '../anki/internal';",
        ].join('\n'),
      },
      { file: 'src/ui-plugins/official/chat/index.ts', text: "import { k } from '@/ui-kernel/kernel';\nimport { x } from '../../../plugins/anki/api';" },
      { file: 'src/ui-plugins/official/install.ts', text: "import chat from './chat';\nimport notes from '@/plugins/notes/plugin';" },
      { file: 'src/features/notes/NotesHome.tsx', text: "import { k } from '@/ui-kernel/kernel';" },
    ], { known });
    expect(findings.filter((f) => f.rule === 'plugin-import-boundary').map((f) => `${f.file}:${f.line} ${f.target} [${f.scope}]`)).toEqual([
      'src/plugins/notes/plugin.ts:7 src/plugins/anki/internal.ts [src/plugins/anki]',
      'src/plugins/notes/plugin.ts:8 src/ui-kernel/kernel.ts [src/ui-kernel/kernel.ts]',
      'src/plugins/notes/plugin.ts:9 src/features/notes/NotesHome.tsx [src/features/notes]',
      'src/ui-plugins/official/chat/index.ts:1 src/ui-kernel/kernel.ts [src/ui-kernel/kernel.ts]',
      'src/ui-plugins/official/install.ts:2 src/plugins/notes/plugin.ts [src/plugins/notes]',
    ]);
  });

  it('cross-feature imports count one edge per (file, target), in every import form; same-feature and tests are fine', () => {
    const known = new Set(['src/features/chat/a.ts', 'src/features/chat/b.ts', 'src/features/notes/index.ts', 'src/features/notes/model.ts', 'src/features/workbench/registry.ts']);
    const findings = scanUiBoundaries([
      {
        file: 'src/features/chat/a.ts',
        text: [
          "import { b } from './b';",
          "import type { Note } from '@/features/notes/model';",
          "import { openNote } from '../notes/model';",
          "export * from '@/features/notes';",
          "const reg = () => import('../workbench/registry');",
        ].join('\n'),
      },
      { file: 'src/features/chat/__tests__/a.test.ts', text: "import { x } from '@/features/notes';" },
      { file: 'src/components/a.tsx', text: "import { x } from '@/features/notes';" },
    ], { known });
    expect(findings.map((f) => `${f.rule} ${f.file}:${f.line} ${f.target} [${f.scope}]`)).toEqual([
      'cross-feature-import src/features/chat/a.ts:2 src/features/notes/model.ts [src/features/notes]',
      'cross-feature-import src/features/chat/a.ts:4 src/features/notes/index.ts [src/features/notes]',
      'cross-feature-import src/features/chat/a.ts:5 src/features/workbench/registry.ts [src/features/workbench]',
    ]);
  });
});

describe('ui-boundaries gate: count baseline (ratchet)', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  function repo(files: Record<string, string>) {
    const root = mkdtempSync(path.join(tmpdir(), 'w09-ui-boundaries-'));
    roots.push(root);
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), t);
    }
    return root;
  }
  const cli = (root: string, ...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };

  it('baselined findings pass; an injected violation exits 1 with file:line; fixed ones are reported stale', () => {
    const root = repo({ 'src/a.ts': "new CustomEvent('a');\nnew CustomEvent('b');\n" });
    expect(cli(root, '--write-baseline').code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, BASELINE_FILE), 'utf8')).entries).toEqual([{ rule: 'bare-custom-event', file: 'src/a.ts', count: 2 }]);
    expect(cli(root, '--check').code).toBe(0);

    writeFileSync(path.join(root, 'src/a.ts'), "new CustomEvent('a');\nnew CustomEvent('b');\nconst ua = navigator.userAgent;\nnew CustomEvent('c');\n");
    const bad = cli(root, '--check');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('src/a.ts:3 [ua-sniffing]');
    expect(bad.out).toContain('src/a.ts:4 [bare-custom-event]');

    writeFileSync(path.join(root, 'src/a.ts'), "new CustomEvent('a');\n");
    const fixed = run({ root });
    expect(fixed.summary).toMatchObject({ fresh: 0, stale: 1 });
    expect(cli(root, '--check').code).toBe(0);
  });

  it('import rules are keyed by target: a new cross-feature dependency fails even when the file already has baselined ones', () => {
    const root = repo({
      'src/features/chat/a.ts': "import { n } from '@/features/notes/model';\n",
      'src/features/notes/model.ts': 'export const n = 1;\n',
      'src/features/workbench/registry.ts': 'export const r = 1;\n',
      'src/plugins/notes/plugin.ts': "import { n } from '@/features/notes/model';\n",
    });
    expect(cli(root, '--write-baseline').code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, BASELINE_FILE), 'utf8')).entries).toEqual([
      { rule: 'cross-feature-import', file: 'src/features/chat/a.ts', scope: 'src/features/notes', count: 1 },
      { rule: 'plugin-import-boundary', file: 'src/plugins/notes/plugin.ts', scope: 'src/features/notes', count: 1 },
    ]);
    expect(cli(root, '--check').code).toBe(0);

    writeFileSync(path.join(root, 'src/features/chat/a.ts'), "// swap\nimport { r } from '../workbench/registry';\n");
    const bad = cli(root, '--check');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('src/features/chat/a.ts:2 [cross-feature-import]');
    expect(bad.out).toContain('src/features/workbench/registry.ts');
    expect(run({ root }).summary).toMatchObject({ fresh: 1, stale: 1 });
  });

  it('baseline counts only go down: rewriting with more findings is refused unless --allow-increase', () => {
    const root = repo({ 'src/a.ts': "new CustomEvent('a');\n" });
    cli(root, '--write-baseline');
    writeFileSync(path.join(root, 'src/a.ts'), "new CustomEvent('a');\nnew CustomEvent('b');\n");
    const refused = cli(root, '--write-baseline');
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/bare-custom-event src\/a\.ts 1 → 2/);
    expect(JSON.parse(readFileSync(path.join(root, BASELINE_FILE), 'utf8')).entries[0].count).toBe(1);
    expect(cli(root, '--write-baseline', '--allow-increase').code).toBe(0);
    expect(baselineGrowth({ entries: [{ rule: 'ua-sniffing', file: 'x', count: 2 }] }, [{ rule: 'ua-sniffing', file: 'x', count: 1 }])).toEqual([]);
  });
});
