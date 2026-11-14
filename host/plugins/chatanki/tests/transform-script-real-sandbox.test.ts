// Rust chatanki_transform_script.rs:2044–2272. Real published L05/F7 providers;
// missing hard isolation or interpreters is a failure, never a skipped pass.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentWorkspace from '../../agent-workspace/index.ts';
import type { AnkiCard } from '../api.ts';
import {
  TransformScriptRunError, evaluateScriptOutput, normalizeScriptSpec, resolveInterpreter,
  runTransformScript, type ScriptCardPlan,
} from '../src/transform-script.ts';
import type { TransformFields } from '../src/transform.ts';
import { setTransformFs } from '../src/transform-script-fs.ts';
import { nodeTransformFs } from '../src/transform-script-fs.node.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

beforeAll(async () => {
  setTransformFs(nodeTransformFs);
  dir = mkdtempSync(join(tmpdir(), 'chatanki-real-sandbox-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: join(dir, 'local') });
  // 本文件只经 settings 读 mistakes；按 Rust `with_audit_db(None).migrate_single(Mistakes)`
  // 的单库公共入口迁移，避免为未使用的域付全量 runAll（3.7s→0.7s，10s hook 预算）。
  expect((await storage.migrations.migrateSingle('mistakes')).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, agentWorkspace],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
    },
  });
  expect(await host.ctx.agentTransformSandbox.capability()).toEqual({ available: true });
  expect(resolveInterpreter('python')).not.toBeNull();
  expect(resolveInterpreter('node')).not.toBeNull();
});

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function card(front = 'Q', back = 'A', tags: string[] = []): AnkiCard {
  return {
    id: 'card-1', front, back, tags, text: null, images: [], task_id: 'task-1',
    is_error_card: false, error_content: null, extra_fields: {}, template_id: 'design-swiss',
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
  };
}

function fields(plan: ScriptCardPlan | undefined): TransformFields {
  if (plan === undefined || !plan.ok) throw new Error(`expected successful card plan: ${JSON.stringify(plan)}`);
  return plan.fields;
}

async function withJob(run: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = mkdtempSync(join(dir, 'case-'));
  try { await run(tempRoot); }
  finally { rmSync(tempRoot, { recursive: true, force: true }); }
}

function run(tempRoot: string, cards: AnkiCard[], code: string, language = 'python', timeoutMs = 30_000) {
  return runTransformScript(host.ctx.agentTransformSandbox, {
    tempRoot, documentId: 'doc-1', cards, script: normalizeScriptSpec({ language, code, timeoutMs }),
  });
}

it('e2e_python_script_reads_input_and_writes_output_in_sandbox', async () => {
  await withJob(async (tempRoot) => {
    const cards = [card('术语 解释', '答案')];
    const result = await run(tempRoot, cards, `
import json, os
with open(os.environ["CHATANKI_INPUT"], encoding="utf-8") as fh:
    data = json.load(fh)
out = []
for card in data["cards"]:
    out.append({"id": card["id"], "front": card["front"].replace("术语", "TERM")})
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": out}, fh, ensure_ascii=False)
print("transformed", len(out))
`);
    expect(result.report.exitCode).toBe(0);
    expect(result.report.timedOut).toBe(false);
    expect(result.report.stdoutTail).toContain('transformed 1');
    expect(result.jobRef.startsWith('runtime-root://temp/')).toBe(true);
    expect(fields(evaluateScriptOutput(result.output, cards).cardPlans[0]).front).toBe('TERM 解释');
  });
});

it('e2e_network_is_always_denied_inside_the_sandbox', async () => {
  // Keep Rust's port-9 attempt, and also try a genuinely listening host socket:
  // a closed port alone could otherwise pass even without network isolation.
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
    await withJob(async (tempRoot) => {
      const cards = [card()];
      const result = await run(tempRoot, cards, `
import json, os, socket
denied = True
for port in [9, ${address.port}]:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            denied = False
    except OSError:
        pass
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": [{"id": "card-1", "front": "denied" if denied else "reachable"}]}, fh)
`);
      expect(fields(evaluateScriptOutput(result.output, cards).cardPlans[0]).front).toBe('denied');
      expect(connections).toBe(0);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it('e2e_host_files_outside_job_are_unreadable', async () => {
  await withJob(async (tempRoot) => {
    const secret = join(tempRoot, 'host-secret.txt');
    writeFileSync(secret, 'must-not-leak', 'utf8');
    const cards = [card()];
    const result = await run(tempRoot, cards, `
import json, os
try:
    with open(${JSON.stringify(secret)}, encoding="utf-8") as fh:
        result = "leaked:" + fh.read()
except OSError:
    result = "denied"
with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:
    json.dump({"cards": [{"id": "card-1", "front": result}]}, fh)
`);
    expect(fields(evaluateScriptOutput(result.output, cards).cardPlans[0]).front).toBe('denied');
  });
});

it('e2e_timeout_terminates_the_process_group_structurally', async () => {
  await withJob(async (tempRoot) => {
    let failure: unknown;
    try { await run(tempRoot, [card()], 'import time\ntime.sleep(600)', 'python', 1_000); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TransformScriptRunError);
    const timedOut = failure as TransformScriptRunError;
    expect(timedOut.kind).toBe('timed_out');
    expect(timedOut.report?.timedOut).toBe(true);
    expect(timedOut.report?.durationMs).toBeGreaterThanOrEqual(1_000);
  });
});

it('e2e_nonzero_exit_and_missing_output_are_structured_failures', async () => {
  await withJob(async (tempRoot) => {
    const failing = run(tempRoot, [card()], "import sys\nsys.stderr.write('boom')\nsys.exit(3)");
    await expect(failing).rejects.toBeInstanceOf(TransformScriptRunError);
    await expect(failing).rejects.toMatchObject({ kind: 'non_zero_exit', report: { exitCode: 3, stderrTail: expect.stringContaining('boom') } });
    const missing = run(tempRoot, [card()], "print('forgot to write output')");
    await expect(missing).rejects.toBeInstanceOf(TransformScriptRunError);
    await expect(missing).rejects.toMatchObject({ kind: 'output_missing' });
  });
});

it('e2e_node_script_honours_the_same_contract', async () => {
  await withJob(async (tempRoot) => {
    const cards = [card('Q', 'A', ['旧'])];
    const result = await run(tempRoot, cards, `
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.env.CHATANKI_INPUT, 'utf-8'));
const cards = data.cards.map((card) => ({ id: card.id, tags: [...card.tags, '新标签'] }));
fs.writeFileSync(process.env.CHATANKI_OUTPUT, JSON.stringify({ cards }));
`, 'node');
    expect(result.report.exitCode).toBe(0);
    expect(fields(evaluateScriptOutput(result.output, cards).cardPlans[0]).tags).toEqual(['旧', '新标签']);
  });
});

it('e2e_symlink_output_is_rejected_without_following', async () => {
  await withJob(async (tempRoot) => {
    let failure: unknown;
    try { await run(tempRoot, [card()], 'import os\nos.symlink("/etc/passwd", os.environ["CHATANKI_OUTPUT"])'); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TransformScriptRunError);
    const rejected = failure as TransformScriptRunError;
    expect(rejected.kind).toBe('setup');
    expect(rejected.detail).toContain('must be a regular file');
    expect(rejected.detail).not.toContain('root:');
  });
});
