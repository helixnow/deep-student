import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import {
  type AutomationDefinition, automationToAgentListItem, automationToListItem, completeRun,
  createManualRun, deleteAutomation, effectiveAgentPrompt,
  initializeNextRun, listAutomationRuns, loadAutomations,
  retryOrFinishRun, saveAutomations, setAutomationEnabled, updateAutomationAgentSessionId,
  updateAutomationFull, updateAutomationLastRunAt, generateAutomationId, defaultHeartbeatDefinition,
  ensureHeartbeatInList, heartbeatIsSilent, scheduleSkewThreshold, effectiveLeaseTimeoutSeconds,
  rowToRun, DEFAULT_HEARTBEAT_PROMPT, cancelAutomationRun, finalizeOnceAutomation,
  claimScheduledRun, claimRetryRun, recoverStaleAutomationRuns, nextAfterClaim, dueRetryIds, insertAutomation,
  createAutomation,
} from '../repository/automations.ts';
import { retryAutomationRun } from '../repository/automation-summary.ts';
import {
  AUTOMATION_LEGACY_MIGRATED_KEY, AUTOMATIONS_KEY, migrateLegacyAutomations, parseLegacyDefinition,
} from '../repository/automation-legacy.ts';
import { ActiveAutomationRunGuard, AgentAutomationRunGuard, automationRunHasLiveExecutor, cancelAutomationRunToken } from '../src/automation-run-guard.ts';
import { type AutomationSchedule, formatTimestampMillis, normalizeScheduleShape, HEARTBEAT_OK_SENTINEL } from '../src/automation-schedule.ts';
import { parseActionType } from '../src/automation-tool-args.ts';
import { validateSchedule } from '../src/automation-schedule.ts';
import { updateFieldsFromRequest } from '../src/automation-request.ts';
import { automationCommandError } from '../src/automation-errors.ts';
import type { AppError } from '../../../platform/errors/api.ts';

let cleanup: (() => Promise<void>) | null = null;

async function fixture(): Promise<{ db: DatabaseHandle; settings: ReturnType<typeof createSettingsStore> }> {
  const host = await createTestHost();
  const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  const db = storage.database('mistakes');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  for (const name of ['V20260714__automation_scheduler.sql', 'V20260715__harden_automation_runtime.sql', 'V20260721__trusted_automation_profile.sql']) {
    db.exec(readFileSync(new URL(`../../../../resources/app/migrations/mistakes/${name}`, import.meta.url), 'utf8'));
  }
  const settings = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false });
  cleanup = async () => { storage.dispose(); await host.dispose(); };
  return { db, settings };
}

afterEach(async () => { await cleanup?.(); cleanup = null; });

function schedule(kind: AutomationSchedule['kind'], time: string, overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return { kind, time, weekday: null, weekdays: null, day_of_month: null,
    interval_minutes: null, date: null, timezone: null, ...overrides };
}

function sampleDaily(time: string, overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'auto_test', name: 'Daily review', schedule: schedule('daily', time),
    prompt: 'Summarize mistakes', enabled: true, created_at: formatTimestampMillis(Date.now()),
    session_id: 'sess_test', last_run_at: null, next_run_at: null,
    action_type: 'notify', heartbeat: false, agent_prompt: null, session_mode: null,
    model_id: null, agent_session_id: null, catch_up_policy: 'run_once',
    max_retries: 2, retry_backoff_seconds: 60, timeout_seconds: 600,
    trusted_profile: null, version: 1, ...overrides,
  };
}

