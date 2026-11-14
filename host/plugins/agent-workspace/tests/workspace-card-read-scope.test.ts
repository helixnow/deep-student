import { afterEach, expect, it } from 'vitest';
import {
  installWorkspaceCardReadScope, workspaceCardReadScope,
} from '../src/workspace/card-read-scope.ts';
import { createWorkspaceHost } from './host-support.ts';

const releases: Array<{ release(): void }> = [];
afterEach(() => {
  for (const guard of releases.splice(0)) guard.release();
});

it('installs_and_releases_worker_card_read_scope', () => {
  const guard = installWorkspaceCardReadScope('worker-1', 'ws-1', 'coordinator-1');
  releases.push(guard);
  expect(workspaceCardReadScope('worker-1')).toEqual({
    workspaceId: 'ws-1',
    coordinatorSessionId: 'coordinator-1',
  });
  guard.release();
  expect(workspaceCardReadScope('worker-1')).toBeNull();
});

it('release_is_idempotent_and_scoped_per_worker', () => {
  const first = installWorkspaceCardReadScope('worker-1', 'ws-1', 'coordinator-1');
  const second = installWorkspaceCardReadScope('worker-2', 'ws-1', 'coordinator-1');
  releases.push(first, second);
  first.release();
  first.release();
  expect(workspaceCardReadScope('worker-1')).toBeNull();
  expect(workspaceCardReadScope('worker-2')).not.toBeNull();
});

it('rejects_empty_ids_and_self_mapping', () => {
  expect(() => installWorkspaceCardReadScope('', 'ws-1', 'coordinator-1'))
    .toThrow('workspace card read scope requires non-empty ids');
  expect(() => installWorkspaceCardReadScope('worker-1', '  ', 'coordinator-1'))
    .toThrow('workspace card read scope requires non-empty ids');
  expect(() => installWorkspaceCardReadScope('same', 'ws-1', 'same'))
    .toThrow('workspace card read scope must map a worker to a distinct coordinator session');
});

it('unknown_session_returns_null', () => {
  expect(workspaceCardReadScope('missing')).toBeNull();
});

it('the plugin publishes the same scope table as the agentCardReadScope service', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const guard = installWorkspaceCardReadScope('worker-svc', 'ws-1', 'coordinator-1');
    releases.push(guard);
    expect(host.ctx.agentCardReadScope.lookup('worker-svc')).toEqual({ workspaceId: 'ws-1', coordinatorSessionId: 'coordinator-1' });
    guard.release();
    expect(host.ctx.agentCardReadScope.lookup('worker-svc')).toBeNull();
  } finally {
    storage.dispose();
    await host.dispose();
  }
});
