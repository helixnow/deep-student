/**
 * 用户显式 Skill 信任覆盖（localStorage）
 *
 * 外部/兼容目录（.agents/skills、.claude/skills 等）默认 untrusted；
 * 用户可在技能管理页或选择器内升级为 trusted，运行时才会进入 skillPackageRoots。
 *
 * 🔒 P1（2026-07-08 审阅 22 P1-2）：信任授予不再绑定裸 skill id，而是同时记录
 * 授予时刻的包内容指纹（contentHash）。解析信任时若指纹不匹配（技能内容在
 * 授予后被替换：skill_workshop 更新、zip 覆盖、外部手动替换等 TOCTOU 场景），
 * trusted 覆盖自动失效并回退到路径推导默认（通常为 untrusted），需用户重新信任。
 *
 * localStorage 只驱动 UI 可见状态，不再是安全边界。授予/撤销信任必须先由
 * 后端持久化目录身份与完整 SkillPackage SHA-256；运行时解析 skillPackageRoots
 * 时会重新计算并 fail-closed 校验。这里的同步指纹仅用于让 UI 及时失效。
 */

import type { SkillDefinition, SkillTrustStatus } from './types';
import { invoke } from '@tauri-apps/api/core';
import { getSkillTrustStatus } from './packageMetadata';
import { skillRegistry } from './registry';

const STORAGE_KEY = 'deep-student.skill-trust-overrides';

export type SkillTrustOverride = 'trusted' | 'untrusted';

/** 新版存储条目：信任状态 + 授予时的内容指纹 */
interface TrustOverrideEntry {
  trust: SkillTrustOverride;
  /** 授予 trusted 时的包内容指纹；旧数据无此字段（惰性迁移，见 resolveEffectiveTrustStatus） */
  contentHash?: string;
  grantedAt?: number;
}

/** 兼容旧格式：值可能是裸字符串（'trusted' | 'untrusted'）或新版条目对象 */
type StoredTrustValue = SkillTrustOverride | TrustOverrideEntry;

type TrustOverrideMap = Record<string, StoredTrustValue>;

function readMap(): TrustOverrideMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as TrustOverrideMap;
  } catch {
    return {};
  }
}

function writeMap(map: TrustOverrideMap): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

function normalizeEntry(value: StoredTrustValue | undefined): TrustOverrideEntry | null {
  if (value === 'trusted' || value === 'untrusted') {
    return { trust: value };
  }
  if (
    value &&
    typeof value === 'object' &&
    (value.trust === 'trusted' || value.trust === 'untrusted')
  ) {
    return value;
  }
  return null;
}

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 计算 skill 的信任指纹（同步、非密码学）。
 *
 * 覆盖面：SKILL.md 正文、来源路径、embeddedTools/依赖/allowedTools 声明、
 * 包文件索引（路径+类型+大小，可粗粒度感知 scripts/references 的增删改）。
 * 选用同步 FNV-1a 而非 crypto.subtle（异步）是因为 resolveEffectiveTrustStatus
 * 在渲染路径同步调用；这只是 UI 侧的快速失效提示，后端整包 SHA-256 才是
 * 执行时信任边界。
 */
export function computeSkillTrustFingerprint(skill: SkillDefinition): string {
  const material = JSON.stringify([
    skill.id,
    skill.sourcePath ?? '',
    skill.content ?? '',
    skill.embeddedTools ?? [],
    skill.dependencies ?? [],
    skill.allowedTools ?? skill.tools ?? [],
    (skill.packageFiles ?? []).map((file) => [file.path, file.kind, file.size ?? -1]),
  ]);
  const h1 = fnv1a32(material, 0x811c9dc5).toString(16).padStart(8, '0');
  const h2 = fnv1a32(material, 0x9dc5811c).toString(16).padStart(8, '0');
  return `fnv1a:${h1}${h2}`;
}

/** 读取用户对某个 skill 的信任覆盖；无覆盖时返回 null。 */
export function getSkillTrustOverride(skillId: string): SkillTrustOverride | null {
  return normalizeEntry(readMap()[skillId])?.trust ?? null;
}

/**
 * 设置或清除用户信任覆盖。trust 为 null 时删除覆盖，回退到路径推导。
 *
 * 授予 trusted 时记录当前包内容指纹（优先使用调用方传入的 skill，
 * 否则从 registry 按 id 查找），后续内容变化将使该信任自动失效。
 */
export async function setSkillTrustOverride(
  skillId: string,
  trust: SkillTrustOverride | null,
  skill?: SkillDefinition,
): Promise<void> {
  const target = skill ?? skillRegistry.get(skillId);
  if (trust === 'trusted') {
    const packageRoot = target?.packageRoot;
    if (!packageRoot || packageRoot.startsWith('builtin://')) {
      throw new Error(`Skill "${skillId}" has no local package root to trust`);
    }
    await invoke('chat_v2_set_skill_trust', {
      skillId,
      packageRoot,
      trusted: true,
    });
  } else {
    await invoke('chat_v2_set_skill_trust', {
      skillId,
      packageRoot: target?.packageRoot ?? null,
      trusted: false,
    });
  }

  const map = readMap();
  if (trust === null) {
    delete map[skillId];
  } else if (trust === 'trusted') {
    map[skillId] = {
      trust: 'trusted',
      contentHash: target ? computeSkillTrustFingerprint(target) : undefined,
      grantedAt: Date.now(),
    };
  } else {
    map[skillId] = { trust: 'untrusted', grantedAt: Date.now() };
  }
  writeMap(map);
  window.dispatchEvent(new CustomEvent('SKILL_TRUST_CHANGED', { detail: { skillId, trust } }));
}

/** 结合路径默认与用户覆盖，得到最终 trustStatus。 */
export function resolveEffectiveTrustStatus(skill: SkillDefinition): SkillTrustStatus {
  const entry = normalizeEntry(readMap()[skill.id]);
  const defaultTrust =
    skill.trustStatus ?? getSkillTrustStatus(skill.location, skill.sourcePath, skill.packageFiles);

  if (entry?.trust === 'untrusted') return 'untrusted';

  if (entry?.trust === 'trusted') {
    // builtin 不受用户覆盖影响
    if (defaultTrust === 'builtin') return 'builtin';

    const currentHash = computeSkillTrustFingerprint(skill);
    if (!entry.contentHash) {
      // 旧格式（信任仅绑定 id）：本次兑现并惰性升级为哈希绑定，关闭后续 TOCTOU 窗口。
      // 不派发 SKILL_TRUST_CHANGED（信任状态未变，且此函数可能在渲染路径被调用）。
      try {
        const map = readMap();
        map[skill.id] = {
          trust: 'trusted',
          contentHash: currentHash,
          grantedAt: entry.grantedAt ?? Date.now(),
        };
        writeMap(map);
      } catch {
        // best-effort：迁移失败不影响本次解析
      }
      return 'trusted';
    }
    if (entry.contentHash === currentHash) {
      return 'trusted';
    }
    // 内容在授予信任后发生变化：信任失效，回退默认（fail-closed）
    console.warn(
      `[SkillTrust] Trust fingerprint mismatch for "${skill.id}"; ` +
      'skill content changed since trust was granted, falling back to default trust status'
    );
    return defaultTrust;
  }

  return defaultTrust;
}

export function applyTrustOverride(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    trustStatus: resolveEffectiveTrustStatus(skill),
  };
}