describe('automations.rs repository CRUD and run bookkeeping', () => {
  it('shared_crud_services_preserve_updates_and_return_previous_values', async () => {
    const { db } = await fixture();
    const definition = sampleDaily('09:00');
    saveAutomations(db, [definition]);

    const disabled = setAutomationEnabled(db, definition.id, definition.version, false);
    expect(disabled.previous.enabled).toBe(true);
    expect(disabled.current.enabled).toBe(false);

    const weekly = schedule('weekly', '08:30', { weekday: 1 });
    const updated = updateAutomationFull(db, definition.id, disabled.current.version, {
      schedule: weekly, prompt: 'new prompt',
    });
    expect(updated.previous.enabled).toBe(false);
    expect(updated.current.schedule).toEqual(weekly);
    expect(updated.current.prompt).toBe('new prompt');

    const deleted = deleteAutomation(db, definition.id, updated.current.version);
    expect(deleted.id).toBe(definition.id);
    expect(loadAutomations(db)).toEqual([]);
  });

  it('enabling_an_already_enabled_automation_is_idempotent', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', { next_run_at: '2026-07-15T01:00:00+00:00' });
    saveAutomations(db, [automation]);

    const { previous, current } = setAutomationEnabled(db, automation.id, automation.version, true);
    expect(previous).toEqual(current);
    expect(current.version).toBe(automation.version);
    expect(current.next_run_at).toBe(automation.next_run_at);
  });

  it('runtime_bookkeeping_does_not_bump_configuration_version', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', {
      action_type: 'agent_turn', session_mode: 'named', next_run_at: null,
    });
    saveAutomations(db, [automation]);

    initializeNextRun(db, automation);
    updateAutomationLastRunAt(db, automation.id, formatTimestampMillis(Date.now()));
    updateAutomationAgentSessionId(db, automation.id, automation.version, 'sess_runtime');

    const current = loadAutomations(db)[0]!;
    expect(current.version).toBe(automation.version);
    expect(current.next_run_at).not.toBeNull();
    expect(current.last_run_at).not.toBeNull();
    expect(current.agent_session_id).toBe('sess_runtime');
  });

  it('update_prompt_preserves_independent_agent_prompt', async () => {
    const { db } = await fixture();
    const definition = sampleDaily('09:00', {
      action_type: 'agent_turn', agent_prompt: 'old effective prompt',
    });
    saveAutomations(db, [definition]);

    const updated = updateAutomationFull(db, definition.id, definition.version, { prompt: 'new effective prompt' });
    expect(effectiveAgentPrompt(updated.current)).toBe('old effective prompt');
    expect(updated.current.agent_prompt).toBe('old effective prompt');
  });

  it('agent_mapping_is_bounded_while_ui_mapping_remains_full', () => {
    const definition = sampleDaily('09:00', {
      prompt: '界'.repeat(2_100), agent_prompt: '代'.repeat(2_200),
    });
    const ui = automationToListItem(definition, Date.now());
    const agent = automationToAgentListItem(definition, Date.now());
    expect(ui.version).toBe(1);
    expect(agent.version).toBe(1);
    expect([...(ui.prompt as string)]).toHaveLength(2_100);
    expect([...(ui.agent_prompt as string)]).toHaveLength(2_200);
    expect([...(agent.prompt as string)]).toHaveLength(2_000);
    expect([...(agent.agent_prompt as string)]).toHaveLength(2_000);
    expect(agent.promptTruncated).toBe(true);
    expect(agent.fieldsTruncated).toEqual(['prompt', 'agent_prompt']);
  });

  it('definition_session_mode_roundtrip', () => {
    const value = sampleDaily('09:00', {
      action_type: 'agent_turn', session_mode: 'named', agent_session_id: 'sess_fixed',
    });
    const item = automationToListItem(value, Date.now());
    expect(item.session_mode).toBe('named');
    expect(item.agent_session_id).toBe('sess_fixed');
    expect(item.action_type).toBe('agent_turn');
  });

  it('action_type_serde_uses_snake_case', () => {
    expect(automationToListItem(sampleDaily('09:00', { action_type: 'notify' }), Date.now()).action_type).toBe('notify');
    expect(automationToListItem(sampleDaily('09:00', { action_type: 'agent_turn' }), Date.now()).action_type).toBe('agent_turn');
    // AutomationActionType::parse (automations.rs:519-528) is reached through the tool argument parser.
    expect(parseActionType({ action_type: 'agent_turn' })).toBe('agent_turn');
    expect(parseActionType({ action_type: 'NOTIFY' })).toBe('notify');
    expect(() => parseActionType({ action_type: ' Bogus ' }))
      .toThrow("Invalid action_type 'bogus'. Allowed: notify, agent_turn");
  });

  it('once_serde_roundtrip_uses_date_field', async () => {
    const { db } = await fixture();
    const value = sampleDaily('09:00', { schedule: schedule('once', '09:00', { date: '2999-01-01' }) });
    saveAutomations(db, [value]);
    const loaded = loadAutomations(db)[0]!;
    expect(loaded.schedule.kind).toBe('once');
    expect(loaded.schedule.date).toBe('2999-01-01');
    expect(loaded.schedule).toEqual(value.schedule);
  });

  it('reenabling_a_consumed_once_automation_does_not_rearm_the_past_slot', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', {
      schedule: schedule('once', '09:00', { date: '2020-01-01', timezone: 'UTC' }),
      enabled: false, next_run_at: null, last_run_at: '2020-01-01T09:00:00+00:00',
    });
    saveAutomations(db, [automation]);

    const enabled = setAutomationEnabled(db, automation.id, automation.version, true).current;
    expect(enabled.enabled).toBe(true);
    expect(enabled.next_run_at).toBeNull();
    expect(automationToListItem(enabled, Date.now()).next_trigger_at).toBeNull();
  });

  it('reenabling_an_unconsumed_once_automation_restores_its_future_slot', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', {
      schedule: schedule('once', '09:00', { date: '2999-01-01', timezone: 'UTC' }),
      enabled: false, next_run_at: null,
    });
    saveAutomations(db, [automation]);

    const enabled = setAutomationEnabled(db, automation.id, automation.version, true).current;
    expect(enabled.next_run_at).toBe('2999-01-01T09:00:00+00:00');
  });

  it('run_listing_appends_duration_ms', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);

    expect(listAutomationRuns(db, automation.id, 1)[0]!.duration_ms).toBeNull();
    expect(completeRun(db, run.run_id, run.attempt, 'success', [], null, null, null)).toBe(true);
    const listed = listAutomationRuns(db, automation.id, 1)[0]!;
    expect(listed.duration_ms).toBeGreaterThanOrEqual(0);
    expect(listed).toHaveProperty('duration_ms');
  });

  it('retry_backoff_is_capped_at_24_hours', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', { max_retries: 5, retry_backoff_seconds: 86_400 });
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    db.run('UPDATE automation_runs SET attempt = 3 WHERE id = ?1', [run.run_id]);

    const before = Date.now();
    expect(retryOrFinishRun(db, run.run_id, 3, automation, 'error', null, 'boom', false)).toBe('retry_scheduled');
    const next = listAutomationRuns(db, automation.id, 1)[0]!.next_attempt_at;
    expect(next).not.toBeNull();
    expect(Date.parse(next!)).toBeLessThanOrEqual(before + 86_400_000 + 60_000);
  });

  it('manual_run_is_rejected_while_another_run_is_active', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const first = createManualRun(db, automation.id, automation.version);
    let error: unknown;
    try { createManualRun(db, automation.id, automation.version); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ error_type: 'Conflict' });
    expect((error as { details: Record<string, unknown> }).details.code).toBe('AUTOMATION_RUN_ALREADY_ACTIVE');
    expect((error as { details: Record<string, unknown> }).details.activeRunId).toBe(first.run_id);
  });

  it('normalize_schedule_shape_weekly_canonicalizes_storage_shape', async () => {
    const { db } = await fixture();
    const weekly = schedule('weekly', '08:00', { weekdays: [5, 3, 1, 3], weekday: null });
    normalizeScheduleShape(weekly);
    saveAutomations(db, [sampleDaily('08:00', { schedule: weekly })]);
    const loaded = loadAutomations(db)[0]!;
    expect(loaded.schedule.weekday).toBe(1);
    expect(loaded.schedule.weekdays).toEqual([1, 3, 5]);
  });

  it('generate_automation_id_format', () => {
    const id = generateAutomationId(Date.UTC(2026, 6, 8, 12, 0, 0));
    expect(id.startsWith('auto_')).toBe(true);
    const parts = id.split('_');
    expect(parts).toHaveLength(3);
    expect(parts[2]).toHaveLength(4);
    expect(parts[2]).toMatch(/^[a-z0-9]{4}$/);
  });

  it('effective_agent_prompt_falls_back_to_prompt', () => {
    const auto = sampleDaily('09:00');
    expect(effectiveAgentPrompt(auto)).toBe('Summarize mistakes');
    auto.agent_prompt = '   ';
    expect(effectiveAgentPrompt(auto)).toBe('Summarize mistakes');
    auto.agent_prompt = '检查到期复习卡并生成今日复习简报';
    expect(effectiveAgentPrompt(auto)).toBe('检查到期复习卡并生成今日复习简报');
  });

  it('legacy_run_record_deserializes_with_defaults', () => {
    const record = rowToRun({ id: 'run_legacy', automation_id: 'auto_1', trigger_type: 'schedule' });
    expect(record.session_id).toBeNull();
    expect(record.status).toBeNull();
    expect(record.delivered).toEqual([]);
    expect(record.attempt).toBe(1);
    expect(record.max_attempts).toBe(1);
    expect(record.duration_ms).toBeNull();
  });

  it('skew_threshold_matches_schedule_kinds', () => {
    expect(scheduleSkewThreshold(schedule('daily', '09:00'))).toBe(48 * 3_600_000);
    expect(scheduleSkewThreshold(schedule('interval', '', { interval_minutes: 30 }))).toBe(60 * 60_000);
    expect(scheduleSkewThreshold(schedule('once', '09:00', { date: '2999-01-01' }))).toBeNull();
  });

  it('effective_lease_timeout_prefers_trusted_profile_budget', () => {
    const auto = sampleDaily('09:00', { timeout_seconds: 120 });
    expect(effectiveLeaseTimeoutSeconds(auto)).toBe(120);
    auto.trusted_profile = {
      schemaVersion: 1, profileHash: 'a'.repeat(64), allowedTools: [],
      runtimeRoots: [], shellCommandPrefixes: [], networkDomains: [],
      maxToolRounds: 8, timeoutSeconds: 300, maxOutputBytes: 1024, rollbackRequired: false,
    };
    expect(effectiveLeaseTimeoutSeconds(auto)).toBe(300);
  });

  it('heartbeat_sentinel_detection', () => {
    expect(heartbeatIsSilent('HEARTBEAT_OK')).toBe(true);
    expect(heartbeatIsSilent('  HEARTBEAT_OK\n')).toBe(true);
    expect(heartbeatIsSilent('检查完成：HEARTBEAT_OK')).toBe(false);
    expect(heartbeatIsSilent('今日有 3 张卡片到期，建议复习')).toBe(false);
    expect(heartbeatIsSilent('')).toBe(false);
  });

  it('ensure_heartbeat_in_list_is_idempotent', () => {
    const automations = [sampleDaily('09:00')];
    expect(ensureHeartbeatInList(automations, Date.UTC(2026, 6, 8, 12))).toBe(true);
    expect(automations).toHaveLength(2);
    const heartbeat = automations.find((automation) => automation.heartbeat)!;
    expect(heartbeat.id).toBe('auto_heartbeat_default');
    expect(heartbeat.action_type).toBe('agent_turn');
    expect(heartbeat.enabled).toBe(false);
    expect(heartbeat.schedule.interval_minutes).toBe(30);
    expect(() => validateSchedule(heartbeat.schedule)).not.toThrow();
    expect(ensureHeartbeatInList(automations, Date.UTC(2026, 6, 8, 12))).toBe(false);
    expect(automations).toHaveLength(2);
  });

  it('default_heartbeat_prompt_mentions_sentinel', () => {
    expect(DEFAULT_HEARTBEAT_PROMPT).toContain(HEARTBEAT_OK_SENTINEL);
    const item = automationToListItem(defaultHeartbeatDefinition(Date.now()), Date.now());
    expect(item.action_type).toBe('agent_turn');
    expect(item.heartbeat).toBe(true);
  });

  it('full_update_can_clear_nullable_agent_fields', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', {
      action_type: 'agent_turn', agent_prompt: 'agent instructions', session_mode: 'named', model_id: 'model-a',
    });
    saveAutomations(db, [automation]);

    // Rust decodes the UI DTO first: explicit JSON null is Some(None) (clear), not "absent".
    const request = updateFieldsFromRequest({
      automationId: automation.id, expectedVersion: automation.version,
      actionType: 'notify', agentPrompt: null, sessionMode: null, modelId: null,
    } as Parameters<typeof updateFieldsFromRequest>[0], undefined);
    expect(request.agentPrompt).toEqual({ value: null });
    expect(request.sessionMode).toEqual({ value: null });
    expect(request.modelId).toEqual({ value: null });

    const cleared = updateAutomationFull(db, automation.id, automation.version, request).current;
    expect(cleared.action_type).toBe('notify');
    expect(cleared.agent_prompt).toBeNull();
    expect(cleared.session_mode).toBeNull();
    expect(cleared.model_id).toBeNull();

    const renamed = updateAutomationFull(db, automation.id, cleared.version, { name: 'Renamed automation' }).current;
    expect(renamed.name).toBe('Renamed automation');
  });

  it('full_update_rejects_stale_version_without_overwriting_current_value', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const updated = updateAutomationFull(db, automation.id, automation.version, { name: 'First update' }).current;
    let error: unknown;
    try { updateAutomationFull(db, automation.id, automation.version, { name: 'Stale overwrite' }); }
    catch (caught) { error = caught; }
    expect(updated.version).toBe(automation.version + 1);
    expect(error).toMatchObject({ error_type: 'Conflict' });
    const details = (error as { details: Record<string, any> }).details;
    expect(details.code).toBe('AUTOMATION_VERSION_CONFLICT');
    expect(details.expectedVersion).toBe(automation.version);
    expect(details.currentVersion).toBe(updated.version);
    expect(details.current.name).toBe('First update');
    expect(details.current.version).toBe(updated.version);
    // Rust serializes with agent_facing=true (tool executor, blocked by B3); the UI command path
    // (automation_command_error -> serialize_automation_update_error(_, false)) carries the same fields.
    const payload = JSON.parse(automationCommandError(error as AppError).message) as Record<string, any>;
    expect(payload.code).toBe('AUTOMATION_VERSION_CONFLICT');
    expect(payload.current.version).toBe(updated.version);
    const current = loadAutomations(db)[0]!;
    expect(current.name).toBe('First update');
    expect(current.version).toBe(updated.version);
  });

  it('scheduled_claim_is_atomic_and_deduplicated', async () => {
    const { db } = await fixture();
    const now = Date.UTC(2026, 6, 14, 12, 0);
    const scheduledFor = '2026-07-14T09:00:00+00:00';
    const automation = sampleDaily('09:00', { next_run_at: scheduledFor });
    saveAutomations(db, [automation]);

    const first = claimScheduledRun(db, automation.id, scheduledFor, now);
    const second = claimScheduledRun(db, automation.id, scheduledFor, now);
    expect(first?.automation.version).toBe(automation.version);
    expect(second).toBeNull();
    expect(listAutomationRuns(db, automation.id, 10)).toHaveLength(1);
    expect(loadAutomations(db)[0]!.version).toBe(automation.version);
  });

  it('scheduled_claim_waits_for_an_existing_active_run', async () => {
    const { db } = await fixture();
    const now = Date.UTC(2026, 6, 14, 12, 0);
    const scheduledFor = '2026-07-14T09:00:00+00:00';
    const automation = sampleDaily('09:00', { next_run_at: scheduledFor });
    saveAutomations(db, [automation]);
    const active = createManualRun(db, automation.id, automation.version);

    expect(claimScheduledRun(db, automation.id, scheduledFor, now)).toBeNull();
    expect(loadAutomations(db)[0]!.next_run_at).toBe(scheduledFor);
    expect(completeRun(db, active.run_id, active.attempt, 'success', [], null, null, null)).toBe(true);
  });

  it('catch_up_policies_advance_from_the_expected_base', () => {
    const scheduledFor = Date.UTC(2026, 6, 10, 9, 0);
    const now = Date.UTC(2026, 6, 13, 12, 0);
    const automation = sampleDaily('09:00', {
      schedule: schedule('daily', '09:00', { timezone: 'UTC' }), catch_up_policy: 'catch_up_all',
    });
    expect(nextAfterClaim(automation, scheduledFor, now)).toBe('2026-07-11T09:00:00+00:00');
    for (const policy of ['run_once', 'skip'] as const) {
      automation.catch_up_policy = policy;
      expect(nextAfterClaim(automation, scheduledFor, now)).toBe('2026-07-14T09:00:00+00:00');
    }
  });

  it('explicit_retry_adds_an_attempt_and_can_be_claimed', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    completeRun(db, run.run_id, run.attempt, 'error', [], null, null, 'failed');

    setAutomationEnabled(db, automation.id, automation.version, false);
    retryAutomationRun(db, run.run_id);
    const retrying = listAutomationRuns(db, automation.id, 1)[0]!;
    expect(retrying.status).toBe('retrying');
    expect(retrying.max_attempts).toBeGreaterThanOrEqual(2);

    const claimed = claimRetryRun(db, run.run_id);
    expect(claimed?.trigger_type).toBe('retry');
    expect(claimed?.attempt).toBe(2);
    const running = listAutomationRuns(db, automation.id, 1)[0]!;
    expect(running.status).toBe('running');
    expect(running.attempt).toBe(2);
  });

  it('explicit_retry_waits_for_the_cancelled_executor_to_exit', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    const { guard, token } = ActiveAutomationRunGuard.register(run.run_id);

    cancelAutomationRun(db, run.run_id);
    expect(token.signal.aborted).toBe(true);
    retryAutomationRun(db, run.run_id);

    expect(claimRetryRun(db, run.run_id)).toBeNull();
    expect(completeRun(db, run.run_id, run.attempt, 'cancelled', [], null, null, null)).toBe(false);
    expect(listAutomationRuns(db, automation.id, 1)[0]!.status).toBe('retrying');

    guard.release();
    const retry = claimRetryRun(db, run.run_id);
    expect(retry?.attempt).toBe(2);
    expect(completeRun(db, run.run_id, run.attempt, 'error', [], null, null, 'stale executor result')).toBe(false);
    const running = listAutomationRuns(db, automation.id, 1)[0]!;
    expect(running.status).toBe('running');
    expect(running.attempt).toBe(2);
  });

  it('active_run_guard_does_not_remove_a_newer_token', () => {
    const runId = `run_guard_${Date.now()}`;
    const first = ActiveAutomationRunGuard.register(runId);
    const second = ActiveAutomationRunGuard.register(runId);
    expect(first.token.signal.aborted).toBe(false);
    expect(second.token.signal.aborted).toBe(false);

    first.guard.release();
    expect(cancelAutomationRunToken(runId)).toBe(true);
    expect(first.token.signal.aborted).toBe(false);
    expect(second.token.signal.aborted).toBe(true);

    second.guard.release();
    expect(automationRunHasLiveExecutor(runId)).toBe(false);
  });

  it('agent_automation_run_guard_is_single_flight', () => {
    const guard = AgentAutomationRunGuard.tryAcquire('auto_sf_test');
    expect(guard).not.toBeNull();
    expect(AgentAutomationRunGuard.tryAcquire('auto_sf_test')).toBeNull();
    const other = AgentAutomationRunGuard.tryAcquire('auto_sf_other');
    expect(other).not.toBeNull();
    guard!.release();
    expect(AgentAutomationRunGuard.tryAcquire('auto_sf_test')).not.toBeNull();
  });

  it('stale_running_run_is_recovered_into_retry', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', { timeout_seconds: 30 });
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    const staleAt = formatTimestampMillis(Date.now() - 5 * 60_000);
    db.run(`UPDATE automation_runs
      SET claimed_by = 'previous-process', claimed_at = ?2, started_at = ?2,
          lease_expires_at = ?2, retry_requested = 0
      WHERE id = ?1`, [run.run_id, staleAt]);

    expect(recoverStaleAutomationRuns(db)).toBe(1);
    const runs = listAutomationRuns(db, automation.id, 1);
    expect(runs[0]!.status).toBe('retrying');
    expect(runs[0]!.next_attempt_at).not.toBeNull();
  });

  it('stale_run_for_a_disabled_automation_is_cancelled', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00', { timeout_seconds: 30 });
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    setAutomationEnabled(db, automation.id, automation.version, false);
    const staleAt = formatTimestampMillis(Date.now() - 5 * 60_000);
    db.run(`UPDATE automation_runs
      SET claimed_by = 'previous-process', claimed_at = ?2, started_at = ?2,
          lease_expires_at = ?2, retry_requested = 0
      WHERE id = ?1`, [run.run_id, staleAt]);

    expect(recoverStaleAutomationRuns(db)).toBe(1);
    const runs = listAutomationRuns(db, automation.id, 1);
    expect(runs[0]!.status).toBe('cancelled');
    expect(runs[0]!.next_attempt_at).toBeNull();
  });

  it('once_claim_consumes_slot_and_clears_next_run', async () => {
    const { db } = await fixture();
    const now = Date.UTC(2026, 7, 1, 9, 0, 30);
    const automation = sampleDaily('09:00', {
      schedule: schedule('once', '09:00', { date: '2026-08-01', timezone: 'UTC' }),
      next_run_at: '2026-08-01T09:00:00+00:00',
    });
    saveAutomations(db, [automation]);

    const claimed = claimScheduledRun(db, automation.id, '2026-08-01T09:00:00+00:00', now);
    expect(claimed).not.toBeNull();
    expect(claimed!.automation.next_run_at).toBeNull();
    const stored = loadAutomations(db)[0]!;
    expect(stored.next_run_at).toBeNull();
    expect(stored.enabled).toBe(true);

    expect(completeRun(db, claimed!.run_id, claimed!.attempt, 'success', [], null, null, null)).toBe(true);
    const messages: string[] = [];
    const events: string[] = [];
    finalizeOnceAutomation(db, claimed!.automation, {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      emitChanged: (action, automationId) => events.push(`${action}:${automationId}`),
    });
    const finalized = loadAutomations(db)[0]!;
    expect(finalized.enabled).toBe(false);
    expect(finalized.next_run_at).toBeNull();
    expect(events).toEqual(['once_completed:auto_test']);
    expect(messages.some((message) => message.includes('completed; disabled'))).toBe(true);

    // 已 finalized（changed=0）时不得重复广播。
    finalizeOnceAutomation(db, claimed!.automation, {
      emitChanged: (action, automationId) => events.push(`${action}:${automationId}`),
    });
    expect(events).toEqual(['once_completed:auto_test']);
  });

  it('finalize_once_logs_a_warning_when_the_update_fails', async () => {
    const automation = sampleDaily('09:00', {
      schedule: schedule('once', '09:00', { date: '2026-08-01', timezone: 'UTC' }),
    });
    const warnings: string[] = [];
    const failing = { run() { throw new Error('finalize boom'); } } as unknown as DatabaseHandle;
    expect(() => finalizeOnceAutomation(failing, automation, {
      warn: (message) => warnings.push(message),
    })).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Failed to finalize once automation');
    expect(warnings[0]).toContain('finalize boom');
  });

  it('cancel_run_signals_the_active_headless_token', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    const { guard, token } = ActiveAutomationRunGuard.register(run.run_id);

    cancelAutomationRun(db, run.run_id);
    expect(token.signal.aborted).toBe(true);
    guard.release();
  });

  it('cancel_run_cancels_token_before_finalizing_once_automation', async () => {
    // automations.rs:4613-4641：token 取消在查 owner 之后、finalize_once_automation 之前。
    const { db } = await fixture();
    const automation = sampleDaily('09:00', {
      schedule: schedule('once', '09:00', { date: '2026-08-01', timezone: 'UTC' }),
      next_run_at: null, last_run_at: '2026-08-01T09:00:00+00:00',
    });
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    const { guard, token } = ActiveAutomationRunGuard.register(run.run_id);

    let abortedWhenFinalizeRan = false;
    const probe = new Proxy(db, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const result = fn.apply(target, args);
          if (typeof args[0] === 'string' && args[0].includes('SET enabled = 0')) {
            abortedWhenFinalizeRan = token.signal.aborted;
          }
          return result;
        };
      },
    }) as typeof db;

    cancelAutomationRun(probe, run.run_id);
    expect(abortedWhenFinalizeRan).toBe(true);
    expect(token.signal.aborted).toBe(true);
    expect(loadAutomations(db)[0]!.enabled).toBe(false);
    guard.release();
  });

  it('set_enabled_cancels_running_token_after_commit', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    // createManualRun 直接落 running 行。
    const { guard, token } = ActiveAutomationRunGuard.register(run.run_id);

    let abortedInsideTransaction = true;
    const probe = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'transaction') {
          return (fn: (tx: unknown) => unknown, options?: unknown) => {
            let result: unknown;
            const wrapped = (tx: unknown) => {
              result = fn(tx);
              abortedInsideTransaction = token.signal.aborted;
              return result;
            };
            return (Reflect.get(target, 'transaction') as (f: unknown, o?: unknown) => unknown).call(target, wrapped, options) as unknown;
          };
        }
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof db;

    const disabled = setAutomationEnabled(probe, automation.id, automation.version, false);
    expect(disabled.current.enabled).toBe(false);
    expect(abortedInsideTransaction).toBe(false);
    expect(token.signal.aborted).toBe(true);
    guard.release();
  });

  it('list item schedule omits unset optional fields like serde skip_serializing_if', async () => {
    const { db } = await fixture();
    const daily = sampleDaily('09:00');
    saveAutomations(db, [daily]);
    const dailyItem = automationToListItem(loadAutomations(db)[0]!, Date.now());
    expect(dailyItem.schedule).toEqual({ kind: 'daily', time: '09:00' });

    const weekly = sampleDaily('09:00', {
      id: 'auto_weekly', version: 1,
      schedule: schedule('weekly', '09:00', { weekday: 1, weekdays: [1, 3] }),
    });
    saveAutomations(db, [weekly]);
    const weeklyItem = automationToListItem(loadAutomations(db)[0]!, Date.now());
    expect(weeklyItem.schedule).toEqual({ kind: 'weekly', time: '09:00', weekday: 1, weekdays: [1, 3] });
    expect(Object.hasOwn(weeklyItem.schedule as object, 'day_of_month')).toBe(false);
  });

  it('create_automation_preserves_per_step_error_context', async () => {
    const { db } = await fixture();
    const fields = {
      name: 'Daily', prompt: 'p', enabled: true, source_session_id: 'ui',
      schedule: schedule('daily', '09:00'), action_type: 'notify' as const, heartbeat: false,
      agent_prompt: null, session_mode: null, model_id: null, catch_up_policy: 'run_once' as const,
      max_retries: 2, retry_backoff_seconds: 60, timeout_seconds: 600, trusted_profile: null,
    };
    const failingStart = {
      transaction() { throw new Error('begin boom'); },
    } as unknown as DatabaseHandle;
    expect(() => createAutomation(failingStart, fields))
      .toThrow('Failed to start automation create: begin boom');

    db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON automation_definitions BEGIN SELECT RAISE(ABORT, 'insert boom'); END");
    expect(() => createAutomation(db, fields)).toThrow('Failed to insert automation: insert boom');
    db.exec('DROP TRIGGER fail_insert');

    const failingCommitTx = {
      pluck: () => 0,
      run: () => ({ changes: 1 }),
    };
    const failingCommit = {
      transaction(callback: (tx: unknown) => unknown) { callback(failingCommitTx); throw new Error('commit boom'); },
    } as unknown as DatabaseHandle;
    expect(() => createAutomation(failingCommit, fields))
      .toThrow('Failed to commit automation create: commit boom');

    db.exec('DROP TABLE automation_definitions');
    expect(() => createAutomation(db, fields))
      .toThrow(/^Failed to count automations: /);
  });

  it('update_and_delete_preserve_per_step_error_context', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);

    db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON automation_definitions BEGIN SELECT RAISE(ABORT, 'update boom'); END");
    expect(() => updateAutomationFull(db, automation.id, automation.version, { prompt: 'next' }))
      .toThrow('Failed to update automation: update boom');
    db.exec('DROP TRIGGER fail_update');

    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON automation_definitions BEGIN SELECT RAISE(ABORT, 'delete boom'); END");
    expect(() => deleteAutomation(db, automation.id, automation.version))
      .toThrow('Failed to delete automation: delete boom');
    db.exec('DROP TRIGGER fail_delete');

    const failingCommitTx = {
      get: () => ({
        id: automation.id, name: automation.name, schedule_json: '{"kind":"daily","time":"09:00"}',
        prompt: automation.prompt, enabled: 1, created_at: automation.created_at,
        source_session_id: automation.session_id, last_run_at: null, next_run_at: null,
        action_type: 'notify', heartbeat: 0, agent_prompt: null, session_mode: null, model_id: null,
        agent_session_id: null, catch_up_policy: 'run_once', max_retries: 2,
        retry_backoff_seconds: 60, timeout_seconds: 600, trusted_profile_json: null, version: 1,
      }),
      run: () => ({ changes: 1 }),
      pluck: () => 0,
    };
    const failingCommit = {
      transaction(callback: (tx: unknown) => unknown) { callback(failingCommitTx); throw new Error('commit boom'); },
    } as unknown as DatabaseHandle;
    expect(() => deleteAutomation(failingCommit, automation.id, automation.version))
      .toThrow('Failed to commit automation delete: commit boom');
    expect(() => updateAutomationFull(failingCommit, automation.id, automation.version, { prompt: 'next' }))
      .toThrow('Failed to commit automation update: commit boom');
  });

  it('set_enabled_preserves_per_step_error_context', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    createManualRun(db, automation.id, automation.version);

    db.exec("CREATE TRIGGER fail_definitions_update BEFORE UPDATE ON automation_definitions BEGIN SELECT RAISE(ABORT, 'definitions boom'); END");
    expect(() => setAutomationEnabled(db, automation.id, automation.version, false))
      .toThrow('Failed to update automation: definitions boom');
    db.exec('DROP TRIGGER fail_definitions_update');

    db.run("UPDATE automation_runs SET status = 'queued' WHERE automation_id = ?1", [automation.id]);
    db.exec("CREATE TRIGGER fail_runs_update BEFORE UPDATE ON automation_runs BEGIN SELECT RAISE(ABORT, 'runs boom'); END");
    expect(() => setAutomationEnabled(db, automation.id, automation.version, false))
      .toThrow('Failed to cancel pending automation retries: runs boom');
    expect(loadAutomations(db)[0]!.enabled).toBe(true);
  });

  it('due_retry_ids_respects_next_attempt_at', async () => {
    const { db } = await fixture();
    const automation = sampleDaily('09:00');
    saveAutomations(db, [automation]);
    const run = createManualRun(db, automation.id, automation.version);
    completeRun(db, run.run_id, run.attempt, 'error', [], null, null, 'x');
    retryAutomationRun(db, run.run_id);
    expect(dueRetryIds(db, Date.now() + 1000)).toEqual([run.run_id]);
  });

  it('legacy_definition_deserializes_with_defaults', () => {
    const legacy = `{
      "id": "auto_1",
      "name": "old",
      "schedule": { "kind": "daily", "time": "09:00" },
      "prompt": "p",
      "enabled": true,
      "created_at": "2026-01-01T00:00:00Z",
      "session_id": "sess_x"
    }`;
    const definition = parseLegacyDefinition(JSON.parse(legacy));
    expect(definition.action_type).toBe('notify');
    expect(definition.heartbeat).toBe(false);
    expect(definition.schedule.interval_minutes).toBeNull();
    expect(definition.agent_prompt).toBeNull();
    expect(definition.session_mode).toBeNull();
    expect(definition.model_id).toBeNull();
    expect(definition.agent_session_id).toBeNull();
    expect(definition.max_retries).toBe(2);
    expect(definition.version).toBe(1);
  });

  it('legacy_json_migration_is_idempotent_and_retains_snapshot', async () => {
    const { db, settings } = await fixture();
    saveAutomations(db, [sampleDaily('08:00', { id: 'auto_existing' })]);
    const legacy = JSON.stringify([sampleDaily('09:00')]);
    db.run("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, '2026-01-01T00:00:00+00:00')",
      [AUTOMATIONS_KEY, legacy]);

    expect(migrateLegacyAutomations(settings, db, insertAutomation)).toBe(1);
    expect(migrateLegacyAutomations(settings, db, insertAutomation)).toBe(0);
    expect(loadAutomations(db)).toHaveLength(2);
    expect(db.pluck<string>('SELECT value FROM settings WHERE key = ?1', [AUTOMATIONS_KEY])).toBe(legacy);
  });

  it('legacy_json_migration_commits_definitions_before_saving_the_marker', async () => {
    // automations.rs:1223–1266：先读/解析 settings，再开事务插入定义并提交，
    // 提交后才保存 marker。marker 保存失败不能回滚已提交的定义。
    const { db } = await fixture();
    const values = new Map<string, string>([
      [AUTOMATIONS_KEY, JSON.stringify([sampleDaily('09:00')])],
    ]);
    const settings = {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => {
        if (key === AUTOMATION_LEGACY_MIGRATED_KEY) throw new Error('settings write failed');
        values.set(key, value);
      },
    };

    expect(() => migrateLegacyAutomations(settings, db, insertAutomation))
      .toThrow('settings write failed');
    expect(loadAutomations(db)).toHaveLength(1);
    expect(values.has(AUTOMATION_LEGACY_MIGRATED_KEY)).toBe(false);
  });

  it('legacy_json_migration_reads before the transaction and saves the marker after commit', async () => {
    const { db } = await fixture();
    const order: string[] = [];
    const values = new Map<string, string>([
      [AUTOMATIONS_KEY, JSON.stringify([sampleDaily('09:00')])],
    ]);
    const settings = {
      get: (key: string) => {
        order.push(`read:${key}`);
        return values.get(key) ?? null;
      },
      save: (key: string, value: string) => {
        order.push(`save:${key}`);
        values.set(key, value);
      },
    };
    const wrapped = new Proxy(db, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (key === 'transaction') {
          return (...args: unknown[]) => {
            order.push('transaction');
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as DatabaseHandle;
    const insert = (tx: SqlExecutor, automation: AutomationDefinition) => {
      order.push('insert');
      insertAutomation(tx, automation);
    };

    expect(migrateLegacyAutomations(settings, wrapped, insert)).toBe(1);
    expect(order).toEqual([
      `read:${AUTOMATION_LEGACY_MIGRATED_KEY}`,
      `read:${AUTOMATIONS_KEY}`,
      'transaction',
      'insert',
      `save:${AUTOMATION_LEGACY_MIGRATED_KEY}`,
    ]);
  });

  it('legacy_json_migration_reads_the_marker_before_parsing', async () => {
    const { db } = await fixture();
    const settings = {
      get: (key: string) => key === AUTOMATION_LEGACY_MIGRATED_KEY ? 'true' : '{not json',
      save: () => { throw new Error('must not save'); },
    };
    expect(migrateLegacyAutomations(settings, db, insertAutomation)).toBe(0);
    expect(loadAutomations(db)).toHaveLength(0);
  });
});
