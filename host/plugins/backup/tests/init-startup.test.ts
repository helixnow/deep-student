/**
 * `src-tauri/src/data_governance/init.rs::tests` 的真实生产移植。
 *
 * 目录/审计/报告走 L21 恢复候选槽实际使用的 `src/initialization.ts`；
 * 空目录 schema 状态走 F3 正式 `MigrationCoordinator` + `aggregateSchemaRegistry`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { Connection } from '../../../platform/storage/connection.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { aggregateSchemaRegistry } from '../../../platform/storage/migration/schema-registry.ts';
import {
  ensureDirectories, InitializationReport, initializeAuditLog,
} from '../src/initialization.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../../resources/app/migrations');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-init-'));
  tempDirs.push(dir);
  return dir;
}

it('test_ensure_directories', () => {
  const dir = createTestDir();
  ensureDirectories(dir);
  expect(fs.existsSync(path.join(dir, 'databases'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'backups'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'slots', 'slotA'))).toBe(true);
});

it('test_initialization_report_new', () => {
  const report = new InitializationReport();
  expect(report.auditInitialized).toBe(false);
  expect(report.migrationsSuccess).toBe(false);
  expect(report.migrationsApplied).toBe(0);
  expect(report.warnings).toEqual([]);
});

it('test_initialization_report_is_fully_successful', () => {
  const report = new InitializationReport();
  expect(report.isFullySuccessful()).toBe(false);
  report.auditInitialized = true;
  report.migrationsSuccess = true;
  expect(report.isFullySuccessful()).toBe(true);
  report.addWarning('test warning');
  expect(report.isFullySuccessful()).toBe(false);
});

it('test_get_current_schema_state_empty', () => {
  const dir = createTestDir();
  const coordinator = new MigrationCoordinator({
    appDataDir: dir, migrationsDir: MIGRATIONS, auditDbPath: null,
  });
  const registry = aggregateSchemaRegistry(coordinator);
  expect(registry.databases.size).toBe(0);
  expect(registry.globalVersion).toBe(0);
});

it('test_initialize_audit_log', () => {
  const dir = createTestDir();
  ensureDirectories(dir);
  initializeAuditLog(dir);
  const auditDbPath = path.join(dir, 'databases', 'audit.db');
  expect(fs.existsSync(auditDbPath)).toBe(true);
  const conn = new Connection(auditDbPath, { label: 'audit-verify', profile: PROFILES.plain });
  try {
    expect(conn.pluck<number>(
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='__audit_log'",
    )).toBe(1);
  } finally {
    conn.close();
  }
});
