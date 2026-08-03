/**
 * skillLifecycleBridge — 后端 skill_lifecycle_executor 前端桥契约
 *
 * 验证：请求/响应 correlationId 回显、describe 元信息、set_enabled 经
 * skillEnableStorage 正门落地并广播、trust_grant 走 setSkillTrustOverride
 * 正门（后端 chat_v2_set_skill_trust + UI 指纹）、builtin 拒绝、未知命令拒绝。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock, emitMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  emitMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
  emit: emitMock,
}));

import { skillRegistry } from '../registry';
import { isSkillDisabled, SKILL_ENABLED_CHANGED_EVENT } from '../skillEnableStorage';
import type { SkillDefinition } from '../types';

type BridgeHandler = (event: { payload: unknown }) => Promise<void> | void;

const globalSkill: SkillDefinition = {
  id: 'external-tools',
  name: 'External Tools',
  description: 'External tools',
  version: '1.0.0',
  content: '---\nname: external-tools\n---\nBody',
  location: 'global',
  sourcePath: '/tmp/skills/external-tools/SKILL.md',
  packageRoot: '/tmp/skills/external-tools',
  trustStatus: 'untrusted',
  embeddedTools: [],
};

const builtinSkill: SkillDefinition = {
  id: 'self-service-tools',
  name: 'self-service-tools',
  description: 'builtin skill',
  version: '1.0.0',
  content: '---\nname: self-service-tools\n---\nBody',
  location: 'builtin',
  sourcePath: 'builtin://self-service-tools',
  isBuiltin: true,
  trustStatus: 'builtin',
  embeddedTools: [],
};

let bridgeHandler: BridgeHandler | null = null;

async function dispatch(request: unknown): Promise<{ ok: boolean; data?: any; error?: string }> {
  emitMock.mockClear();
  expect(bridgeHandler).not.toBeNull();
  await bridgeHandler!({ payload: request });
  expect(emitMock).toHaveBeenCalledTimes(1);
  const [eventName, response] = emitMock.mock.calls[0] as [string, any];
  const correlationId = (request as { correlationId: string }).correlationId;
  expect(eventName).toBe(`skill-lifecycle-bridge-response:${correlationId}`);
  expect(response.correlationId).toBe(correlationId);
  return response;
}

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  listenMock.mockImplementation((eventName: string, handler: BridgeHandler) => {
    if (eventName === 'skill-lifecycle-bridge-request') {
      bridgeHandler = handler;
    }
    return Promise.resolve(() => undefined);
  });
  emitMock.mockResolvedValue(undefined);

  const { setupSkillLifecycleBridge } = await import('../skillLifecycleBridge');
  setupSkillLifecycleBridge();
  await vi.waitFor(() => {
    expect(bridgeHandler).not.toBeNull();
  });
});

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  skillRegistry.clear();
  skillRegistry.register({ ...globalSkill });
  skillRegistry.register({ ...builtinSkill });
});

describe('skillLifecycleBridge describe', () => {
  it('returns registry metadata for a known skill', async () => {
    const response = await dispatch({
      correlationId: 'corr-describe-1',
      command: 'describe',
      args: { skillId: 'external-tools' },
    });
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      found: true,
      skillId: 'external-tools',
      isBuiltin: false,
      disabled: false,
      packageRoot: '/tmp/skills/external-tools',
    });
  });

  it('reports found:false without failing for unknown skills', async () => {
    const response = await dispatch({
      correlationId: 'corr-describe-2',
      command: 'describe',
      args: { skillId: 'missing-skill' },
    });
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ found: false, skillId: 'missing-skill' });
  });
});

describe('skillLifecycleBridge set_enabled', () => {
  it('lands the disable override via skillEnableStorage and broadcasts the change', async () => {
    const events: Array<{ skillId: string; disabled: boolean }> = [];
    const onChanged = (event: Event) => {
      events.push((event as CustomEvent<{ skillId: string; disabled: boolean }>).detail);
    };
    window.addEventListener(SKILL_ENABLED_CHANGED_EVENT, onChanged);
    try {
      const disable = await dispatch({
        correlationId: 'corr-set-1',
        command: 'set_enabled',
        args: { skillId: 'external-tools', enabled: false },
      });
      expect(disable.ok).toBe(true);
      expect(disable.data).toMatchObject({
        skillId: 'external-tools',
        enabled: false,
        previousDisabled: false,
      });
      expect(isSkillDisabled('external-tools')).toBe(true);

      const enable = await dispatch({
        correlationId: 'corr-set-2',
        command: 'set_enabled',
        args: { skillId: 'external-tools', enabled: true },
      });
      expect(enable.ok).toBe(true);
      expect(enable.data).toMatchObject({ previousDisabled: true });
      expect(isSkillDisabled('external-tools')).toBe(false);

      expect(events).toEqual([
        { skillId: 'external-tools', disabled: true },
        { skillId: 'external-tools', disabled: false },
      ]);
    } finally {
      window.removeEventListener(SKILL_ENABLED_CHANGED_EVENT, onChanged);
    }
  });

  it('rejects unknown skills and non-boolean enabled', async () => {
    const unknown = await dispatch({
      correlationId: 'corr-set-3',
      command: 'set_enabled',
      args: { skillId: 'missing-skill', enabled: false },
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('missing-skill');

    const badFlag = await dispatch({
      correlationId: 'corr-set-4',
      command: 'set_enabled',
      args: { skillId: 'external-tools' },
    });
    expect(badFlag.ok).toBe(false);
    expect(badFlag.error).toContain('enabled');
  });
});

describe('skillLifecycleBridge trust_grant', () => {
  it('grants trust through the same front-door path as the Skills UI', async () => {
    invokeMock.mockResolvedValue({
      skill_id: 'external-tools',
      trusted: true,
      package_sha256: 'a'.repeat(64),
    });

    const response = await dispatch({
      correlationId: 'corr-trust-1',
      command: 'trust_grant',
      args: { skillId: 'external-tools' },
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      skillId: 'external-tools',
      trusted: true,
      packageSha256: 'a'.repeat(64),
    });
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_set_skill_trust', {
      skillId: 'external-tools',
      packageRoot: '/tmp/skills/external-tools',
      trusted: true,
    });
  });

  it('refuses builtin skills and surfaces backend verification failures', async () => {
    const builtin = await dispatch({
      correlationId: 'corr-trust-2',
      command: 'trust_grant',
      args: { skillId: 'self-service-tools' },
    });
    expect(builtin.ok).toBe(false);
    expect(builtin.error).toContain('builtin');
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockRejectedValueOnce(new Error('package hash mismatch'));
    const failed = await dispatch({
      correlationId: 'corr-trust-3',
      command: 'trust_grant',
      args: { skillId: 'external-tools' },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('package hash mismatch');
  });
});

describe('skillLifecycleBridge protocol', () => {
  it('rejects unsupported commands with an explicit error', async () => {
    const response = await dispatch({
      correlationId: 'corr-unknown-1',
      command: 'delete_everything',
      args: { skillId: 'external-tools' },
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported');
  });

  it('requires skillId for every command', async () => {
    const response = await dispatch({
      correlationId: 'corr-missing-id',
      command: 'describe',
      args: {},
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('skillId');
  });
});
