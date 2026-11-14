/**
 * Real assembly: the profile installs agent-workspace and media; media's Office `output_target=workspace`
 * duck-types `writeBytes` on the published `agentWorkspace` service, which must be the
 * `workspace_change_set::write_bytes` owner implementation.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createPipelineHost } from './chat-host.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it('agentWorkspace publishes writeBytes to media: create, then hash-bound overwrite with a checkpoint', async () => {
  const host = await createPipelineHost({ vfs: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'office-ws-writer-')));
  try {
    expect(host.ctx.get('media')).toBeDefined();
    const writer = host.ctx.get('agentWorkspace');
    expect(typeof writer?.writeBytes).toBe('function');
    const root = path.join(base, 'workspace');
    const checkpoint = path.join(base, 'checkpoints');
    fs.mkdirSync(root);
    const first = Buffer.from('docx-v1');
    const created = writer!.writeBytes(root, checkpoint, 'workspace', 'out/a.docx', first, null);
    expect(created).toMatchObject({ root_id: 'workspace', op: 'created', relative_path: 'out/a.docx',
      after_hash: sha(first), bytes: first.length });
    expect(created.before_hash).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'out', 'a.docx'), 'utf8')).toBe('docx-v1');

    const second = Buffer.from('docx-version-2');
    expect(() => writer!.writeBytes(root, checkpoint, 'workspace', 'out/a.docx', second, null))
      .toThrow('expected_current_hash is required when overwriting an existing workspace file');
    const modified = writer!.writeBytes(root, checkpoint, 'workspace', 'out/a.docx', second, sha(first));
    expect(modified).toMatchObject({ op: 'modified', before_hash: sha(first), after_hash: sha(second), bytes: second.length });
    expect(typeof modified.backup_ref).toBe('string');
    expect(modified.change_id).not.toBe(created.change_id);
    expect(fs.readFileSync(path.join(root, 'out', 'a.docx'), 'utf8')).toBe('docx-version-2');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    await host.dispose();
  }
});
