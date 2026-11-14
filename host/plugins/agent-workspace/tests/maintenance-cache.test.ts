import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { StorageError, type SqlExecutor, type Query, type SqlParams } from '../../../platform/storage/api.ts';
import { WorkspaceCoordinator } from '../src/workspace/coordinator.ts';

it('closes getWorkspace-only cached handles and prevents new opens during maintenance', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workspace-maintenance-'));
  const open = new Set<Connection>();
  const io = {
    open(file: string) {
      const conn = new Connection(file, { label: 'workspace', profile: PROFILES.workspace });
      open.add(conn);
      return Object.assign(conn, {
        one<R>(query: Query<any, any> | string, params?: SqlParams): R {
          const row = conn.get<R>(query, params);
          if (row === undefined) throw new StorageError('NO_ROWS', 'Query returned no rows');
          return row;
        },
      }) as SqlExecutor;
    },
    close(executor: SqlExecutor) {
      const conn = executor as unknown as Connection;
      conn.close();
      open.delete(conn);
    },
  };
  const coordinator = new WorkspaceCoordinator({ workspacesDir: dir, io });
  try {
    const workspace = coordinator.createWorkspace('creator', 'cached');
    coordinator.dispose();
    expect(coordinator.getWorkspace(workspace.id)?.id).toBe(workspace.id);
    expect(coordinator.loadedWorkspaceIds()).toEqual([]);
    expect(open.size).toBe(1);
    await coordinator.enterMaintenanceMode();
    expect(open.size).toBe(0);
    expect(coordinator.isInMaintenanceMode()).toBe(true);
    expect(coordinator.getWorkspace('another')).toBeNull();
    expect(() => coordinator.createWorkspace('creator', 'blocked')).toThrow('maintenance');
    expect(open.size).toBe(0);
    coordinator.exitMaintenanceMode();
    expect(coordinator.isInMaintenanceMode()).toBe(false);
    expect(coordinator.getWorkspace(workspace.id)?.id).toBe(workspace.id);
    expect(open.size).toBe(1);
  } finally {
    coordinator.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
