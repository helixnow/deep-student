import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractSet } from '../../../kernel/contracts.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import plugin from '../index.ts';
import {
  type AutomationDefinition, completeRun, createManualRun,
  saveAutomations,
} from '../repository/automations.ts';
import { type AutomationSchedule, formatTimestampMillis } from '../src/automation-schedule.ts';

// createTestHost() 默认每次同步读取并校验 contracts/ipc 全部契约（约 650ms）；ContractSet 不可变，整个文件共用一份。
const contracts = ContractSet.fromDirectory();

// 本文件全程是同步 SQLite + 微任务，事件循环不转，worker 读不到 vitest RPC 回复；每个用例后让出一次。
afterEach(() => new Promise<void>((resolve) => { setImmediate(resolve); }));

async function fixture() {
  const host = await createTestHost({ contracts });
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('mistakes');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
  host.ctx.provide('settings', settings);
  host.ctx.provide('storage', storage);
  await host.install(plugin);
  return { host, storage, db, settings };
}

function schedule(kind: AutomationSchedule['kind'], time: string, overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return { kind, time, weekday: null, weekdays: null, day_of_month: null,
    interval_minutes: null, date: null, timezone: null, ...overrides };
}

function sampleDaily(time: string, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'auto_test', name: 'Daily review', schedule: schedule('daily', time),
    prompt: 'Summarize mistakes', enabled: true, created_at: formatTimestampMillis(Date.now()),
    session_id: 'ui', last_run_at: null, next_run_at: null,
    action_type: 'notify', heartbeat: false, agent_prompt: null, session_mode: null,
    model_id: null, agent_session_id: null, catch_up_policy: 'run_once',
    max_retries: 2, retry_backoff_seconds: 60, timeout_seconds: 600,
    trusted_profile: null, version: 1, ...overrides,
  };
}

