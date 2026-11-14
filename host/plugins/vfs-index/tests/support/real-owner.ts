import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { createTestHost, type TestHost } from '../../../../kernel/testing.ts';
import { createStorageService } from '../../../../platform/storage/service.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
// boundary-allow cross-plugin-impl: install the real L11 provider to exercise its published repository API
import reposPlugin from '../../../vfs-repos/index.ts';
import type { VfsReposService } from '../../../vfs-repos/api.ts';
import { bindVfsTableOwners } from '../../repository/owners.ts';
import { pathsServiceDouble } from './paths-service.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-owner-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  host = await createTestHost({ plugins: [reposPlugin], provide: { storage, paths: pathsServiceDouble() } });
});

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

/** L11 repositories take the caller's connection; no copied SQL or stand-in owner. */
export function bindRealOwner(db: SqlExecutor): VfsReposService {
  const owner = realOwner();
  bindVfsTableOwners(db, owner);
  return owner;
}

export function realOwner(): VfsReposService {
  return host.ctx.vfsRepo;
}
