import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DUPLICATE_CODE, AUTOMATION_OCC_REQUIRED_CODE, AUTOMATION_RUN_ALREADY_ACTIVE_CODE,
  annotateOnceCompleted, automationSensitivityLevel, automationSensitivityLevelForCall,
  canHandleAutomationTool, describeSchedule, friendlyAutomationError,
  hasDynamicAutomationSensitivity, parseActionType, parseAgentFields, parseCatchUpPolicy,
  parseNullableSessionMode, parseNullableString, parseOptionalU64, parseRequiredVersion,
  parseToolSchedule, provided, rejectUnknownFields, PROPOSE_ALLOWED_KEYS,
} from '../src/automation-tool-args.ts';

describe('automation_executor.rs tool argument parsing', () => {
  it('rejects_unknown_propose_fields', () => {
    expect(() => rejectUnknownFields({
      name: 'n', schedule: { kind: 'daily', time: '09:00' }, prompt: 'p', extra: true,
    }, PROPOSE_ALLOWED_KEYS)).toThrow('Unknown field');
  });

  it('rejects_invalid_schedule_time', () => {
    let message = '';
    try { parseToolSchedule({ kind: 'daily', time: '9:00' }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message.includes('HH:MM') || message.includes('Invalid time')).toBe(true);
  });

  it('rejects_weekly_without_weekday', () => {
    expect(() => parseToolSchedule({ kind: 'weekly', time: '09:00' })).toThrow(/weekday/);
  });

  it('parses_interval_schedule_without_time', () => {
    const schedule = parseToolSchedule({ kind: 'interval', interval_minutes: 30 });
    expect(schedule.kind).toBe('interval');
    expect(schedule.interval_minutes).toBe(30);
  });

  it('interval_schedule_ignores_documented_ignored_time', () => {
    const schedule = parseToolSchedule({ kind: 'interval', time: '09:00', interval_minutes: 30 });
    expect(schedule.time).toBe('');
    expect(schedule.interval_minutes).toBe(30);
  });

  it('tolerates_null_optionals_and_string_integers', () => {
    expect(parseActionType({ action_type: null })).toBe('notify');
    expect(parseCatchUpPolicy({ catch_up_policy: null }, true)).toBe('run_once');
    expect(parseOptionalU64({ max_retries: null }, 'max_retries', 0, 10)).toBeNull();
    expect(parseAgentFields({ agent_prompt: null, session_mode: null, model_id: null }, 'notify'))
      .toEqual({ agentPrompt: null, sessionMode: null, modelId: null });
    expect(parseRequiredVersion({ expected_version: '7' })).toBe(7);
    expect(parseToolSchedule({ kind: 'weekly', time: '09:00', weekday: '3' }).weekday).toBe(3);
    expect(() => parseRequiredVersion({ expected_version: 'abc' })).toThrow();
  });

  it('update_parsers_treat_null_name_schedule_prompt_as_absent', () => {
    expect(provided({ name: null }, 'name')).toBeUndefined();
    expect(provided({ schedule: null }, 'schedule')).toBeUndefined();
    expect(provided({ prompt: null }, 'prompt')).toBeUndefined();
    expect(provided({ name: 'x' }, 'name')).toBe('x');
  });

  it('parses_monthly_and_weekday_schedules_with_timezone', () => {
    const monthly = parseToolSchedule({
      kind: 'monthly', time: '09:00', day_of_month: 31, timezone: 'Asia/Shanghai',
    });
    expect(monthly.kind).toBe('monthly');
    expect(monthly.day_of_month).toBe(31);
    expect(monthly.timezone).toBe('Asia/Shanghai');
    expect(parseToolSchedule({ kind: 'weekdays', time: '08:30', timezone: 'UTC' }).kind).toBe('weekdays');
  });

  it('rejects_interval_without_minutes', () => {
    expect(() => parseToolSchedule({ kind: 'interval' })).toThrow(/interval_minutes/);
  });

  it('parses_once_schedule_with_date', () => {
    const schedule = parseToolSchedule({ kind: 'once', time: '09:00', date: '2099-01-02' });
    expect(schedule.kind).toBe('once');
    expect(schedule.date).toBe('2099-01-02');
  });

  it('rejects_once_schedule_without_date', () => {
    expect(() => parseToolSchedule({ kind: 'once', time: '09:00' })).toThrow(/date/);
  });

  it('describes_schedules_in_natural_language', () => {
    expect(describeSchedule(parseToolSchedule({ kind: 'daily', time: '21:00' }))).toContain('每天 21:00');
    const text = describeSchedule(parseToolSchedule({ kind: 'once', time: '09:00', date: '2099-01-02' }));
    expect(text).toContain('2099-01-02');
    expect(text).toContain('一次');
  });

  it('once_completed_derives_from_structured_facts', () => {
    const base = () => ({ schedule: { kind: 'once', time: '09:00', date: '2026-01-02' } });

    const consumed = { ...base(), last_run_at: '2026-01-02T09:00:00+08:00', next_trigger_at: null };
    annotateOnceCompleted(consumed);
    expect((consumed as Record<string, unknown>).once_completed).toBe(true);

    const pending = { ...base(), next_trigger_at: '2099-01-02T09:00:00+08:00' };
    annotateOnceCompleted(pending);
    expect((pending as Record<string, unknown>).once_completed).toBe(false);

    const unknown = { ...base(), last_run_at: '2026-01-02T09:00:00+08:00', next_trigger_at: 'unknown' };
    annotateOnceCompleted(unknown);
    expect((unknown as Record<string, unknown>).once_completed).toBe(false);

    const disabled = { ...base(), next_trigger_at: null };
    annotateOnceCompleted(disabled);
    expect((disabled as Record<string, unknown>).once_completed).toBe(false);

    const daily = { schedule: { kind: 'daily', time: '09:00' }, next_trigger_at: null };
    annotateOnceCompleted(daily);
    expect(Object.hasOwn(daily, 'once_completed')).toBe(false);
  });

  it('friendly_error_adds_hint_for_known_codes', () => {
    const conflict = JSON.parse(friendlyAutomationError(JSON.stringify({
      code: 'AUTOMATION_VERSION_CONFLICT', message: 'conflict',
    }))) as Record<string, unknown>;
    expect(conflict.hint).toContain('automation_list');

    const active = JSON.parse(friendlyAutomationError(JSON.stringify({
      code: AUTOMATION_RUN_ALREADY_ACTIVE_CODE, message: 'active',
    }))) as Record<string, unknown>;
    expect(active.hint).toContain('automation_runs');

    expect(friendlyAutomationError('Automation limit reached (max 20)')).toContain('automation_list');

    const duplicate = JSON.parse(friendlyAutomationError(JSON.stringify({
      code: AUTOMATION_DUPLICATE_CODE, message: 'duplicate',
    }))) as Record<string, unknown>;
    expect(duplicate.hint).toContain('name');

    expect(friendlyAutomationError("Automation 'auto_x' not found")).toContain('automation_list');
  });

  it('parses_action_type_with_default_notify', () => {
    expect(parseActionType({})).toBe('notify');
    expect(parseActionType({ action_type: 'agent_turn' })).toBe('agent_turn');
    expect(parseActionType({ action_type: 'notify' })).toBe('notify');
    expect(() => parseActionType({ action_type: 'bogus' })).toThrow();
    expect(() => parseActionType({ action_type: 1 })).toThrow();
  });

  it('parses_agent_fields_for_agent_turn', () => {
    expect(parseAgentFields({
      agent_prompt: '检查到期复习卡并生成今日复习简报',
      session_mode: 'named',
      model_id: 'builtin-deepseek-chat',
    }, 'agent_turn')).toEqual({
      agentPrompt: '检查到期复习卡并生成今日复习简报',
      sessionMode: 'named',
      modelId: 'builtin-deepseek-chat',
    });
  });

  it('rejects_agent_fields_for_notify_action', () => {
    expect(() => parseAgentFields({ agent_prompt: 'p' }, 'notify')).toThrow(/agent_turn/);
  });

  it('rejects_invalid_session_mode', () => {
    let message = '';
    try { parseAgentFields({ session_mode: 'shared' }, 'agent_turn'); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message.includes('session_mode') || message.includes('isolated')).toBe(true);
  });

  it('enum parse errors echo the trimmed ASCII-lowercased value like Rust', () => {
    // automations.rs:236-246/519-528, headless.rs:1178-1186, automation_executor.rs:342-359 format `other`.
    expect(() => parseCatchUpPolicy({ catch_up_policy: ' NEVER ' }, false))
      .toThrow("Invalid catch_up_policy 'never'. Allowed: skip, run_once, catch_up_all");
    expect(() => parseAgentFields({ session_mode: ' Shared ' }, 'agent_turn'))
      .toThrow("Invalid session_mode 'shared'. Allowed: isolated, named");
    expect(() => parseNullableSessionMode({ session_mode: 'SHARED' }))
      .toThrow("Invalid session_mode 'shared'. Allowed: isolated, named");
    expect(() => parseToolSchedule({ kind: ' Yearly ' }))
      .toThrow("Invalid schedule.kind 'yearly'. Allowed: daily, weekly, weekdays, monthly, interval, once");
    expect(() => parseToolSchedule({ time: '09:00' })).toThrow("'schedule.kind' is required");
    // to_ascii_lowercase leaves non-ASCII letters alone; JS toLowerCase would fold 'İ'.
    expect(() => parseActionType({ action_type: 'NOTİFY' }))
      .toThrow("Invalid action_type 'notİfy'. Allowed: notify, agent_turn");
  });

  it('blank_agent_prompt_falls_back_to_none', () => {
    expect(parseAgentFields({ agent_prompt: '  ' }, 'agent_turn').agentPrompt).toBeNull();
  });

  it('update_requires_a_positive_expected_version', () => {
    let missing = '';
    try { parseRequiredVersion({ id: 'auto_test', name: 'Renamed' }); }
    catch (error) { missing = error instanceof Error ? error.message : String(error); }
    expect(missing).toContain('expected_version');
    expect(missing).toContain('automation_list');
    expect(() => parseRequiredVersion({ expected_version: 0 })).toThrow();
    expect(parseRequiredVersion({ expected_version: 7 })).toBe(7);
  });

  it('update_parsers_preserve_missing_and_clear_empty_values', () => {
    expect(parseNullableString({}, 'model_id', null)).toBeUndefined();
    expect(parseNullableString({ model_id: '' }, 'model_id', null)).toEqual({ value: null });
    expect(parseNullableSessionMode({ session_mode: null })).toEqual({ value: null });
    expect(parseCatchUpPolicy({ catch_up_policy: 'catch_up_all' }, false)).toBe('catch_up_all');
  });

  it('handles_expected_tool_names', () => {
    for (const name of ['automation_propose', 'builtin-automation_list', 'builtin-automation_set_enabled',
      'automation_update', 'builtin-automation_delete', 'builtin-automation_run_now',
      'builtin-automation_runs', 'builtin-automation_retry_run', 'builtin-automation_cancel_run']) {
      expect(canHandleAutomationTool(name)).toBe(true);
    }
    expect(canHandleAutomationTool('automation_unknown')).toBe(false);
  });

  it('sensitivity_levels', () => {
    expect(automationSensitivityLevel('automation_propose')).toBe('High');
    expect(automationSensitivityLevel('automation_set_enabled')).toBe('Medium');
    expect(automationSensitivityLevel('automation_list')).toBe('Low');
    expect(automationSensitivityLevel('automation_update')).toBe('Medium');
    expect(automationSensitivityLevel('automation_run_now')).toBe('Medium');
    expect(automationSensitivityLevel('automation_delete')).toBe('High');
    expect(automationSensitivityLevel('automation_runs')).toBe('Low');
    expect(automationSensitivityLevel('automation_retry_run')).toBe('Medium');
    expect(automationSensitivityLevel('automation_cancel_run')).toBe('Medium');
  });

  it('update_with_trusted_profile_escalates_to_high_sensitivity', () => {
    expect(hasDynamicAutomationSensitivity('builtin-automation_update')).toBe(true);
    expect(hasDynamicAutomationSensitivity('builtin-automation_run_now')).toBe(false);
    expect(automationSensitivityLevelForCall('builtin-automation_update',
      { id: 'a', expected_version: 1, trusted_profile: { schemaVersion: 1 } })).toBe('High');
    expect(automationSensitivityLevelForCall('builtin-automation_update',
      { id: 'a', expected_version: 1, trusted_profile: null })).toBe('Medium');
    expect(automationSensitivityLevelForCall('builtin-automation_update',
      { id: 'a', expected_version: 1, name: 'n' })).toBe('Medium');
  });

  it('missing_expected_version_returns_structured_occ_required_error', () => {
    let raw = '';
    try { parseRequiredVersion({}); }
    catch (error) { raw = error instanceof Error ? error.message : String(error); }
    const error = JSON.parse(raw) as Record<string, unknown>;
    expect(error.code).toBe(AUTOMATION_OCC_REQUIRED_CODE);
    expect(error.requiredField).toBe('expected_version');
    expect(error.retryable).toBe(false);
  });
});