describe('automations.rs list/create/update/delete commands', () => {
  it('lists automation definitions with the UI mapping', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      const response = await host.invoke<{ count: number; max: number; automations: Record<string, unknown>[] }>('chat_v2_automation_list');
      expect(response.count).toBe(1);
      expect(response.max).toBe(20);
      expect(response.automations[0]).toMatchObject({
        id: 'auto_test', name: 'Daily review', enabled: true, action_type: 'notify',
        catch_up_policy: 'run_once', version: 1, session_mode: null,
      });
      expect(response.automations[0]!.next_trigger_at).toEqual(expect.any(String));
      expect(response.automations[0]!.schedule).toEqual({ kind: 'daily', time: '09:00' });
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('creates a daily automation, emits the event and persists the schedule JSON', async () => {
    const { host, storage, db } = await fixture();
    try {
      const response = await host.invoke<{ success: boolean; automation: Record<string, unknown> }>('chat_v2_automation_create', {
        request: { name: '  Daily  ', schedule: { kind: 'daily', time: '09:00' }, prompt: '  do it  ' },
      });
      const automation = response.automation;
      expect(response.success).toBe(true);
      expect(automation.name).toBe('Daily');
      expect(automation.prompt).toBe('do it');
      expect(automation.enabled).toBe(true);
      expect(automation.version).toBe(1);
      expect(automation.next_trigger_at).toEqual(expect.any(String));
      expect(automation.schedule).toEqual({ kind: 'daily', time: '09:00' });
      const row = db.get('SELECT schedule_json, source_session_id FROM automation_definitions WHERE id = ?1',
        [String(automation.id)]) as { schedule_json: string; source_session_id: string } | undefined;
      expect(row?.schedule_json).toBe('{"kind":"daily","time":"09:00"}');
      expect(row?.source_session_id).toBe('ui');
      expect(host.eventsNamed('chat_v2://automations_changed')).toEqual([{ action: 'create', automationId: automation.id }]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('accepts the generated enum map form for schedule kinds', async () => {
    const { host, storage } = await fixture();
    try {
      const response = await host.invoke<{ automation: Record<string, unknown> }>('chat_v2_automation_create', {
        request: { name: 'mapped', schedule: { kind: { daily: null }, time: '10:00' }, prompt: 'p' },
      });
      expect((response.automation.schedule as Record<string, unknown>).kind).toBe('daily');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('rejects notify automations that carry agent-only fields', async () => {
    const { host, storage } = await fixture();
    try {
      await expect(host.invoke('chat_v2_automation_create', {
        request: { name: 'bad', schedule: { kind: 'daily', time: '09:00' }, prompt: 'p', modelId: 'm' },
      })).rejects.toBe('{"code":"VALIDATION_ERROR","message":"agent fields require action_type=agent_turn"}');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('enforces the twenty automation limit', async () => {
    const { host, storage, db } = await fixture();
    try {
      const rows: AutomationDefinition[] = [];
      for (let index = 0; index < 20; index += 1) rows.push(sampleDaily('09:00', { id: `auto_${index}` }));
      saveAutomations(db, rows);
      await expect(host.invoke('chat_v2_automation_create', {
        request: { name: 'extra', schedule: { kind: 'daily', time: '09:00' }, prompt: 'p' },
      })).rejects.toBe('{"code":"VALIDATION_ERROR","message":"Automation limit reached (max 20)"}');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('toggles enabled state and keeps an idempotent no-op version', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      const disabled = await host.invoke<{ previous: Record<string, unknown>; current: Record<string, unknown> }>(
        'chat_v2_automation_set_enabled', { automationId: 'auto_test', expectedVersion: 1, enabled: false });
      expect(disabled.previous.enabled).toBe(true);
      expect(disabled.current.enabled).toBe(false);
      expect(disabled.current.version).toBe(2);
      expect(disabled.current.next_trigger_at).toBeNull();
      expect(disabled.current.schedule).toEqual({ kind: 'daily', time: '09:00' });
      const idempotent = await host.invoke<{ previous: Record<string, unknown>; current: Record<string, unknown> }>(
        'chat_v2_automation_set_enabled', { automationId: 'auto_test', expectedVersion: 2, enabled: false });
      expect(idempotent.current.version).toBe(2);
      expect(host.eventsNamed('chat_v2://automations_changed'))
        .toEqual([{ action: 'set_enabled', automationId: 'auto_test' }, { action: 'set_enabled', automationId: 'auto_test' }]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('updates prompt without touching the independent agent prompt', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00', { next_run_at: formatTimestampMillis(Date.now() + 3_600_000),
        action_type: 'agent_turn', agent_prompt: 'old effective prompt' })]);
      const response = await host.invoke<{ current: Record<string, unknown>; next_trigger: unknown }>('chat_v2_automation_update', {
        request: { automationId: 'auto_test', expectedVersion: 1, prompt: 'new effective prompt' },
      });
      expect(response.current.prompt).toBe('new effective prompt');
      expect(response.current.agent_prompt).toBe('old effective prompt');
      expect(response.next_trigger).toEqual(expect.any(String));
      expect(host.eventsNamed('chat_v2://automations_changed'))
        .toEqual([{ action: 'update', automationId: 'auto_test' }]);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('ui_update_dto_accepts_camel_case_interval_minutes and clears nullable agent fields with explicit null', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00', { action_type: 'agent_turn', agent_prompt: 'x', session_mode: 'named' })]);
      const response = await host.invoke<{ current: Record<string, unknown> }>('chat_v2_automation_update', {
        request: { automationId: 'auto_test', expectedVersion: 1, agentPrompt: null,
          schedule: { kind: 'interval', intervalMinutes: 30 } },
      });
      expect(response.current.agent_prompt).toBeNull();
      expect((response.current.schedule as Record<string, unknown>).interval_minutes).toBe(30);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('returns the structured OCC conflict payload', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      let error = '';
      try {
        await host.invoke('chat_v2_automation_update', {
          request: { automationId: 'auto_test', expectedVersion: 9, prompt: 'next' },
        });
      } catch (caught) { error = String(caught); }
      const payload = JSON.parse(error) as Record<string, unknown>;
      expect(payload.code).toBe('AUTOMATION_VERSION_CONFLICT');
      expect(payload.errorType).toBe('conflict');
      expect(payload.expectedVersion).toBe(9);
      expect(payload.currentVersion).toBe(1);
      expect((payload.current as Record<string, unknown>).id).toBe('auto_test');
      expect((payload.current as Record<string, unknown>).schedule).toEqual({ kind: 'daily', time: '09:00' });
      expect(payload.retryable).toBe(true);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  describe('V2-03 persisted schedule_json strict serde boundary (automations.rs:249-274, 960-968)', () => {
    async function withSchedule(raw: string, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
      const f = await fixture();
      try {
        saveAutomations(f.db, [sampleDaily('09:00', { enabled: false })]);
        f.db.run('UPDATE automation_definitions SET schedule_json = ?1 WHERE id = ?2', [raw, 'auto_test']);
        await body(f);
      } finally { await f.host.unload('dstu.agent-orchestration'); f.storage.dispose(); await f.host.dispose(); }
    }

    it('defaults missing fields, omits None fields and ignores unknown fields without business re-validation', async () => {
      const raw = '{"kind":"daily","weekday":255,"extra":{"values":[1,null,true]}}';
      await withSchedule(raw, async ({ host }) => {
        const result = await host.invoke<{ automations: Record<string, unknown>[] }>('chat_v2_automation_list');
        expect(result.automations[0]!.schedule).toStrictEqual({ kind: 'daily', time: '', weekday: 255 });
      });
    });

    it.each<[string, Record<string, unknown>]>([
      ['{"kind":{"weekly":null},"weekdays":[0,6],"date":null}', { kind: 'weekly', time: '', weekdays: [0, 6] }],
      ['["interval","",null,null,null,4294967295,null,null]', { kind: 'interval', time: '', interval_minutes: 4294967295 }],
      ['["daily","",null]', { kind: 'daily', time: '' }],
    ])('reads Rust enum/positional forms without changing optional output: %s', async (raw, expected) => {
      await withSchedule(raw, async ({ host }) => {
        const result = await host.invoke<{ automations: Record<string, unknown>[] }>('chat_v2_automation_list');
        expect(result.automations[0]!.schedule).toStrictEqual(expected);
      });
    });

    const badFinalValues: Array<[string, string, string]> = [
      ['string weekday', '{"kind":"daily","weekday":"2"}', 'invalid type: string "2", expected u8'],
      ['negative u8', '{"kind":"daily","weekday":-1}', 'invalid value: integer `-1`, expected u8'],
      ['overflow u8', '{"kind":"daily","day_of_month":256}', 'invalid value: integer `256`, expected u8'],
      ['float u8', '{"kind":"daily","weekday":1.0}', 'invalid type: floating point `1.0`, expected u8'],
      ['overflow u32', '{"kind":"interval","interval_minutes":4294967296}', 'invalid value: integer `4294967296`, expected u32'],
      ['null time', '{"kind":"daily","time":null}', 'invalid type: null, expected a string'],
      ['non-string date', '{"kind":"once","date":42}', 'invalid type: integer `42`, expected a string'],
      ['non-string timezone', '{"kind":"daily","timezone":false}', 'invalid type: boolean `false`, expected a string'],
      ['non-array weekdays', '{"kind":"weekly","weekdays":2}', 'invalid type: integer `2`, expected a sequence'],
      ['case-sensitive kind', '{"kind":"DAILY"}',
        'unknown variant `DAILY`, expected one of `daily`, `weekly`, `weekdays`, `monthly`, `interval`, `once`'],
    ];

    it.each(badFinalValues)('rejects %s at the list command instead of silently dropping/defaulting it', async (_label, raw, reason) => {
      await withSchedule(raw, async ({ host }) => {
        await expect(host.invoke('chat_v2_automation_list')).rejects.toBe(JSON.stringify({
          code: 'DATABASE_ERROR', message: `Failed to load automations: Conversion error from type Text at index: ${Buffer.byteLength(raw)}, `
            + `${reason} at line 1 column ${Buffer.byteLength(raw) - 1}`,
        }));
      });
    });

    it('does not filter invalid Vec elements, and reports their original position', async () => {
      const raw = '{"kind":"weekly","weekdays":[1,"x"]}';
      await withSchedule(raw, async ({ host }) => {
        await expect(host.invoke('chat_v2_automation_list')).rejects.toBe(JSON.stringify({
          code: 'DATABASE_ERROR', message: `Failed to load automations: Conversion error from type Text at index: ${raw.length}, `
            + `invalid type: string "x", expected u8 at line 1 column ${raw.length - 2}`,
        }));
      });
    });

    it('rejects missing kind despite ScheduleKind implementing Default', async () => {
      await withSchedule('{}', async ({ host }) => {
        await expect(host.invoke('chat_v2_automation_list')).rejects.toBe(JSON.stringify({
          code: 'DATABASE_ERROR', message: 'Failed to load automations: Conversion error from type Text at index: 2, missing field `kind` at line 1 column 2',
        }));
      });
    });

    it('reports the first field error before later malformed JSON, profile decoding and version conflict', async () => {
      const raw = '{"weekday":"bad","kind":';
      await withSchedule(raw, async ({ host, db }) => {
        db.run("UPDATE automation_definitions SET trusted_profile_json = '{' WHERE id = 'auto_test'");
        await expect(host.invoke('chat_v2_automation_update', {
          request: { automationId: 'auto_test', expectedVersion: 9, prompt: 'next' },
        })).rejects.toBe(JSON.stringify({ code: 'DATABASE_ERROR',
          message: `Failed to load automation: Conversion error from type Text at index: ${raw.length}, invalid type: string "bad", expected u8 at line 1 column 16`,
        }));
      });
    });

    it('rejects a duplicate Option field even if its previous value was null', async () => {
      const raw = '{"kind":"daily","date":null,"date":';
      await withSchedule(raw, async ({ host }) => {
        await expect(host.invoke('chat_v2_automation_list')).rejects.toBe(JSON.stringify({ code: 'DATABASE_ERROR',
          message: `Failed to load automations: Conversion error from type Text at index: ${raw.length}, duplicate field \`date\` at line 1 column ${raw.length - 1}`,
        }));
      });
    });
  });

  describe('X6-UD-L06-01 persisted trusted_profile_json serde decoding (automations.rs:298-318, 989-1003)', () => {
    const fullProfile = {
      schemaVersion: 1, profileHash: 'stored', allowedTools: ['builtin-workspace_file_read'],
      runtimeRoots: [{ rootId: 'workspace', access: 'read_only' }], shellCommandPrefixes: [],
      networkDomains: [], maxToolRounds: 4, timeoutSeconds: 120, maxOutputBytes: 1024, rollbackRequired: false,
    };
    const dbErr = (context: string, raw: string, serde: string) => JSON.stringify({
      code: 'DATABASE_ERROR',
      message: `${context}: Conversion error from type Text at index: ${Buffer.byteLength(raw)}, ${serde}`,
    });

    async function withStoredProfile(raw: string, body: (host: Awaited<ReturnType<typeof fixture>>['host']) => Promise<void>) {
      const { host, storage, db } = await fixture();
      try {
        saveAutomations(db, [sampleDaily('09:00')]);
        db.run('UPDATE automation_definitions SET trusted_profile_json = ?1 WHERE id = ?2', [raw, 'auto_test']);
        await body(host);
      } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
    }

    it('decodes a complete stored profile without re-validating it', async () => {
      // row_to_automation only deserializes; validate() runs on seal, so the stale hash survives.
      await withStoredProfile(JSON.stringify(fullProfile), async (host) => {
        const response = await host.invoke<{ automations: Record<string, unknown>[] }>('chat_v2_automation_list');
        expect(response.automations[0]!.trusted_profile).toEqual(fullProfile);
      });
    });

    it('accepts the externally tagged {"read_only":null} enum form', async () => {
      const raw = JSON.stringify({ ...fullProfile, runtimeRoots: [{ rootId: 'workspace', access: { read_only: null } }] });
      await withStoredProfile(raw, async (host) => {
        const response = await host.invoke<{ automations: Record<string, unknown>[] }>('chat_v2_automation_list');
        expect(response.automations[0]!.trusted_profile).toEqual(fullProfile);
      });
    });

    /** serde_json position after consuming `raw.slice(0, end)`: line from 1, column = UTF-8 bytes on that line. */
    const at = (raw: string, end: number) => {
      const before = raw.slice(0, end);
      const lastBreak = before.lastIndexOf('\n');
      return ` at line ${before.split('\n').length} column ${Buffer.byteLength(before.slice(lastBreak + 1))}`;
    };
    /** Error raised once `token` (first occurrence at/after `from`) has been consumed. */
    const after = (raw: string, token: string, from = 0) => at(raw, raw.indexOf(token, from) + token.length);
    /** peek_error: the peeked ASCII byte counts in the column. */
    const peekAt = (raw: string, token: string) => at(raw, raw.indexOf(token) + 1);
    const withRaw = (needle: string, replacement: string) => JSON.stringify(fullProfile).replace(needle, replacement);
    const FIELD_LIST = 'expected one of `schemaVersion`, `profileHash`, `allowedTools`, `runtimeRoots`, '
      + '`shellCommandPrefixes`, `networkDomains`, `maxToolRounds`, `timeoutSeconds`, `maxOutputBytes`, `rollbackRequired`';
    const rootsWith = (access: string) => withRaw('"access":"read_only"', `"access":${access}`);

    const { rollbackRequired: _omit, ...missingRollback } = fullProfile;
    const { schemaVersion: _omitVersion, ...missingFirst } = fullProfile;
    const missingRollbackRaw = JSON.stringify(missingRollback);
    const cases: Array<[string, string, (raw: string) => string]> = [
      ['missing field', missingRollbackRaw, (raw) => `missing field \`rollbackRequired\`${at(raw, raw.length)}`],
      ['missing fields reported in declaration order', JSON.stringify({ ...missingFirst, rollbackRequired: undefined }),
        (raw) => `missing field \`schemaVersion\`${at(raw, raw.length)}`],
      ['unknown field (deny_unknown_fields) before its value', JSON.stringify({ ...fullProfile, extra: 1 }),
        (raw) => `unknown field \`extra\`, ${FIELD_LIST}${after(raw, '"extra"')}`],
      ['unknown field position skips whitespace before the colon', '{"extra" \n :1}',
        (raw) => `unknown field \`extra\`, ${FIELD_LIST}${at(raw, raw.indexOf(':'))}`],
      ['unknown field with an out-of-range value is rejected by name', '{"extra":1e400}',
        (raw) => `unknown field \`extra\`, ${FIELD_LIST}${after(raw, '"extra"')}`],
      ['snake_case key is unknown', JSON.stringify({ schema_version: 1 }),
        (raw) => `unknown field \`schema_version\`, ${FIELD_LIST}${after(raw, '"schema_version"')}`],
      ['duplicate field (deny_unknown_fields does not allow last-wins)', withRaw('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,'),
        (raw) => `duplicate field \`schemaVersion\`${after(raw, '"schemaVersion"', 2)}`],
      ['string for u16', JSON.stringify({ ...fullProfile, schemaVersion: '1' }),
        (raw) => `invalid type: string "1", expected u16${after(raw, '"1"')}`],
      ['u16 overflow', JSON.stringify({ ...fullProfile, schemaVersion: 70000 }),
        (raw) => `invalid value: integer \`70000\`, expected u16${after(raw, '70000')}`],
      ['float for u32', JSON.stringify({ ...fullProfile, maxToolRounds: 1.5 }),
        (raw) => `invalid type: floating point \`1.5\`, expected u32${after(raw, '1.5')}`],
      ['negative u64', JSON.stringify({ ...fullProfile, timeoutSeconds: -1 }),
        (raw) => `invalid value: integer \`-1\`, expected u64${after(raw, '-1')}`],
      ['string bool', JSON.stringify({ ...fullProfile, rollbackRequired: 'true' }),
        (raw) => `invalid type: string "true", expected a boolean${after(raw, '"true"')}`],
      ['null String', JSON.stringify({ ...fullProfile, profileHash: null }),
        (raw) => `invalid type: null, expected a string${after(raw, 'null')}`],
      ['null Vec<String>', JSON.stringify({ ...fullProfile, allowedTools: null }),
        (raw) => `invalid type: null, expected a sequence${after(raw, 'null')}`],
      ['object for Vec<String> (container not consumed)', JSON.stringify({ ...fullProfile, networkDomains: {} }),
        (raw) => `invalid type: map, expected a sequence${at(raw, raw.indexOf('{}'))}`],
      ['non-string element', JSON.stringify({ ...fullProfile, networkDomains: [1] }),
        (raw) => `invalid type: integer \`1\`, expected a string${after(raw, '[1')}`],
      ['unknown enum variant', rootsWith('"admin"'),
        (raw) => `unknown variant \`admin\`, expected \`read_only\` or \`read_write\`${after(raw, '"admin"')}`],
      ['unknown enum variant in map form', rootsWith('{"admin":null}'),
        (raw) => `unknown variant \`admin\`, expected \`read_only\` or \`read_write\`${after(raw, '"admin"')}`],
      ['unit variant with a non-null payload', rootsWith('{"read_only":1}'),
        (raw) => `invalid type: integer \`1\`, expected unit${after(raw, '"read_only":1')}`],
      ['unit variant map with a second key', rootsWith('{"read_only":null,"x":1}'),
        (raw) => `expected value${after(raw, '"read_only":null')}`],
      ['empty map for the enum', rootsWith('{}'),
        (raw) => `expected value${after(raw, '"access":{}')}`],
      ['enum map without a colon', rootsWith('{"read_only" null}'),
        (raw) => `expected \`:\`${peekAt(raw, 'null}}')}`],
      ['integer for the enum is expected value at the peeked byte', rootsWith('7'),
        (raw) => `expected value${peekAt(raw, '7}')}`],
      ['null for the enum is expected value, not invalid type', rootsWith('null'),
        (raw) => `expected value${peekAt(raw, 'null}')}`],
      ['unknown root field', JSON.stringify({ ...fullProfile, runtimeRoots: [{ rootId: 'workspace', access: 'read_only', mode: 1 }] }),
        (raw) => `unknown field \`mode\`, expected \`rootId\` or \`access\`${after(raw, '"mode"')}`],
      ['missing root field', JSON.stringify({ ...fullProfile, runtimeRoots: [{ rootId: 'workspace' }] }),
        (raw) => `missing field \`access\`${after(raw, '"workspace"}')}`],
      ['empty sequence is a too-short struct sequence', '[]',
        () => 'invalid length 0, expected struct TrustedAutomationProfile with 10 elements at line 1 column 2'],
      ['string root is invalid type struct', '"x"',
        () => 'invalid type: string "x", expected struct TrustedAutomationProfile at line 1 column 3'],
      ['struct sequence too short', '[1,"h"]',
        (raw) => `invalid length 2, expected struct TrustedAutomationProfile with 10 elements${at(raw, raw.length)}`],
      ['struct sequence with an extra element (end_seq peek_error)', '[1,"h",[],[],[],[],4,120,1024,false,true]',
        (raw) => `trailing characters${peekAt(raw, 'true')}`],
      ['struct sequence with a trailing comma', '[1,"h",[],[],[],[],4,120,1024,false,]',
        (raw) => `trailing comma${at(raw, raw.length)}`],
      ['root struct sequence too short', withRaw('{"rootId":"workspace","access":"read_only"}', '["workspace"]'),
        (raw) => `invalid length 1, expected struct AutomationRuntimeRoot with 2 elements${after(raw, '["workspace"]')}`],
      ['first bad key wins in JSON order', JSON.stringify({ maxToolRounds: 'x', extra: 1 }),
        (raw) => `invalid type: string "x", expected u32${after(raw, '"x"')}`],
      ['typed error before a later syntax error (streaming)', '{"maxToolRounds":"x",,',
        (raw) => `invalid type: string "x", expected u32${after(raw, '"x"')}`],
      ['missing comma is a peek_error', '{"profileHash":"h" "allowedTools":[]}',
        (raw) => `expected \`,\` or \`}\`${peekAt(raw, '"allowedTools"')}`],
      ['trailing characters after the root value', `${JSON.stringify(fullProfile)} x`,
        (raw) => `trailing characters${at(raw, raw.length)}`],
      ['column counts UTF-8 bytes', JSON.stringify({ profileHash: '规则', extra: 1 }),
        (raw) => `unknown field \`extra\`, ${FIELD_LIST}${after(raw, '"extra"')}`],
      ['line and column in pretty-printed JSON', JSON.stringify({ ...fullProfile, maxToolRounds: 'x' }, null, 2),
        (raw) => `invalid type: string "x", expected u32${after(raw, '"x"')}`],
      // serde_json lexes `1.0` / `1e0` as f64, which never deserializes into an integer field.
      ['1.0 literal for u16', withRaw('"schemaVersion":1', '"schemaVersion":1.0'),
        (raw) => `invalid type: floating point \`1.0\`, expected u16${after(raw, '1.0')}`],
      ['exponent literal for u32', withRaw('"maxToolRounds":4', '"maxToolRounds":4e0'),
        (raw) => `invalid type: floating point \`4.0\`, expected u32${after(raw, '4e0')}`],
      // zmij (serde_json's float Display) uses `d.ddde+X` outside 1e-5..1e16 (zmij-1.0.21 lib.rs:1064-1116).
      ['large float display uses zmij exponent form', withRaw('"timeoutSeconds":120', '"timeoutSeconds":1e21'),
        (raw) => `invalid type: floating point \`1e+21\`, expected u64${after(raw, '1e21')}`],
      ['small float display uses zmij negative exponent', withRaw('"timeoutSeconds":120', '"timeoutSeconds":1e-7'),
        (raw) => `invalid type: floating point \`1e-7\`, expected u64${after(raw, '1e-7')}`],
      ['float display at the fixed-form boundary', withRaw('"timeoutSeconds":120', '"timeoutSeconds":1e15'),
        (raw) => `invalid type: floating point \`1000000000000000.0\`, expected u64${after(raw, '1e15')}`],
      ['float for a String field uses the same display', withRaw('"profileHash":"stored"', '"profileHash":2.5e30'),
        (raw) => `invalid type: floating point \`2.5e+30\`, expected a string${after(raw, '2.5e30')}`],
      // Integer tokens keep full precision: above u64::MAX serde_json falls back to f64.
      ['integer above u64::MAX', withRaw('"timeoutSeconds":120', '"timeoutSeconds":18446744073709551616'),
        (raw) => `invalid type: floating point \`1.8446744073709552e+19\`, expected u64${after(raw, '18446744073709551616')}`],
      ['u32 overflow beyond 2^53 reported exactly', withRaw('"maxToolRounds":4', '"maxToolRounds":9007199254740993'),
        (raw) => `invalid value: integer \`9007199254740993\`, expected u32${after(raw, '9007199254740993')}`],
      ['out-of-range float literal', withRaw('"timeoutSeconds":120', '"timeoutSeconds":1e400'),
        (raw) => `number out of range${after(raw, '1e400')}`],
    ];

    it.each(cases)('chat_v2_automation_list fails closed on %s', async (_label, raw, serde) => {
      await withStoredProfile(raw, async (host) => {
        await expect(host.invoke('chat_v2_automation_list')).rejects.toBe(dbErr('Failed to load automations', raw, serde(raw)));
      });
    });

    it('update reports the load error before the version conflict, as Rust does', async () => {
      const raw = missingRollbackRaw;
      await withStoredProfile(raw, async (host) => {
        await expect(host.invoke('chat_v2_automation_update', {
          request: { automationId: 'auto_test', expectedVersion: 9, prompt: 'next' },
        })).rejects.toBe(dbErr('Failed to load automation', raw, `missing field \`rollbackRequired\`${at(raw, raw.length)}`));
      });
    });

    const accepted: Array<[string, string]> = [
      ['positional struct sequences for the profile and roots',
        '[1,"stored",["builtin-workspace_file_read"],[["workspace","read_only"]],[],[],4,120,1024,false]'],
      ['escaped keys and surrounding whitespace',
        ` ${JSON.stringify(fullProfile).replace('"schemaVersion"', '"schema\\u0056ersion"')}\n`],
      ['pretty-printed with keys out of declaration order',
        JSON.stringify(Object.fromEntries(Object.entries(fullProfile).reverse()), null, 2)],
    ];
    it.each(accepted)('chat_v2_automation_list accepts %s', async (_label, raw) => {
      await withStoredProfile(raw, async (host) => {
        const response = await host.invoke<{ automations: Record<string, unknown>[] }>('chat_v2_automation_list');
        expect(response.automations[0]!.trusted_profile).toEqual(fullProfile);
      });
    });

    describe('u64 fields above 2^53 are legal (D3: no rejection, no rounding inside the Host)', () => {
      const bigRaw = withRaw('"timeoutSeconds":120', '"timeoutSeconds":9007199254740993')
        .replace('"maxOutputBytes":1024', '"maxOutputBytes":18446744073709551615');

      it('decodes through chat_v2_automation_list; the wire number matches serde_json output parsed by the frontend', async () => {
        await withStoredProfile(bigRaw, async (host) => {
          const response = await host.invoke<{ automations: Record<string, unknown>[] }>('chat_v2_automation_list');
          expect(response.automations[0]!.trusted_profile).toEqual({
            ...fullProfile,
            timeoutSeconds: JSON.parse('9007199254740993'), maxOutputBytes: JSON.parse('18446744073709551615'),
          });
        });
      });

      it('chat_v2_automation_update re-serializes the stored profile with the exact digits in serde field order', async () => {
        const { host, storage, db } = await fixture();
        try {
          saveAutomations(db, [sampleDaily('09:00', { action_type: 'agent_turn', agent_prompt: 'go', session_mode: 'isolated' })]);
          const pretty = JSON.stringify(Object.fromEntries(Object.entries(fullProfile).reverse()), null, 1)
            .replace('"timeoutSeconds": 120', '"timeoutSeconds": 9007199254740993')
            .replace('"maxOutputBytes": 1024', '"maxOutputBytes": 18446744073709551615');
          db.run('UPDATE automation_definitions SET trusted_profile_json = ?1 WHERE id = ?2', [pretty, 'auto_test']);
          await host.invoke('chat_v2_automation_update', { request: { automationId: 'auto_test', expectedVersion: 1, prompt: 'next' } });
          expect(db.pluck<string>("SELECT trusted_profile_json FROM automation_definitions WHERE id = 'auto_test'")).toBe(bigRaw);
        } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
      });

      it('the version conflict error carries the decoded profile', async () => {
        await withStoredProfile(bigRaw, async (host) => {
          const rejected = await host.invoke('chat_v2_automation_update', {
            request: { automationId: 'auto_test', expectedVersion: 9, prompt: 'next' },
          }).then(() => null, (error: unknown) => error);
          const text = String(rejected);
          expect(text).toContain('"timeoutSeconds":9007199254740993,"maxOutputBytes":18446744073709551615,');
          const value = JSON.parse(text) as { details?: unknown; current: { trusted_profile: Record<string, unknown> } };
          expect(value.current.trusted_profile.timeoutSeconds).toBe(JSON.parse('9007199254740993'));
          expect(value.current.trusted_profile.maxOutputBytes).toBe(JSON.parse('18446744073709551615'));
        });
      });
    });

    it('blank trusted_profile_json stays None', async () => {
      await withStoredProfile('  ', async (host) => {
        const response = await host.invoke<{ automations: Record<string, unknown>[] }>('chat_v2_automation_list');
        expect(response.automations[0]!.trusted_profile).toBeNull();
      });
    });
  });

  it('V2-01 shouldKeepBackground defaults settings errors to enabled and load errors to false (automations.rs:4779-4792)', async () => {
    const { host, storage, db } = await fixture();
    try {
      const service = host.ctx.get('agentAutomation') as { shouldKeepBackground(): boolean };
      saveAutomations(db, [sampleDaily('09:00')]);
      expect(service.shouldKeepBackground()).toBe(true);
      db.exec('DROP TABLE settings');
      expect(() => db.pluck('SELECT value FROM settings')).toThrow();
      expect(service.shouldKeepBackground()).toBe(true);
      db.run("UPDATE automation_definitions SET schedule_json = 'not json' WHERE id = 'auto_test'");
      expect(service.shouldKeepBackground()).toBe(false);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('ui_update_dto_requires_camel_case_expected_version and trims automationId', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      await expect(host.invoke('chat_v2_automation_update', {
        request: { automationId: '  ', expectedVersion: 1, prompt: 'next' },
      })).rejects.toBe('{"code":"VALIDATION_ERROR","message":"automationId must not be empty"}');
      await expect(host.invoke('chat_v2_automation_update', {
        request: { automationId: 'auto_test', prompt: 'next' },
      })).rejects.toContain('expectedVersion');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('trims automationId with Rust Unicode whitespace, not just JavaScript trim', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      const response = await host.invoke<{ current: Record<string, unknown> }>('chat_v2_automation_update', {
        request: { automationId: '\u0085auto_test\u0085', expectedVersion: 1, prompt: 'next' },
      });
      expect(response.current.id).toBe('auto_test');
      expect(response.current.prompt).toBe('next');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('marks an updated consumed once automation with the once_completed notice', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00', {
        schedule: schedule('once', '09:00', { date: '2020-01-01', timezone: 'UTC' }),
        enabled: false, next_run_at: null, last_run_at: '2020-01-01T09:00:00+00:00',
      })]);
      const response = await host.invoke<Record<string, unknown>>('chat_v2_automation_update', {
        request: { automationId: 'auto_test', expectedVersion: 1, name: 'renamed' },
      });
      expect(response.once_completed).toBe(true);
      expect(response.once_completed_notice).toContain('不会使其再次触发');
      expect((response.current as Record<string, unknown>).enabled).toBe(false);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('deletes an automation and refuses the built-in heartbeat', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      const response = await host.invoke<Record<string, unknown>>('chat_v2_automation_delete', {
        automationId: 'auto_test', expectedVersion: 1,
      });
      expect(response).toMatchObject({ success: true, automationId: 'auto_test', reversible: false });
      expect((response.deleted as Record<string, unknown>).schedule).toEqual({ kind: 'daily', time: '09:00' });
      expect(db.pluck<number>('SELECT COUNT(*) FROM automation_definitions')).toBe(0);

      saveAutomations(db, [sampleDaily('09:00', { id: 'auto_heartbeat_default', heartbeat: true })]);
      await expect(host.invoke('chat_v2_automation_delete', {
        automationId: 'auto_heartbeat_default', expectedVersion: 1,
      })).rejects.toBe('{"code":"VALIDATION_ERROR","message":"The built-in heartbeat automation cannot be deleted; disable it instead"}');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('lists runs with duration_ms and filters by automation', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      const run = createManualRun(db, 'auto_test', 1);
      completeRun(db, run.run_id, 1, 'success', [], null, null, null);
      const response = await host.invoke<{ count: number; runs: Record<string, unknown>[] }>('chat_v2_automation_runs', {
        automationId: 'auto_test', limit: 5,
      });
      expect(response.count).toBe(1);
      expect(response.runs[0]).toMatchObject({ id: run.run_id, automation_id: 'auto_test', status: 'success' });
      expect(response.runs[0]!.duration_ms).toEqual(expect.any(Number));
      const all = await host.invoke<{ count: number }>('chat_v2_automation_runs', {});
      expect(all.count).toBe(1);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('cancels a live run and emits cancel_run', async () => {
    const { host, storage, db } = await fixture();
    try {
      saveAutomations(db, [sampleDaily('09:00')]);
      const run = createManualRun(db, 'auto_test', 1);
      await expect(host.invoke('chat_v2_automation_cancel_run', { runId: run.run_id }))
        .resolves.toEqual({ success: true, runId: run.run_id });
      expect(db.get('SELECT status, finished_at FROM automation_runs WHERE id = ?1', [run.run_id]))
        .toMatchObject({ status: 'cancelled' });
      expect(host.eventsNamed('chat_v2://automations_changed'))
        .toEqual([{ action: 'cancel_run', automationId: '' }]);
      await expect(host.invoke('chat_v2_automation_cancel_run', { runId: run.run_id }))
        .rejects.toBe('{"code":"VALIDATION_ERROR","message":"Run is not cancellable"}');
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });

  it('summary and retry failures reply automations.rs automation_command_error strings, not internal errors', async () => {
    const { host, storage, db } = await fixture();
    try {
      db.exec('DROP TABLE automation_runs');
      await expect(host.invoke('chat_v2_automation_summary')).rejects
        .toMatch(/^\{"code":"DATABASE_ERROR","message":"Failed to query automation summary: /);
      await expect(host.invoke('chat_v2_automation_retry_run', { runId: 'absent' })).rejects
        .toMatch(/^\{"code":"DATABASE_ERROR","message":"/);
    } finally { await host.unload('dstu.agent-orchestration'); storage.dispose(); await host.dispose(); }
  });
});
