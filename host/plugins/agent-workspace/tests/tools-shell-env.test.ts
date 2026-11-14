import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  buildEnvPlan, buildEnvPlanWithInheritDefault, envPolicyFacts, envPolicyJson,
  isSensitiveEnvKey, platformMinimalEnvKeys, sanitizePathValue, skillDirInjectionFromRoot,
  type ShellEnvPlan,
} from '../src/tools/shell-env.ts';
import type { RuntimeRoot } from '../api.ts';

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-env-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function withEnv(values: Record<string, string>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function root(overrides: Partial<RuntimeRoot>): RuntimeRoot {
  return {
    id: 'skill:pdf-tools', kind: 'skill_package', path: '/tmp', access: 'read_only',
    label: 'Skill', description: '', session_scoped: false, configured: false,
    ...overrides,
  };
}

it('env_plan_inherit_default_only_applies_when_requested', () => {
  const sandbox = buildEnvPlan({});
  expect(sandbox.inherit_parent_env).toBe(false);
  const full = buildEnvPlanWithInheritDefault({}, true);
  expect(full.inherit_parent_env).toBe(true);
  expect(full.allowlist_mode).toBe(false);
  const explicit = buildEnvPlanWithInheritDefault({ inherit_env: false }, true);
  expect(explicit.inherit_parent_env).toBe(false);
  expect(explicit.allowlist_mode).toBe(true);
});

it('env_plan_full_access_inherit_still_strips_sensitive_keys', () => {
  const sentinel = 'DS_TEST_PLAIN_VAR_FOR_ENV_PLAN';
  withEnv({ [sentinel]: 'visible', DS_TEST_SECRET_TOKEN_FOR_ENV_PLAN: 'hidden' }, () => {
    const plan = buildEnvPlanWithInheritDefault({}, true);
    expect(plan.inherited_values.has(sentinel)).toBe(true);
    expect(plan.inherited_values.has('DS_TEST_SECRET_TOKEN_FOR_ENV_PLAN')).toBe(false);
  });
});

it('env_policy_blocks_explicit_sensitive_values', () => {
  expect(() => buildEnvPlan({ env: { OPENAI_API_KEY: 'secret' } }))
    .toThrow(/blocked by the shell env policy/);
});

it('sensitive_env_key_detection_uses_credential_boundaries', () => {
  for (const key of [
    'AUTH', 'HTTP_AUTH', 'AUTHORIZATION', 'REQUEST_COOKIE', 'SESSION', 'GITHUB_PAT',
    'SENTRY_DSN', 'APP_SIGNING_KEY', 'DATABASE_URL', 'PRIMARY_DATABASE_URL', 'HTTP_PROXY',
    'CORPORATE_PROXY_URL', 'AWS_SECRET_ACCESS_KEY', 'SERVICE_TOKEN', 'ADMIN_PASSWORD',
  ]) {
    expect(isSensitiveEnvKey(key), key).toBe(true);
  }
  for (const key of [
    'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'AUTHOR', 'AUTH0_DOMAIN', 'COMPAT_MODE',
    'TOKENIZERS_PARALLELISM', 'DATABASE_POOL_SIZE', 'NO_PROXY',
  ]) {
    expect(isSensitiveEnvKey(key), key).toBe(false);
  }
});

it('env_allowlist_rejects_new_sensitive_key_families', () => {
  for (const key of [
    'AUTHORIZATION', 'REQUEST_COOKIE', 'LOGIN_SESSION', 'GITHUB_PAT', 'SENTRY_DSN',
    'APP_SIGNING_KEY', 'DATABASE_URL', 'HTTPS_PROXY',
  ]) {
    expect(() => buildEnvPlan({ env_allowlist: [key] })).toThrow(key);
  }
});

it('env_policy_defaults_to_minimal_inheritance', () => {
  const plan = buildEnvPlan({});
  expect(plan.inherit_parent_env).toBe(false);
  expect(plan.allowlist_mode).toBe(true);
  const minimal = platformMinimalEnvKeys();
  expect(plan.inherited_keys.every(key => minimal.some(value => value.toUpperCase() === key.toUpperCase())))
    .toBe(true);
  const facts = envPolicyFacts({});
  expect(facts.inherit_parent_env).toBe(false);
  expect(facts.plan_hash).toHaveLength(64);
});

it('env_plan_hash_changes_with_redacted_values_without_exposing_them', () => {
  const first = envPolicyFacts({ env: { MODE: 'first-secret-value' } });
  const second = envPolicyFacts({ env: { MODE: 'second-secret-value' } });
  expect(first.plan_hash).not.toBe(second.plan_hash);
  const rendered = JSON.stringify(first);
  expect(rendered).not.toContain('first-secret-value');
  expect(first.explicit_keys).toEqual(['MODE']);
});

it('env_policy_blocks_execution_control_and_path_overrides', () => {
  for (const key of [
    'BASH_ENV', 'ENV', 'COMSPEC', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'NODE_OPTIONS',
    'PYTHONPATH', 'DEVELOPER_DIR', 'RUSTC_WRAPPER', 'GIT_EXTERNAL_DIFF', 'PATH', 'Path',
    'PATHEXT',
  ]) {
    expect(() => buildEnvPlan({ env: { [key]: 'payload' } })).toThrow(/blocked by the shell env policy/);
  }
  expect(() => buildEnvPlan({ env_allowlist: ['NODE_OPTIONS'] })).toThrow(/NODE_OPTIONS/);
});

it('inherited_path_drops_empty_and_relative_entries', () => {
  const joined = ['', 'relative/bin', '/usr/bin', '/usr/bin', '/bin'].join(path.delimiter);
  const sanitized = sanitizePathValue(joined);
  const paths = sanitized.split(path.delimiter);
  expect(paths).toEqual(['/usr/bin', '/bin']);
  expect(paths.every(entry => path.isAbsolute(entry))).toBe(true);
});

it('env_policy_uses_allowlist_mode_without_values_in_audit', () => {
  const plan = buildEnvPlan({ inherit_env: false, env_allowlist: ['PATH'], env: { NODE_ENV: 'test' } });
  const audit = envPolicyJson(plan, null) as Record<string, unknown>;
  expect(plan.inherit_parent_env).toBe(false);
  expect(plan.allowlist_mode).toBe(true);
  expect(plan.explicit_keys).toContain('NODE_ENV');
  expect(audit.redacted).toBe(true);
  expect(JSON.stringify(audit)).not.toContain('test');
  expect(audit.injected_skill_dir).toBeNull();
});

it('injects_skill_dir_for_skill_package_roots_and_audits_without_path', () => {
  const directory = tmp();
  const injection = skillDirInjectionFromRoot(root({ path: directory }));
  expect(injection.root_id).toBe('skill:pdf-tools');
  expect(injection.path).toBe(fs.realpathSync.native(directory));
  const plan: ShellEnvPlan = buildEnvPlan({});
  const audit = envPolicyJson(plan, injection) as Record<string, unknown>;
  const injected = audit.injected_skill_dir as Record<string, unknown>;
  expect(injected.variable).toBe('SKILL_DIR');
  expect(injected.root_id).toBe('skill:pdf-tools');
  expect(JSON.stringify(audit)).not.toContain(directory);
});

it('rejects_skill_dir_injection_for_non_skill_roots', () => {
  const directory = tmp();
  expect(() => skillDirInjectionFromRoot(root({ id: 'workspace', kind: 'workspace', path: directory })))
    .toThrow(/not a skill package root/);
});
