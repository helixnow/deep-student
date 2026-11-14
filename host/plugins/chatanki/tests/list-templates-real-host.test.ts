/**
 * W22 chatanki_list_templates and template_list on an empty template table through the
 * production chain: no TemplateDatabase is injected, so hydrate's L16 `anki.templates` is the
 * store, including the builtin auto-import (chatanki_executor.rs:5684–5803, :11742;
 * template_executor.rs:755–775).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import review from '../../review/index.ts';
import type { ToolExecutionContext, ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const warnings: string[] = [];
const BUILTIN_COUNT = 16;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-list-templates-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {},
    },
  });
}, 60_000);

beforeEach(() => {
  warnings.length = 0;
  storage.database('mistakes').run('DELETE FROM custom_anki_templates');
});

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function templateRows(): number {
  return storage.database('mistakes').pluck<number>('SELECT COUNT(*) FROM custom_anki_templates')!;
}

function run(name: string, args: unknown): Promise<ToolResultInfo> {
  const context: ToolExecutionContext = {
    sessionId: 'session-list', messageId: 'message-list', blockId: 'block-list',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    warn: (message) => { warnings.push(message); },
  };
  return host.ctx.chatankiTools.execute({ id: `call-${name}`, name, arguments: args }, context);
}

it('W22 chatanki_list_templates imports the builtins into an empty table and pages them', async () => {
  expect(templateRows()).toBe(0);
  const result = await run('builtin-chatanki_list_templates', {});
  expect(result.success, result.error ?? undefined).toBe(true);
  expect(templateRows()).toBe(BUILTIN_COUNT);
  const output = result.output as Record<string, unknown>;
  expect(Object.keys(output)).toEqual([
    'status', 'activeOnly', 'query', 'total', 'page', 'pageSize', 'count', 'selectionRule', 'templates',
  ]);
  const active = host.ctx.anki.templates.list().filter((template) => template.is_active).length;
  expect(output).toMatchObject({
    status: 'ok', activeOnly: true, query: null, total: active, page: 1, pageSize: 20, count: Math.min(active, 20),
  });
  expect((output.templates as unknown[]).length).toBe(Math.min(active, 20));
  expect(warnings).toEqual([]);

  const clamped = await run('builtin-chatanki_list_templates', { category: '  ZZZ-NO-MATCH ', page: 0, pageSize: 99 });
  expect(clamped.output).toMatchObject({ status: 'ok', query: 'zzz-no-match', total: 0, page: 1, pageSize: 50, count: 0 });
});

it('W22 template_list auto-imports the builtins through anki.templates instead of warning', async () => {
  const result = await run('builtin-template_list', { builtinOnly: true });
  expect(result.success, result.error ?? undefined).toBe(true);
  expect(templateRows()).toBe(BUILTIN_COUNT);
  const output = result.output as { count: number; templates: Array<{ isBuiltIn: boolean }> };
  expect(output.count).toBeGreaterThan(0);
  expect(output.templates.every((template) => template.isBuiltIn)).toBe(true);
  expect(warnings).toEqual([]);
});
