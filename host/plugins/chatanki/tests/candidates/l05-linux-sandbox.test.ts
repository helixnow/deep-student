/**
 * Candidate-only integration test: L24 `runTransformScript` + the L05 async
 * `agentTransformSandbox` adapter + F7 `nativeSandbox`.
 *
 * The L05 adapter is on main; the F7 `nativeSandbox` files are not, so this
 * suite skips there. Assemble a temp worktree exactly as described in
 * `tests/candidates/README.md` to run the seven Rust hard-sandbox e2e
 * scenarios through the real Linux bwrap path.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AnkiCard, TransformSandboxBackend } from '../../api.ts';
import {
  TransformScriptRunError, evaluateScriptOutput, normalizeScriptSpec, resolveInterpreter,
  runTransformScript, type NormalizedTransformScript, type ScriptCardPlan,
} from '../../src/transform-script.ts';
import type { TransformFields } from '../../src/transform.ts';

const root = process.cwd();
const adapterPath = join(root, 'host/plugins/agent-workspace/src/tools/transform-sandbox.ts');
const nativePath = join(root, 'host/platform/native/sandbox/index.ts');
const available = process.platform === 'linux'
  && existsSync(adapterPath)
  && existsSync(nativePath);

function makeCard(
  id: string, front: string, back: string, text: string | null, tags: string[],
): AnkiCard {
  return {
    front, back, text, tags, images: [], id, task_id: 'task-1', is_error_card: false,
    error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: 'design-swiss',
  };
}

function planOk(plan: ScriptCardPlan | undefined): TransformFields {
  if (!plan || !plan.ok) throw new Error(`expected an ok plan, got ${JSON.stringify(plan)}`);
  return plan.fields;
}

const spec = (raw: unknown): NormalizedTransformScript => normalizeScriptSpec(raw);

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'l24-real-sandbox-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!available)('L24 real Linux sandbox e2e (candidate providers)', () => {
  let backend: TransformSandboxBackend;

  beforeAll(async () => {
    // boundary-allow cross-plugin-impl: 候选 worktree 需直接组装 L05 公开工厂与 F7 sandbox
    const l05 = await import('../../../agent-workspace/src/tools/transform-sandbox.ts');
    // @ts-ignore candidate-only module outside main
    const f7 = await import('../../../../platform/native/sandbox/index.ts');
    backend = l05.createTransformSandboxBackend(() => f7.sandbox) as TransformSandboxBackend;
  });

  it('capability and contract come from the real L05 + F7 candidates', async () => {
    expect(await backend.capability()).toEqual({ available: true });
    expect(backend.contract()).toEqual({
      backend: 'linux_bwrap', shellKind: 'posix_sh', outputEncoding: 'utf-8',
    });
  });

  it('python script reads input and writes output in sandbox', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDir(async (dir) => {
      const cards = [makeCard('card-1', '术语 解释', '答案', null, [])];
      const script = spec({
        language: 'python',
        code: `
import json, os
with open(os.environ["CHATANKI_INPUT"], encoding="utf-8") as fh:
    data = json.load(fh)
out = []
for card in data["cards"]:
    out.append({"id": card["id"], "front": card["front"].replace("术语", "TERM")})
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": out}, fh, ensure_ascii=False)
print("transformed", len(out))
`,
        timeoutMs: 30_000,
      });
      const result = await runTransformScript(backend, {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      });
      expect(result.report.exitCode).toBe(0);
      expect(result.report.timedOut).toBe(false);
      expect(result.report.stdoutTail).toContain('transformed 1');
      expect(result.report.sandboxBackend).toBe('linux_bwrap');
      expect(result.jobRef.startsWith('runtime-root://temp/')).toBe(true);
      expect(planOk(evaluateScriptOutput(result.output, cards).cardPlans[0]).front).toBe('TERM 解释');
    });
  });

  it('network is always denied inside the sandbox', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDir(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script = spec({
        language: 'python',
        code: `
import json, os, socket
denied = False
try:
    socket.create_connection(("127.0.0.1", 9), timeout=1)
except OSError:
    denied = True
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": [{"id": "card-1", "front": "denied" if denied else "reachable"}]}, fh)
`,
        timeoutMs: 30_000,
      });
      const result = await runTransformScript(backend, {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      });
      expect(planOk(evaluateScriptOutput(result.output, cards).cardPlans[0]).front).toBe('denied');
    });
  });

  it('host files outside the job directory are unreadable', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDir(async (dir) => {
      const secret = join(dir, 'host-secret.txt');
      writeFileSync(secret, 'must-not-leak', 'utf8');
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script = spec({
        language: 'python',
        code: `
import json, os
try:
    with open(${JSON.stringify(secret)}, encoding="utf-8") as fh:
        result = "leaked:" + fh.read()
except OSError:
    result = "denied"
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": [{"id": "card-1", "front": result}]}, fh)
`,
        timeoutMs: 30_000,
      });
      const result = await runTransformScript(backend, {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      });
      expect(planOk(evaluateScriptOutput(result.output, cards).cardPlans[0]).front).toBe('denied');
    });
  });

  it('timeout terminates the process group structurally', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDir(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script = spec({
        language: 'python', code: 'import time\ntime.sleep(600)', timeoutMs: 1_000,
      });
      let failure: unknown;
      try {
        await runTransformScript(backend, { tempRoot: dir, documentId: 'doc-1', cards, script });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(TransformScriptRunError);
      const timedOut = failure as TransformScriptRunError;
      expect(timedOut.kind).toBe('timed_out');
      expect(timedOut.report?.timedOut).toBe(true);
      expect(timedOut.report?.durationMs).toBeGreaterThanOrEqual(1_000);
    });
  });

  it('nonzero exit and missing output are structured failures', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDir(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const failing = spec({
        language: 'python', code: "import sys\nsys.stderr.write('boom')\nsys.exit(3)", timeoutMs: 30_000,
      });
      let nonzero: unknown;
      try {
        await runTransformScript(backend, { tempRoot: dir, documentId: 'doc-1', cards, script: failing });
      } catch (error) {
        nonzero = error;
      }
      expect(nonzero).toBeInstanceOf(TransformScriptRunError);
      expect((nonzero as TransformScriptRunError).kind).toBe('non_zero_exit');
      expect((nonzero as TransformScriptRunError).report?.exitCode).toBe(3);
      expect((nonzero as TransformScriptRunError).report?.stderrTail).toContain('boom');

      const silent = spec({
        language: 'python', code: "print('forgot to write output')", timeoutMs: 30_000,
      });
      let missing: unknown;
      try {
        await runTransformScript(backend, { tempRoot: dir, documentId: 'doc-1', cards, script: silent });
      } catch (error) {
        missing = error;
      }
      expect(missing).toBeInstanceOf(TransformScriptRunError);
      expect((missing as TransformScriptRunError).kind).toBe('output_missing');
    });
  });

  it('node script honours the same contract', async () => {
    if (resolveInterpreter('node') === null) return;
    await withTempDir(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, ['旧'])];
      const script = spec({
        language: 'node',
        code: `
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.env.CHATANKI_INPUT, 'utf-8'));
const cards = data.cards.map((card) => ({ id: card.id, tags: [...card.tags, '新标签'] }));
fs.writeFileSync(process.env.CHATANKI_OUTPUT, JSON.stringify({ cards }));
`,
        timeoutMs: 30_000,
      });
      const result = await runTransformScript(backend, {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      });
      expect(result.report.exitCode).toBe(0);
      expect(planOk(evaluateScriptOutput(result.output, cards).cardPlans[0]).tags)
        .toEqual(['旧', '新标签']);
    });
  });

  it('symlink output is rejected without following the target', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDir(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script = spec({
        language: 'python',
        code: 'import os\nos.symlink("/etc/passwd", os.environ["CHATANKI_OUTPUT"])',
        timeoutMs: 30_000,
      });
      let failure: unknown;
      try {
        await runTransformScript(backend, { tempRoot: dir, documentId: 'doc-1', cards, script });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(TransformScriptRunError);
      const rejected = failure as TransformScriptRunError;
      expect(rejected.kind).toBe('setup');
      expect(rejected.detail).toContain('must be a regular file');
      expect(rejected.detail).not.toContain('root:');
    });
  });
});
