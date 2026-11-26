import { describe, expect, it } from 'vitest';
import { checkFile, isDoubleIdentifier, isTestFile, looksLikeSql } from './lib/boundary-rules.mjs';

const rules = (rel: string, text: string) => checkFile(rel, text).filter((v) => !v.suppressed).map((v) => `${v.rule}@${v.line}`);

describe('native-import', () => {
  it('rejects electron and native drivers in plugins and kernel, with file:line', () => {
    const src = "import Database from 'better-sqlite3';\nimport { app } from 'electron';\nimport { Entry } from '@napi-rs/keyring';\nconst l = await import('@lancedb/lancedb');\n";
    expect(rules('host/plugins/notes/src/a.ts', src)).toEqual(['native-import@1', 'native-import@2', 'native-import@3', 'native-import@4']);
    expect(rules('host/kernel/x.ts', "export * from 'better-sqlite3';\n")).toEqual(['native-import@1']);
  });
  it('allows native drivers under host/platform/<svc>/', () => {
    expect(rules('host/platform/storage/db.ts', "import Database from 'better-sqlite3';\n")).toEqual([]);
    expect(rules('host/platform/secrets/k.ts', "import { Entry } from '@napi-rs/keyring';\n")).toEqual([]);
  });
  it('catches require() and type-only imports', () => {
    expect(rules('host/plugins/a/src/x.ts', "const D = require('better-sqlite3');\ntype T = import('electron').App;\n")).toEqual(['native-import@1', 'native-import@2']);
  });
});

describe('tauri-import', () => {
  it('rejects @tauri-apps anywhere under host/', () => {
    expect(rules('host/platform/log/x.ts', "import { invoke } from '@tauri-apps/api/core';\n")).toEqual(['tauri-import@1']);
  });
});

describe('cross-plugin-impl', () => {
  it('allows another plugin only through its api.ts', () => {
    expect(rules('host/plugins/qbank/src/a.ts', "import type { Llm } from '../../llm/api.ts';\n")).toEqual([]);
    expect(rules('host/plugins/qbank/src/a.ts', "import { x } from '../../llm/src/manager.ts';\n")).toEqual(['cross-plugin-impl@1']);
    expect(rules('host/plugins/qbank/src/a.ts', "import { x } from '../../llm';\n")).toEqual(['cross-plugin-impl@1']);
  });
  it('also allows the Node-free portable.ts entry, and nothing else named like it', () => {
    expect(rules('host/plugins/chat/src/a.ts', "import { VfsError } from '../../vfs/portable.ts';\n")).toEqual([]);
    expect(rules('host/plugins/chat/src/a.ts', "export { SkillsExecutor } from '../../agent-skills/portable';\n")).toEqual([]);
    expect(rules('host/plugins/chat/src/a.ts', "import type { X } from '../../vfs/portable.ts';\n")).toEqual([]);
    expect(rules('host/plugins/chat/src/a.ts', "import { x } from '../../vfs/src/portable.ts';\n")).toEqual(['cross-plugin-impl@1']);
    expect(rules('host/plugins/chat/src/a.ts', "import { x } from '../../vfs/portable-extra.ts';\n")).toEqual(['cross-plugin-impl@1']);
    expect(rules('host/plugins/chat/src/a.ts', "import { x } from '../../vfs/portable/index.ts';\n")).toEqual(['cross-plugin-impl@1']);
  });
  it('lets tests (only) import another plugin entry index.ts to install the real plugin', () => {
    expect(rules('host/plugins/chat/tests/a.test.ts', "import pipeline from '../../chat-pipeline/index.ts';\n")).toEqual([]);
    expect(rules('host/plugins/chat/tests/a.test.ts', "import { x } from '../../chat-pipeline/src/run.ts';\n")).toEqual(['cross-plugin-impl@1']);
    expect(rules('host/plugins/chat/src/a.ts', "import pipeline from '../../chat-pipeline/index.ts';\n")).toEqual(['cross-plugin-impl@1']);
  });
  it('allows imports within the same plugin and from contracts/ and kernel', () => {
    expect(rules('host/plugins/qbank/src/a.ts', "import { y } from './b.ts';\nimport { r } from '../repository/q.ts';\nimport type { C } from '../../../../contracts/ipc/x.ts';\nimport { definePlugin } from '../../../kernel/api.ts';\n")).toEqual([]);
  });
});

describe('electron-imports-plugin', () => {
  it('rejects electron/ importing host/plugins/', () => {
    expect(rules('electron/main/x.ts', "import p from '../../host/plugins/notes/manifest.ts';\n")).toEqual(['electron-imports-plugin@1']);
    expect(rules('electron/main/x.ts', "import { createHost } from '../../host/kernel/runtime.ts';\n")).toEqual([]);
  });
});

