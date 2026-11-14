import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolResultInfo } from '../../chat/api.ts';
import { artifactRoot } from '../../agent-workspace/api.ts';
import { TaskAuditExecutor } from '../src/task-audit-executor.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { createNodeCrypto } from '../../../platform/crypto/index.ts';
import { setAgentOrchestrationWorkspaceRuntime } from '../src/workspace-runtime.ts';
import { nodeAgentOrchestrationWorkspaceRuntime } from '../src/workspace-runtime.node.ts';

const dirs: string[] = [];
beforeEach(() => setAgentOrchestrationWorkspaceRuntime(nodeAgentOrchestrationWorkspaceRuntime));
afterEach(() => {
  setAgentOrchestrationWorkspaceRuntime(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function context(options: { window?: boolean; mainDb?: boolean; files?: boolean } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w02-task-audit-')));
  dirs.push(dataDir);
  const platform: Record<string, unknown> = { crypto: createNodeCrypto() };
  if (options.files !== false) platform.files = createNodeFiles({ roots: [{ name: 'appData', path: dataDir }] });
  const saved: ToolResultInfo[] = [];
  const errors: string[] = [];
  const ctx = {
    session_id: 'sess_audit', message_id: 'msg_audit', block_id: 'blk_audit', tool_call_id: null,
    tauri_window: options.window === false ? null : { window: 'main', webview: 'main' },
    main_db: options.mainDb === false ? null : {},
    services: { app: { dataDir }, settings: { get: () => null, getSecret: async () => null }, get: (name: string) => platform[name],
      logger: { error() {}, warn() {} } },
    emitToolCallStart() {}, emitToolCallEnd() {}, emitToolCallError: (error: string) => { errors.push(error); },
    saveToolBlock: (result: ToolResultInfo) => { saved.push(result); },
  };
  return { ctx: ctx as never, dataDir, saved, errors };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function handle(id: string, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 2, handleId: id, kind: 'file', displayName: `${id}.txt`,
    capabilities: { readable: true, materializable: false, writable: false, shareable: false, sendable: false, deletable: true },
    provenance: { source: 'tool', observedAt: '2026-11-07T00:00:00Z' }, ...extra };
}
function artifactFile(dataDir: string, relative: string, content: string) {
  const root = artifactRoot(dataDir, 'sess_audit', true);
  fs.mkdirSync(path.dirname(path.join(root.path, relative)), { recursive: true });
  fs.writeFileSync(path.join(root.path, relative), content);
  return path.join(root.path, relative);
}

const executor = new TaskAuditExecutor(() => {});

describe('task_audit_executor.rs task_audit_export', () => {
  it('fails with serde argument errors before touching disk', async () => {
    const { ctx } = context();
    const missing = await executor.execute({ id: 'a1', name: 'builtin-task_audit_export', arguments: {} }, ctx);
    expect(missing).toMatchObject({ success: false, error: 'invalid arguments: missing field `taskId`' });
    const unknown = await executor.execute({ id: 'a2', name: 'task_audit_export', arguments: { taskId: 't', taskID: 1 } }, ctx);
    expect(unknown.error).toBe('invalid arguments: unknown field `taskID`, expected one of `taskId`, `objectHandles`, '
      + '`toolCalls`, `approvals`, `outputs`, `connectorTargets`, `rolePackVersion`, `changeCoverage`');
    const badHandle = await executor.execute({ id: 'a3', name: 'task_audit_export',
      arguments: { taskId: 't', objectHandles: [handle('h', { sha256: 'abc' })] } }, ctx);
    expect(badHandle.error).toBe('sha256 must be a 64-character hexadecimal digest');
  });

  it('dedups by id in byte order, keeps Rust field order, redacts secrets and persists the manifest', async () => {
    const { ctx, dataDir } = context();
    const result = await executor.execute({ id: 'a4', name: 'builtin-task_audit_export', arguments: {
      taskId: 'task/1 ü',
      objectHandles: [handle('b', { mediaType: null, unknownExtra: true }), handle('a', { acl: { access: 'private' } })],
      toolCalls: [{ callId: 'z', toolName: 'x', arguments: { apiKey: 'sk-1' } }, { callId: 'Z', toolName: 'first', arguments: {} },
        { callId: 'Z', toolName: 'second', arguments: {}, resultHash: null }],
      connectorTargets: [{ operationId: 'op', recipients: [] }],
      rolePackVersion: 'pack@1',
      changeCoverage: { changesRecorded: true, rollbackAvailable: false, rollbackVerified: false },
    } }, ctx);
    expect(result.success).toBe(true);
    const output = result.output as Record<string, any>;
    expect(Object.keys(output)).toEqual(['schemaVersion', 'taskId', 'evidenceOrigin', 'authoritative', 'objectHandles',
      'toolCalls', 'approvals', 'outputs', 'connectorTargets', 'rolePackVersion', 'changeCoverage', 'coverageComplete',
      'missingCoverage', 'persistedTo']);
    expect(output.objectHandles.map((item: { handleId: string }) => item.handleId)).toEqual(['a', 'b']);
    expect(Object.keys(output.objectHandles[0])).toEqual(['schemaVersion', 'handleId', 'kind', 'displayName', 'acl', 'capabilities', 'provenance']);
    expect(output.toolCalls).toEqual([{ callId: 'Z', toolName: 'second', arguments: {} },
      { callId: 'z', toolName: 'x', arguments: { apiKey: '[REDACTED]' } }]);
    expect(output.connectorTargets).toEqual([{ operationId: 'op' }]);
    expect(output.missingCoverage).toEqual(['backend_session_ledger']);
    expect(output.persistedTo.rootId).toBe('artifacts');
    expect(output.persistedTo.relativePath).toMatch(/^task-audit\/task_1__-\d+\.json$/);
    const file = path.join(artifactRoot(dataDir, 'sess_audit', false).path, output.persistedTo.relativePath);
    const { persistedTo: _persisted, ...persisted } = output;
    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(persisted, null, 2));
  });

  it('is fail-closed when the manifest cannot be persisted', async () => {
    const { ctx } = context({ window: false });
    const result = await executor.execute({ id: 'a5', name: 'task_audit_export', arguments: { taskId: 't' } }, ctx);
    expect(result).toMatchObject({ success: false, output: null,
      error: 'audit manifest persistence failed: Tauri window unavailable; cannot persist audit manifest' });
  });
});

describe('task_audit_executor.rs lineage_forget', () => {
  it('dry-runs then irreversibly deletes hash-bound session files and reports uncovered layers', async () => {
    const { ctx, dataDir } = context();
    const file = artifactFile(dataDir, 'out/a.txt', 'alpha');
    const target = (layer: string, id: string, hash = sha('alpha')) => ({ layer, objectHandle: handle(id,
      { sha256: hash.toUpperCase(), locator: { rootId: 'artifacts', relativePath: 'out/a.txt' } }) });
    const args = { targets: [target(' Copy ', 'h1'), target('cache', 'h2', sha('other')), target('stage', 'h3')],
      requestedLayers: ['copy', 'cache', 'embedding'] };
    const dry = await executor.execute({ id: 'f1', name: 'builtin-lineage_forget', arguments: { mode: 'dry_run', ...args } }, ctx);
    expect(dry.output).toEqual({ mode: 'dry_run', coverageComplete: false, complete: false, incompleteLayers: ['cache', 'embedding'],
      items: [
        { layer: 'cache', objectHandleId: 'h2', status: 'incomplete',
          error: `managed target hash changed (expected ${sha('other').toUpperCase()}, observed ${sha('alpha')})` },
        { layer: 'copy', objectHandleId: 'h1', rootId: 'artifacts', relativePath: 'out/a.txt', sha256: sha('alpha'), status: 'would_delete' },
        { layer: 'embedding', status: 'incomplete', error: 'no deletion target was supplied for this requested layer' },
        { layer: 'stage', objectHandleId: 'h3', status: 'incomplete', error: 'target layer was not included in requestedLayers' },
      ] });
    expect(fs.existsSync(file)).toBe(true);
    const commit = await executor.execute({ id: 'f2', name: 'lineage_forget', arguments: { mode: 'commit',
      targets: [target('copy', 'h1')], requestedLayers: ['copy'] } }, ctx);
    expect(commit.output).toEqual({ mode: 'commit', coverageComplete: true, complete: true, incompleteLayers: [], items: [
      { layer: 'copy', objectHandleId: 'h1', status: 'deleted', deleteReceipt: { rootId: 'artifacts', relativePath: 'out/a.txt',
        sha256: sha('alpha'), irreversible: true, backupCreated: false } }] });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses non-session roots, missing hashes and unknown layers with the Rust messages', async () => {
    const { ctx, dataDir } = context();
    artifactFile(dataDir, 'b.txt', 'beta');
    const run = (targets: unknown[], requestedLayers = ['copy']) => executor.execute({ id: 'f3', name: 'lineage_forget',
      arguments: { mode: 'commit', targets, requestedLayers } }, ctx);
    const noHash = await run([{ layer: 'copy', objectHandle: handle('h', { locator: { rootId: 'artifacts', relativePath: 'b.txt' } }) }]);
    expect((noHash.output as any).items[0].error).toBe('object handle requires sha256 for hash-bound deletion');
    const workspace = await run([{ layer: 'copy', objectHandle: handle('h', { sha256: sha('beta'),
      locator: { rootId: 'workspace', relativePath: 'b.txt' } }) }]);
    expect((workspace.output as any).items[0].status).toBe('incomplete');
    expect((await run([], ['blob'])).error).toBe(
      'unsupported lineage layer \'blob\'; expected one of source, cache, embedding, stage, copy, lineage');
    expect((await run([], [])).error).toBe('requestedLayers must contain at least one lineage layer');
    const badMode = await executor.execute({ id: 'f4', name: 'lineage_forget', arguments: { mode: 'delete', targets: [], requestedLayers: [] } }, ctx);
    expect(badMode.error).toBe('invalid arguments: unknown variant `delete`, expected `dry_run` or `commit`');
    expect([executor.sensitivityLevel('builtin-lineage_forget'), executor.sensitivityLevel('task_audit_export')]).toEqual(['high', 'medium']);
    expect([executor.concurrencyClass('task_audit_export'), executor.concurrencyClass('lineage_forget')]).toEqual(['read_only', 'serial']);
  });

  it('refuses symlinked components and symlinked targets without following them', async () => {
    const { ctx, dataDir } = context();
    const real = artifactFile(dataDir, 'real/c.txt', 'gamma');
    const root = artifactRoot(dataDir, 'sess_audit', false).path;
    fs.symlinkSync(path.dirname(real), path.join(root, 'linked'));
    fs.symlinkSync(real, path.join(root, 'c-link.txt'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'w02-task-audit-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'o.txt'), 'gamma');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const run = (relativePath: string) => executor.execute({ id: 'f5', name: 'lineage_forget', arguments: { mode: 'commit',
      targets: [{ layer: 'copy', objectHandle: handle('h', { sha256: sha('gamma'), locator: { rootId: 'artifacts', relativePath } }) }],
      requestedLayers: ['copy'] } }, ctx);
    for (const relativePath of ['linked/c.txt', 'c-link.txt', 'escape/o.txt']) {
      expect((await run(relativePath)).output).toMatchObject({ complete: false,
        items: [{ status: 'incomplete', error: 'managed target must not traverse symbolic links' }] });
    }
    expect(fs.existsSync(real)).toBe(true);
    expect(fs.existsSync(path.join(outside, 'o.txt'))).toBe(true);
    expect((await run('real')).output).toMatchObject({ items: [{ status: 'incomplete', error: 'managed target must be a regular file' }] });
  });

  it('reports every target incomplete and persists nothing without the file service', async () => {
    const { ctx, dataDir } = context({ files: false });
    const file = artifactFile(dataDir, 'd.txt', 'delta');
    const forget = await executor.execute({ id: 'f6', name: 'lineage_forget', arguments: { mode: 'commit',
      targets: [{ layer: 'copy', objectHandle: handle('h', { sha256: sha('delta'), locator: { rootId: 'artifacts', relativePath: 'd.txt' } }) }],
      requestedLayers: ['copy'] } }, ctx);
    expect(forget.output).toMatchObject({ complete: false, items: [{ status: 'incomplete', error: 'file service unavailable' }] });
    expect(fs.existsSync(file)).toBe(true);
    const exported = await executor.execute({ id: 'a6', name: 'task_audit_export', arguments: { taskId: 't' } }, ctx);
    expect(exported.error).toBe('audit manifest persistence failed: file service unavailable');
  });
});
