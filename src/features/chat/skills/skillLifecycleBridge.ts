/**
 * Skill 生命周期前端桥（Rust ↔ 前端 RPC）
 *
 * 复刻 mcpService.setupTauriBridge 模式：listen 请求 → 处理 → emit 响应。
 * 服务后端 skill_lifecycle_executor（skill_set_enabled / skill_remove /
 * skill_trust_request）——启用状态与信任 UI 覆盖存在前端 localStorage，
 * Rust executor 无法直接写入，必须经本桥委托前端正门函数落地：
 *
 * - `describe`：从 skillRegistry 读取技能元信息（builtin / packageRoot / 启停 / 信任状态）
 * - `set_enabled`：调用 skillEnableStorage.setSkillDisabled（自动广播 SKILL_ENABLED_CHANGED）
 * - `trust_grant` / `trust_revoke`：调用 skillTrustStorage.setSkillTrustOverride
 *   （前端正门：后端 chat_v2_set_skill_trust 绑定整包 SHA-256 指纹 +
 *   localStorage 记录 UI 指纹 + 广播 SKILL_TRUST_CHANGED）
 *
 * 注意：本桥不是安全边界——删除与信任授予的审批由后端 ApprovalManager 在
 * executor 执行前完成（High + never-remember），指纹绑定由后端重算校验。
 */

import { skillRegistry } from './registry';
import { isSkillDisabled, setSkillDisabled } from './skillEnableStorage';
import { resolveEffectiveTrustStatus, setSkillTrustOverride } from './skillTrustStorage';

/** 桥请求事件名（与 Rust skill_lifecycle_executor 冻结常量对齐） */
const BRIDGE_REQUEST_EVENT = 'skill-lifecycle-bridge-request';
/** 桥响应事件前缀 → `skill-lifecycle-bridge-response:{correlationId}` */
const BRIDGE_RESPONSE_PREFIX = 'skill-lifecycle-bridge-response:';

interface SkillLifecycleBridgeRequest {
  correlationId: string;
  command: 'describe' | 'set_enabled' | 'trust_grant' | 'trust_revoke';
  args?: {
    skillId?: string;
    enabled?: boolean;
  };
  sessionId?: string;
}

interface SkillLifecycleBridgeResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

function requireSkillId(req: SkillLifecycleBridgeRequest): string {
  const skillId = req.args?.skillId?.trim();
  if (!skillId) {
    throw new Error('skillId is required');
  }
  return skillId;
}

async function handleCommand(req: SkillLifecycleBridgeRequest): Promise<unknown> {
  switch (req.command) {
    case 'describe': {
      const skillId = requireSkillId(req);
      const skill = skillRegistry.get(skillId);
      if (!skill) {
        return { found: false, skillId };
      }
      return {
        found: true,
        skillId,
        name: skill.name,
        isBuiltin: skill.isBuiltin === true,
        location: skill.location,
        sourcePath: skill.sourcePath,
        packageRoot: skill.packageRoot ?? null,
        disabled: isSkillDisabled(skillId),
        trustStatus: resolveEffectiveTrustStatus(skill),
      };
    }
    case 'set_enabled': {
      const skillId = requireSkillId(req);
      const enabled = req.args?.enabled;
      if (typeof enabled !== 'boolean') {
        throw new Error('enabled must be a boolean');
      }
      const skill = skillRegistry.get(skillId);
      if (!skill) {
        throw new Error(`Skill "${skillId}" is not registered`);
      }
      const previousDisabled = isSkillDisabled(skillId);
      // setSkillDisabled 会广播 SKILL_ENABLED_CHANGED，技能管理页/选择器自动刷新
      setSkillDisabled(skillId, !enabled);
      return { skillId, enabled, previousDisabled };
    }
    case 'trust_grant': {
      const skillId = requireSkillId(req);
      const skill = skillRegistry.get(skillId);
      if (!skill) {
        throw new Error(`Skill "${skillId}" is not registered`);
      }
      if (skill.isBuiltin) {
        throw new Error(`Skill "${skillId}" is builtin and is always trusted`);
      }
      // 正门授予：后端绑定 canonical path + 文件系统身份 + 整包 SHA-256，
      // 前端同步记录 UI 内容指纹并广播 SKILL_TRUST_CHANGED
      const state = await setSkillTrustOverride(skillId, 'trusted', skill);
      return {
        skillId,
        trusted: state.trusted,
        packageSha256: state.package_sha256 ?? null,
      };
    }
    case 'trust_revoke': {
      const skillId = requireSkillId(req);
      const skill = skillRegistry.get(skillId);
      const state = await setSkillTrustOverride(skillId, 'untrusted', skill);
      return { skillId, trusted: state.trusted };
    }
    default:
      throw new Error(`Unsupported skill lifecycle bridge command: ${String(req.command)}`);
  }
}

let bridgeInitialized = false;

/**
 * 注册 skill-lifecycle-bridge-request 监听（幂等；web-only 环境静默降级）。
 * 在 chat/init.ts 中随技能系统一起初始化。
 */
export function setupSkillLifecycleBridge(): void {
  if (bridgeInitialized) return;
  if (typeof window === 'undefined') return;
  const hasTauri = Boolean(
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ||
      (window as unknown as Record<string, unknown>).__TAURI_IPC__,
  );
  if (!hasTauri) return;
  bridgeInitialized = true;

  // 懒加载 @tauri-apps/api，避免 web-only / jsdom 环境硬依赖
  import('@tauri-apps/api/event')
    .then(({ listen, emit }) => {
      listen<SkillLifecycleBridgeRequest>(BRIDGE_REQUEST_EVENT, async (event) => {
        const req = event.payload;
        if (!req?.correlationId) {
          console.warn('[SkillLifecycleBridge] request missing correlationId');
          return;
        }
        let response: SkillLifecycleBridgeResponse;
        try {
          const data = await handleCommand(req);
          response = { correlationId: req.correlationId, ok: true, data };
        } catch (error) {
          response = {
            correlationId: req.correlationId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        try {
          await emit(`${BRIDGE_RESPONSE_PREFIX}${req.correlationId}`, response);
        } catch (emitError) {
          console.warn('[SkillLifecycleBridge] emit response failed:', emitError);
        }
      }).catch((error) => {
        bridgeInitialized = false;
        console.error('[SkillLifecycleBridge] failed to register listener:', error);
      });
    })
    .catch((error) => {
      bridgeInitialized = false;
      console.warn('[SkillLifecycleBridge] setup failed:', error);
    });
}
