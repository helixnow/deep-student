import { describe, expect, it } from 'vitest';

import { PLUGIN_LOAD_CODES } from '../../../../host/kernel/plugin-load-error';
import { UiErrorBudget } from '@/ui-kernel/services/errors';

import { CONSENT_REQUIRED_KEY, DEGRADED_CODE_KEYS, autoUninstalled, degradeCodeLabel, degradedCodeKey, errorBudgetOf, parsePluginReason } from '../reasons';

describe('parsePluginReason', () => {
  it('splits known code prefixes and keeps the rest as detail', () => {
    expect(parsePluginReason('CONFIG_INVALID: enabled must be a boolean')).toEqual({
      code: 'CONFIG_INVALID',
      detail: 'enabled must be a boolean',
    });
  });

  it('keeps legacy free-form reasons without inventing a code', () => {
    expect(parsePluginReason('missing service __svc_x')).toEqual({ detail: 'missing service __svc_x' });
    expect(parsePluginReason('LOWER_CASE: nope')).toEqual({ detail: 'LOWER_CASE: nope' });
  });
});

describe('degradedCodeKey', () => {
  it('maps the host codes and the W17 CONSENT_REQUIRED code to locale keys', () => {
    expect(degradedCodeKey('CONFIG_INVALID')).toBe('config_invalid');
    expect(degradedCodeKey('CONSENT_REQUIRED')).toBe(CONSENT_REQUIRED_KEY);
    expect(degradeCodeLabel((key) => `t:${key}`, 'CONSENT_REQUIRED')).toBe('t:degraded.code.consent_required');
    expect(degradeCodeLabel((key) => `t:${key}`, undefined)).toBeUndefined();
  });
});

describe('DEGRADED_CODE_KEYS', () => {
  it('covers every Host load code exactly once', () => {
    expect(Object.keys(DEGRADED_CODE_KEYS).sort()).toEqual([...PLUGIN_LOAD_CODES].sort());
    expect(new Set(Object.values(DEGRADED_CODE_KEYS)).size).toBe(PLUGIN_LOAD_CODES.length);
  });
});

describe('error budget view', () => {
  it('reports the community threshold and the errors that exhausted it', () => {
    const budget = new UiErrorBudget({ community: 3 }, () => undefined, () => 7);
    budget.report({ pluginId: 'community.bad', origin: 'community', phase: 'render', error: new Error('boom') });
    budget.report({ pluginId: 'community.bad', origin: 'community', phase: 'render', error: new Error('boom') });
    budget.report({ pluginId: 'community.bad', origin: 'community', phase: 'render', error: new Error('boom') });

    expect(autoUninstalled(budget)).toEqual([{ pluginId: 'community.bad', errors: 3, budget: 3 }]);
    expect(errorBudgetOf(budget, 'community.bad', 'community')).toEqual({ errors: 3, budget: 3 });
    expect(errorBudgetOf(null, 'community.bad', 'community')).toBeNull();
  });

  it('does not pretend official plugins have a finite budget', () => {
    const budget = new UiErrorBudget({}, () => undefined, () => 7);
    budget.report({ pluginId: 'dstu.ui.chat', origin: 'builtin', phase: 'render', error: new Error('boom') });

    expect(errorBudgetOf(budget, 'dstu.ui.chat', 'builtin')).toBeNull();
  });
});
