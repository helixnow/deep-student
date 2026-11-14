/**
 * Every static SQL literal in storage, secrets and the attachment repositories must prepare against the migrated
 * schema. A query naming a column no migration creates (Rust `get_session_usage` → `caller_id`) only fails when the
 * command runs; preparing them all here catches that class of bug without a scenario for each command.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createStorageService } from '../service.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\s+\S/i;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tests') walk(file);
      } else if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        out.push(file);
      }
    }
  };
  walk(path.join(ROOT, 'host/platform/storage'));
  walk(path.join(ROOT, 'host/platform/secrets'));
  const repos = path.join(ROOT, 'host/plugins/vfs-repos/repository');
  for (const name of fs.readdirSync(repos)) if (name.startsWith('attachment')) out.push(path.join(repos, name));
  return out;
}

function staticSqlLiterals(text: string): Array<{ sql: string; line: number }> {
  const out: Array<{ sql: string; line: number }> = [];
  const literal = /`((?:[^`\\]|\\[\s\S])*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  for (let m = literal.exec(text); m !== null; m = literal.exec(text)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(['"`\\])/g, '$1');
    if (!SQL_START.test(body) || body.includes('${')) continue;
    out.push({ sql: body, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

it('every static SQL literal in storage, secrets and attachment repositories prepares against some migrated database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-static-sql-'));
  try {
    const storage = createStorageService({ baseDir: root, dataLocalDir: root });
    try {
      const report = await storage.migrations.runAll();
      expect(report.success).toBe(true);
      storage.database('audit').pluck('SELECT 1');
      storage.database('sync_state').pluck('SELECT 1');
    } finally {
      storage.dispose();
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.db')) files.push(file);
      }
    };
    walk(root);
    expect(files.length).toBe(6);
    const databases = files.map(file => new Database(file, { readonly: true }));
    const failures: string[] = [];
    let checked = 0;
    try {
      for (const file of sourceFiles()) {
        for (const { sql, line } of staticSqlLiterals(fs.readFileSync(file, 'utf8'))) {
          checked += 1;
          const errors = new Set<string>();
          const prepared = databases.some((db) => {
            try {
              db.prepare(sql);
              return true;
            } catch (error) {
              errors.add((error as Error).message);
              return false;
            }
          });
          if (!prepared) failures.push(`${path.relative(ROOT, file)}:${line}: ${[...errors].join(' | ')}`);
        }
      }
    } finally {
      for (const db of databases) db.close();
    }
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 300_000);
