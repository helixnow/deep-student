import { expect, it } from 'vitest';
import {
  FeatureFlagManager,
  FeatureState,
  disableFlag,
  enableFlag,
  featureRolloutBucket,
  newFeatureFlag,
  setGradual,
  setUserSpecific,
} from '../feature-flags.ts';

it('test_feature_flag_creation', () => {
  const flag = newFeatureFlag('test.feature', 'Test feature', 'test');
  expect(flag.name).toBe('test.feature');
  expect(flag.state).toBe(FeatureState.Disabled);
  expect(flag.category).toBe('test');
});

it('test_feature_flag_state_changes', () => {
  let flag = enableFlag(newFeatureFlag('test.feature', 'Test feature', 'test'));
  expect(flag.state).toBe(FeatureState.Enabled);

  flag = disableFlag(flag);
  expect(flag.state).toBe(FeatureState.Disabled);

  flag = setGradual(flag, 0.5);
  expect(flag.state).toEqual(FeatureState.Gradual(0.5));
});

it('test_feature_flag_manager', () => {
  const manager = new FeatureFlagManager('1.0.0').withUserId('test_user');
  manager.initializeDefaultFlags();

  expect(manager.isFeatureEnabled('security.keychain_storage')).toBe(true);
  expect(manager.isFeatureEnabled('security.auto_migration')).toBe(true);
  expect(manager.isFeatureEnabled('search.reranker')).toBe(false);
});

it('hash_user_for_feature_matches_rust_default_hasher', () => {
  expect(featureRolloutBucket('test_user', 'test.gradual')).toBe(0.3344);
  expect(featureRolloutBucket('alice', 'observability.performance_metrics')).toBe(0.3774);
  expect(featureRolloutBucket('', 'empty.feature')).toBe(0.3422);
  expect(featureRolloutBucket('用户一', '灰度.功能')).toBe(0.5284);
  expect(featureRolloutBucket('bob', 'x')).toBe(0.2475);
});

it('test_gradual_rollout', () => {
  const manager = new FeatureFlagManager('1.0.0').withUserId('test_user');

  const zero = setGradual(newFeatureFlag('test.gradual', 'Gradual test', 'test'), 0.0);
  manager.flags.set('test.gradual', zero);
  expect(manager.isFeatureEnabled('test.gradual')).toBe(false);

  const full = setGradual(newFeatureFlag('test.gradual2', 'Gradual test 2', 'test'), 1.0);
  manager.flags.set('test.gradual2', full);
  expect(manager.isFeatureEnabled('test.gradual2')).toBe(true);
});

it('test_user_specific_flags', () => {
  const manager = new FeatureFlagManager('1.0.0').withUserId('allowed_user');

  const flag = setUserSpecific(
    newFeatureFlag('test.user_specific', 'User specific test', 'test'),
    ['allowed_user', 'another_user'],
  );
  manager.flags.set('test.user_specific', flag);
  expect(manager.isFeatureEnabled('test.user_specific')).toBe(true);

  manager.user_id = 'not_allowed_user';
  expect(manager.isFeatureEnabled('test.user_specific')).toBe(false);
});

it('workbench_browser_flags_defaults', () => {
  const manager = new FeatureFlagManager('1.0.0', true);
  manager.initializeDefaultFlags();

  const browser = manager.getFeatureFlag('ui.workbench_browser');
  expect(browser).toBeDefined();
  expect(browser?.state).toBe(FeatureState.Enabled);

  const agent = manager.getFeatureFlag('tools.browser_agent');
  expect(agent).toBeDefined();
  expect(agent?.state).toBe(FeatureState.Disabled);
  expect(agent?.dependencies).toEqual(['ui.workbench_browser']);
  expect(manager.isFeatureEnabled('tools.browser_agent')).toBe(false);

  const workbenchAgent = manager.getFeatureFlag('tools.workbench_agent');
  expect(workbenchAgent).toBeDefined();
  expect(workbenchAgent?.state).toBe(FeatureState.Enabled);
  expect(manager.isFeatureEnabled('tools.workbench_agent')).toBe(true);
});

it('merge_missing_defaults_adds_enabled_workbench_agent', () => {
  const manager = new FeatureFlagManager('1.0.0');
  manager.mergeMissingDefaultFlags();

  const flag = manager.getFeatureFlag('tools.workbench_agent');
  expect(flag).toBeDefined();
  expect(flag?.state).toBe(FeatureState.Enabled);
  expect(manager.isFeatureEnabled('tools.workbench_agent')).toBe(true);
});

it('merge_missing_defaults_preserves_disabled_workbench_agent', () => {
  const manager = new FeatureFlagManager('1.0.0');
  manager.flags.set(
    'tools.workbench_agent',
    disableFlag(newFeatureFlag('tools.workbench_agent', 'ChatV2 Agent 操控学习桌面', 'tools')),
  );

  manager.mergeMissingDefaultFlags();

  const flag = manager.getFeatureFlag('tools.workbench_agent');
  expect(flag).toBeDefined();
  expect(flag?.state).toBe(FeatureState.Disabled);
  expect(manager.isFeatureEnabled('tools.workbench_agent')).toBe(false);
});
