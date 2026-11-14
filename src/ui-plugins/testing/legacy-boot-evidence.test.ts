// @vitest-environment node
/** Read-only provenance check. Neither current entrypoints nor current boot harness are executed. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const LEGACY = 'e303957124ac220f55bee1b04cca5d3937983b92';
const FIRST_EVIDENCE = '7f915ae5f1799ee9de9c7f40a7386d785eba7475';
const CORRECTION_CHECKPOINT = 'e354acaa66c1b04c64a944765c99844ca5115d49';
const GOLDEN = 'src/ui-plugins/testing/__golden__/boot';
const nativeRequire = createRequire(import.meta.url);
const gitFile = (revision: string, file: string) => execFileSync('git', ['show', `${revision}:${file}`], { encoding: 'utf8' });

/**
 * Deliberate source changes that reached the frozen boot JSON after the correction checkpoint. Each rewrites
 * one exact row of the fixed OLD output; anything else that differs still fails, and an entry that no scene
 * uses fails too. Add an entry only together with the baseline commit it names.
 */
const LATER_CHANGES: { commit: string; why: string; from: unknown[]; to: unknown[] }[] = [
  {
    commit: 'd9fc4f33',
    why: 'W19 FE-B7: src/main.tsx imports dstuDebugLog from the debug-panel channel instead of the DstuDebugPlugin module',
    from: ['import', './debug-panel/plugins/DstuDebugPlugin', false],
    to: ['import', './debug-panel/channels/dstu', false],
  },
];

function withLaterChanges(output: { demo: boolean; trace: unknown[][] }, used: Set<string>) {
  return {
    ...output,
    trace: output.trace.map((row) => {
      const change = LATER_CHANGES.find((entry) => JSON.stringify(entry.from) === JSON.stringify(row));
      if (!change) return row;
      used.add(change.commit);
      return change.to;
    }),
  };
}

function legacyCases(): Record<string, { entry: 'main' | 'demo' | 'demo-app' }> {
  const file = ts.createSourceFile('original-test.ts', gitFile(FIRST_EVIDENCE, 'src/ui-plugins/testing/boot-golden.test.ts'), ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'bootCases') initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!initializer) throw new Error('Original bootCases initializer not found');
  return vm.runInNewContext(`(${initializer.getText(file)})`);
}

function legacyRecorder(correctThenable: boolean) {
  // Start with the FIRST evidence harness, not the later mixed checkpoint or current harness.
  let harness = gitFile(FIRST_EVIDENCE, 'src/ui-plugins/testing/boot-entry-harness.ts');
  const broken = "key === '__esModule' ? true : named";
  expect(harness.split(broken)).toHaveLength(2);
  if (correctThenable) harness = harness.replace(broken, `key === 'then' ? undefined : ${broken}`);
  const entries = new Set(['src/main.tsx', 'src/demo/main.tsx', 'src/demo/app/main.tsx']);
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(harness, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  vm.runInNewContext(code, {
    exports, setImmediate, URLSearchParams,
    require(id: string) {
      let dependency: any;
      if (id === 'node:fs') {
        dependency = {
          readFileSync(absolute: string) {
            const relative = path.relative(process.cwd(), absolute);
            if (!entries.has(relative)) throw new Error(`Legacy recorder attempted a non-entry read: ${relative}`);
            return gitFile(LEGACY, relative);
          },
        };
      } else {
        if (!['node:path', 'node:vm', 'typescript'].includes(id)) throw new Error(`Unexpected legacy dependency: ${id}`);
        dependency = nativeRequire(id);
      }
      return { ...dependency, default: dependency };
    },
  });
  return exports.observeBoot as (input: unknown) => Promise<{ demo: boolean; trace: unknown[][] }>;
}

it('reproduces each corrected golden solely from fixed pre-refactor sources and identifies every original omission', async () => {
  const originalRecorder = legacyRecorder(false);
  const correctedRecorder = legacyRecorder(true);
  const changed: string[] = [];
  const inserted: Record<string, unknown[][]> = {};
  const usedLaterChanges = new Set<string>();

  for (const [name, input] of Object.entries(legacyCases())) {
    const file = `${GOLDEN}/${name}.json`;
    const initial = JSON.parse(gitFile(FIRST_EVIDENCE, file));
    const checkpoint = JSON.parse(gitFile(CORRECTION_CHECKPOINT, file));
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(await originalRecorder(input), `${name}: reproduce the ORIGINAL recorder defect`).toEqual(initial);
    const legacyActual = await correctedRecorder(input);
    expect(legacyActual, `${name}: fixed OLD source versus correction checkpoint`).toEqual(checkpoint);
    expect(withLaterChanges(legacyActual, usedLaterChanges), `${name}: fixed OLD source plus LATER_CHANGES versus current frozen JSON`).toEqual(current);
    expect(legacyActual.demo).toBe(initial.demo);

    // Correction only inserts previously unobserved steps: no old step is deleted or rewritten.
    const additions: unknown[][] = [];
    let before = 0;
    for (const row of legacyActual.trace) {
      if (JSON.stringify(row) === JSON.stringify(initial.trace[before])) before++;
      else additions.push(row);
    }
    expect(before, `${name}: all original rows preserved in the same order`).toBe(initial.trace.length);
    if (additions.length) {
      changed.push(name);
      inserted[name] = additions;
    }
  }

  expect([...usedLaterChanges].sort(), 'every LATER_CHANGES entry rewrites at least one scene').toEqual(LATER_CHANGES.map((entry) => entry.commit).sort());
  expect(changed.sort()).toEqual(['assistant', 'demo', 'demo-app', 'demo-desktop-dark', 'pomodoro']);
  expect(Object.fromEntries(Object.entries(inserted).map(([name, rows]) => [name, rows.map((row) => row[0])]))).toEqual({
    assistant: ['render'],
    pomodoro: ['render'],
    demo: ['import', 'render', 'autoplay', 'navigate'],
    'demo-desktop-dark': ['import', 'desktop.prepare', 'import', 'render', 'desktop.arrange', 'autoplay', 'navigate'],
    'demo-app': ['render'],
  });
}, 30000);
