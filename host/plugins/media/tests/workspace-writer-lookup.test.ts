/**
 * Office `output_target=workspace` reaches agent-workspace's
 * `workspace_change_set::write_bytes` through the `agentWorkspace` service when it
 * publishes `writeBytes`; otherwise office delivery keeps its explicit error.
 */
import { expect, it } from 'vitest';
import { workspaceWriterFrom } from '../src/register-tools.ts';

it('uses the agentWorkspace writeBytes method, bound to the service', () => {
  const calls: unknown[][] = [];
  const service = {
    marker: 'svc',
    writeBytes(this: { marker: string }, ...args: unknown[]) {
      calls.push([this.marker, ...args]);
      return { change_id: 'c1' };
    },
  };
  const writer = workspaceWriterFrom(service)!;
  expect(writer.writeBytes('/root', '/ckpt', 'workspace', 'a.docx', Buffer.from('x'), null))
    .toEqual({ change_id: 'c1' });
  expect(calls).toEqual([['svc', '/root', '/ckpt', 'workspace', 'a.docx', Buffer.from('x'), null]]);
});

it('returns null when the service is missing or does not publish writeBytes', () => {
  expect(workspaceWriterFrom(undefined)).toBeNull();
  expect(workspaceWriterFrom({ checkpoint: () => undefined })).toBeNull();
});