describe('sql-outside-repository', () => {
  it('detects SQL statements in string and template literals', () => {
    expect(looksLikeSql('SELECT id FROM notes WHERE x = ?')).toBe(true);
    expect(looksLikeSql('insert into t (a) values (1)')).toBe(true);
    expect(looksLikeSql('Please select a file from the list')).toBe(false);
    expect(rules('host/plugins/notes/src/svc.ts', 'const q = `UPDATE notes SET title = ${1}`;\n')).toEqual(['sql-outside-repository@1']);
  });
  it('allows SQL in repository/ and host/platform/storage/, and in tests', () => {
    expect(rules('host/plugins/notes/repository/notes.ts', "const q = 'DELETE FROM notes WHERE id = ?';\n")).toEqual([]);
    expect(rules('host/platform/storage/migrator.ts', "const q = 'CREATE TABLE refinery_schema_history (version INT4)';\n")).toEqual([]);
    expect(rules('host/plugins/notes/tests/n.test.ts', "const q = 'DELETE FROM notes';\n")).toEqual([]);
  });
  it('host/platform/storage-mobile/ is the mobile storage platform and may hold SQL like host/platform/storage/', () => {
    expect(rules('host/platform/storage-mobile/connection.ts', "db.exec('PRAGMA foreign_keys = ON');\n")).toEqual([]);
    expect(rules('host/platform/storage-mobile/migrations.ts', "const q = 'SELECT MAX(version) FROM refinery_schema_history';\n")).toEqual([]);
    expect(rules('host/platform/storage-cache/x.ts', "const q = 'SELECT MAX(version) FROM refinery_schema_history';\n")).toEqual(['sql-outside-repository@1']);
    expect(rules('host/platform/mobile/storage-mobile/x.ts', "const q = 'DELETE FROM notes';\n")).toEqual(['sql-outside-repository@1']);
  });
});

describe('test-double', () => {
  it('splits identifiers into words', () => {
    expect(isDoubleIdentifier('mockDb')).toBe(true);
    expect(isDoubleIdentifier('FakeClock')).toBe(true);
    expect(isDoubleIdentifier('create_stub')).toBe(true);
    expect(isDoubleIdentifier('stubborn')).toBe(false);
    expect(isDoubleIdentifier('mockingbird')).toBe(false);
  });
  it('rejects doubles and vitest in production files but not in test locations', () => {
    expect(rules('host/plugins/a/src/x.ts', 'const mockStore = new Map();\n')).toEqual(['test-double@1']);
    expect(rules('electron/preload/x.ts', "import { vi } from 'vitest';\n")).toEqual(['test-double@1']);
    for (const f of ['host/plugins/a/src/x.test.ts', 'host/plugins/a/__tests__/x.ts', 'host/plugins/a/__fixtures__/x.ts', 'host/plugins/a/tests/helpers.ts', 'host/kernel/testing.ts']) {
      expect(isTestFile(f)).toBe(true);
      expect(rules(f, "import { vi } from 'vitest';\nconst mockStore = vi.fn();\n")).toEqual([]);
    }
  });
  it('Playwright *.spec.ts and host/e2e/**/support/ are test code like *.test.ts', () => {
    const body = "const fakeLlm = startFakeLlm();\ntry { run(); } catch {}\n// TODO: later\n";
    for (const f of ['host/e2e/smoke/golden/01-cold-start.spec.ts', 'host/plugins/a/src/x.spec.ts', 'host/e2e/smoke/support/fake-llm.ts', 'host/e2e/support/app.ts', 'host/e2e/a/b/support/c/d.ts']) {
      expect(isTestFile(f)).toBe(true);
      expect(rules(f, body)).toEqual([]);
    }
    expect(rules('host/e2e/smoke/support/app.ts', "import { _electron } from 'electron';\n")).toEqual(['native-import@1']);
  });
  it('production files named like support or spec stay production code', () => {
    const body = 'const fakeLlm = 1;\n';
    for (const f of [
      'host/plugins/a/src/support/fake.ts',
      'host/platform/support/x.ts',
      'host/e2e/smoke/support.ts',
      'host/e2e/smoke/supporting/x.ts',
      'host/e2e/differential/runner.ts',
      'host/e2e/smoke/golden/01-cold-start.spec.mjs',
      'host/e2e/smoke/golden/spec.ts',
      'electron/support/x.ts',
      'host/plugins/a/src/x.spec.ts.bak.ts',
    ]) {
      expect(isTestFile(f), f).toBe(false);
      expect(rules(f, body), f).toEqual(['test-double@1']);
    }
  });
});

describe('todo-marker', () => {
  it('rejects TODO/FIXME/unimplemented/not implemented in comments and strings', () => {
    expect(rules('host/kernel/a.ts', '// TODO: later\nconst a = 1; /* FIXME */\nthrow new Error("not implemented");\nconst u = "unimplemented";\n')).toEqual([
      'todo-marker@1',
      'todo-marker@2',
      'todo-marker@3',
      'todo-marker@4',
    ]);
  });
  it('ignores words inside identifiers and regex-like strings that are not markers', () => {
    expect(rules('host/kernel/a.ts', 'const todos = [];\nconst implemented = true;\n')).toEqual([]);
  });
});

describe('empty-catch', () => {
  it('rejects empty catch blocks and .catch(() => {})', () => {
    expect(rules('host/kernel/a.ts', 'try { f(); } catch {}\ntry { f(); } catch (e) { /* ignore */ }\np.catch(() => {});\n')).toEqual(['empty-catch@1', 'empty-catch@2', 'empty-catch@3']);
    expect(rules('host/kernel/a.ts', 'try { f(); } catch (e) { log(e); }\np.catch((e) => report(e));\n')).toEqual([]);
  });
});

describe('boundary-allow suppression', () => {
  it('suppresses only the named rule and requires a reason', () => {
    const ok = "// boundary-allow test-double: refinery Target::Fake 是原语义\nconst fake = target.kind === 'Fake';\n";
    expect(rules('host/platform/storage/r.ts', ok)).toEqual([]);
    const noReason = '// boundary-allow test-double:\nconst fake = 1;\n';
    expect(rules('host/platform/storage/r.ts', noReason)).toEqual(['test-double@2']);
    const wrongRule = '// boundary-allow empty-catch: x\nconst fake = 1;\n';
    expect(rules('host/platform/storage/r.ts', wrongRule)).toEqual(['test-double@2']);
  });
});
