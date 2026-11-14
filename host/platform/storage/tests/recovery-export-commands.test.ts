import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import shell from '../../../../electron/index.ts';
import secrets from '../../secrets/index.ts';
import storage from '../index.ts';

let base: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;

beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-recovery-commands-')); });
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  fs.rmSync(base, { recursive: true, force: true });
});

async function start() {
  host = await createTestHost({
    app: { dataDir: base },
    plugins: [shell, secrets, [storage, { dataLocalDir: base }]],
    provide: {
      paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } },
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
      storageStartupSync: { resetDefaultAfterLocalPurge() {} },
    },
    shell: () => null,
  });
  host.ctx.startupGate.markStartupReady();
  return host;
}

function writeIncident(id = 'incident-1'): string {
  const dir = path.join(base, 'recovery/incidents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    incident_id: id,
    created_at: '2026-11-03T00:00:00+00:00',
    resolved: false,
    failed_operation: 'startup_preflight',
    recovery_error: 'boom',
    retry_requires_restart: false,
    candidates: [],
    legacy_entries: [],
  }));
  fs.writeFileSync(path.join(dir, 'evidence.txt'), 'evidence');
  return dir;
}

it('export_startup_recovery_incident zips the incident directory and returns the destination', async () => {
  const h = await start();
  writeIncident();
  const destination = path.join(base, 'exports', 'incident.zip');

  expect(await h.invoke('export_startup_recovery_incident', { incidentId: 'incident-1', destination })).toBe(destination);

  const zip = await JSZip.loadAsync(fs.readFileSync(destination));
  expect(Object.keys(zip.files).sort()).toEqual(['evidence.txt', 'manifest.json']);
  expect(await zip.file('evidence.txt')!.async('string')).toBe('evidence');
});

it('export_startup_recovery_incident rejects unsafe ids and missing directories', async () => {
  const h = await start();
  const destination = path.join(base, 'exports', 'incident.zip');

  await expect(h.invoke('export_startup_recovery_incident', { incidentId: '..', destination }))
    .rejects.toEqual({ error_type: 'FileSystem', message: '定位恢复事件目录失败: 恢复事件 id 无效', details: null });
  await expect(h.invoke('export_startup_recovery_incident', { incidentId: 'missing', destination }))
    .rejects.toEqual({ error_type: 'FileSystem', message: '定位恢复事件目录失败: 恢复事件目录不存在', details: null });
  expect(fs.existsSync(destination)).toBe(false);
});

it('export_startup_recovery_incident fails closed for virtual destinations and removes its staging copy', async () => {
  const h = await start();
  writeIncident();

  await expect(h.invoke('export_startup_recovery_incident', {
    incidentId: 'incident-1',
    destination: 'content://downloads/incident.zip',
  })).rejects.toMatchObject({
    error_type: 'FileSystem',
    message: expect.stringContaining('写入目标位置失败'),
  });

  const staging = path.join(base, 'recovery/export-staging');
  expect(fs.readdirSync(staging)).toEqual([]);
});

it('export_startup_recovery_report writes the ordered pretty JSON payload', async () => {
  const h = await start();
  writeIncident();
  const destination = path.join(base, 'reports', 'diagnostic.json');

  expect(await h.invoke('export_startup_recovery_report', { destination })).toBe(destination);

  const text = fs.readFileSync(destination, 'utf8');
  expect(text.startsWith('{\n  "format_version": 1,\n  "generated_at": ')).toBe(true);
  expect(text.endsWith('}')).toBe(true);
  const payload = JSON.parse(text) as {
    format_version: number;
    generated_at: string;
    startup_recovery: { recovery_required: boolean };
    incidents: unknown[];
    component_health: { components: Array<{ component: string; status: string; reason: string | null; dependency: string | null }> };
  };
  expect(Object.keys(payload)).toEqual(['format_version', 'generated_at', 'startup_recovery', 'incidents', 'component_health']);
  expect(Number.isNaN(Date.parse(payload.generated_at))).toBe(false);
  expect(payload.startup_recovery.recovery_required).toBe(false);
  expect(payload.incidents).toHaveLength(1);
  expect(payload.component_health.components.map((entry) => entry.component)).toEqual(['vfs', 'mistakes', 'chat_v2', 'llm_usage', 'audit']);
  expect(payload.component_health.components.every((entry) => entry.status === 'healthy' && entry.reason === null && entry.dependency === null)).toBe(true);
});

it('recovery mode reports component_health as null because startup health is not initialized', async () => {
  fs.mkdirSync(path.join(base, 'slots/slotB'), { recursive: true });
  fs.writeFileSync(path.join(base, 'slots/slotB/cache.db'), 'unrelated');
  fs.writeFileSync(path.join(base, 'unrelated.db'), 'legacy');
  const h = await start();
  expect(await h.invoke('get_startup_recovery_status')).toMatchObject({ recovery_required: true });

  const destination = path.join(base, 'diagnostic.json');
  expect(await h.invoke('export_startup_recovery_report', { destination })).toBe(destination);

  const payload = JSON.parse(fs.readFileSync(destination, 'utf8')) as {
    startup_recovery: { recovery_required: boolean };
    component_health: unknown;
  };
  expect(payload.startup_recovery.recovery_required).toBe(true);
  expect(payload.component_health).toBeNull();
});
