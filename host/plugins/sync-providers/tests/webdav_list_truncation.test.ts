import { afterAll, describe, expect, it } from 'vitest';
import { WebDavStorage } from '../src/webdav.ts';
import { countMethod, multistatusXml, spawnFakeDav, type FakeDav } from './fake_dav.ts';

const ROOT = 'sync-root';
const servers: FakeDav[] = [];

afterAll(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function storageFor(endpoint: string): WebDavStorage {
  return new WebDavStorage(
    { endpoint, username: 'student', password: 'correct-horse' },
    ROOT,
    { rateLimitEnv: '0' },
  );
}

async function listOutcomeForFileCount(fileCount: number): Promise<{
  files: number;
  truncated: boolean;
  propfinds: number;
}> {
  const server = await spawnFakeDav(method => (method === 'PROPFIND'
    ? { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body: multistatusXml(`/${ROOT}/`, fileCount) }
    : { status: 404 }));
  servers.push(server);
  const outcome = await storageFor(server.endpoint).listOutcome('');
  expect(countMethod(server.log, 'PROPFIND')).toBeGreaterThanOrEqual(1);
  return { files: outcome.files.length, truncated: outcome.truncated, propfinds: countMethod(server.log, 'PROPFIND') };
}

describe('webdav_list_truncation_tests.rs', () => {
  it('list_with_750_files_is_marked_truncated', async () => {
    const outcome = await listOutcomeForFileCount(750);
    expect(outcome.files).toBe(750);
    expect(outcome.truncated).toBe(true);
  });

  it('list_with_101_files_is_not_truncated', async () => {
    const outcome = await listOutcomeForFileCount(101);
    expect(outcome.files).toBe(101);
    expect(outcome.truncated).toBe(false);
  });

  it('list_with_exactly_100_files_should_not_be_truncated', async () => {
    const outcome = await listOutcomeForFileCount(100);
    expect(outcome.files).toBe(100);
    expect(outcome.truncated).toBe(false);
  });

  it('list_with_small_directory_is_not_truncated', async () => {
    const outcome = await listOutcomeForFileCount(7);
    expect(outcome.files).toBe(7);
    expect(outcome.truncated).toBe(false);
  });

  it('list_with_1000_files_is_marked_truncated', async () => {
    const outcome = await listOutcomeForFileCount(1000);
    expect(outcome.files).toBe(1000);
    expect(outcome.truncated).toBe(true);
  });

  it('list_with_999_files_is_marked_truncated', async () => {
    const outcome = await listOutcomeForFileCount(999);
    expect(outcome.files).toBe(999);
    expect(outcome.truncated).toBe(true);
  });

  it('list_with_1001_files_is_not_truncated', async () => {
    const outcome = await listOutcomeForFileCount(1001);
    expect(outcome.files).toBe(1001);
    expect(outcome.truncated).toBe(false);
  });

  it('list_with_2000_files_is_not_truncated', async () => {
    const outcome = await listOutcomeForFileCount(2000);
    expect(outcome.files).toBe(2000);
    expect(outcome.truncated).toBe(false);
  });
});
