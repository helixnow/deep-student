import { getReadableToolName } from '@/features/chat/utils/toolDisplayName';
import { t } from '@/utils/i18n';
import type {
  SkillDefinition,
  SkillLocation,
  SkillPackageFile,
  SkillPackageSource,
  SkillTrustStatus,
} from './types';

const SKILL_ENTRY_FILE = 'SKILL.md';

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

export function getSkillPackageRoot(sourcePath: string): string | undefined {
  if (!sourcePath || sourcePath.startsWith('builtin://')) {
    return sourcePath || undefined;
  }
  const normalized = normalizeSlashes(sourcePath);
  const suffix = `/${SKILL_ENTRY_FILE}`;
  if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
    return normalized.slice(0, -suffix.length);
  }
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : undefined;
}

export function getSkillPackageSource(
  location: SkillLocation,
  sourcePath: string,
): SkillPackageSource {
  if (location === 'builtin' || sourcePath.startsWith('builtin://')) {
    return 'builtin';
  }
  const normalized = normalizeSlashes(sourcePath).toLowerCase();
  if (normalized.includes('/.agents/skills/') || normalized.includes('/.claude/skills/')) {
    return 'external';
  }
  if (location === 'global') return 'global';
  if (location === 'project') return 'project';
  return 'unknown';
}

export function getSkillTrustStatus(
  location: SkillLocation,
  sourcePath: string,
  _packageFiles?: SkillPackageFile[],
): SkillTrustStatus {
  const source = getSkillPackageSource(location, sourcePath);
  // 内置技能始终受信任（识别路径：location==='builtin' 或 sourcePath 以 builtin:// 开头）
  if (source === 'builtin') return 'builtin';
  // fail-closed（对齐后端 ADR-B3 / S4）：非 builtin 默认不受信。
  // 含 external（.agents/.claude）、带 AGENT_INSTALLED.json 的 agent 装入技能，
  // 以及无 provenance marker 的 global/project/unknown——用户须在技能管理中显式信任。
  // _packageFiles 保留供调用方签名兼容；marker 存在与否不再改变默认（均为 untrusted）。
  return 'untrusted';
}

export function classifySkillPackageFile(path: string): SkillPackageFile['kind'] {
  const normalized = normalizeSlashes(path).toLowerCase();
  if (normalized === 'skill.md') return 'entry';
  if (normalized === 'deep-student.yaml' || normalized === 'skill.json' || normalized === 'package.json') {
    return 'config';
  }
  if (normalized.startsWith('references/')) return 'reference';
  if (normalized.startsWith('scripts/')) return 'script';
  if (normalized.startsWith('assets/')) return 'asset';
  return 'other';
}

export function createDefaultPackageFiles(sourcePath: string): SkillPackageFile[] | undefined {
  if (!sourcePath || sourcePath.startsWith('builtin://')) {
    return undefined;
  }
  return [{ path: SKILL_ENTRY_FILE, kind: 'entry' }];
}

export function enrichSkillPackageMetadata(
  skill: SkillDefinition,
  packageFiles?: SkillPackageFile[],
): SkillDefinition {
  const packageRoot = skill.packageRoot ?? getSkillPackageRoot(skill.sourcePath);
  const nextFiles = packageFiles?.length
    ? packageFiles
    : skill.packageFiles ?? createDefaultPackageFiles(skill.sourcePath);

  const baseTrust =
    skill.trustStatus ??
    getSkillTrustStatus(skill.location, skill.sourcePath, packageFiles ?? skill.packageFiles);

  return {
    ...skill,
    packageSource: skill.packageSource ?? getSkillPackageSource(skill.location, skill.sourcePath),
    packageRoot,
    packageFiles: nextFiles,
    trustStatus: baseTrust,
  };
}

/** 返回 embeddedTools 的人类可读名称列表（走 mcp.tools.* 国际化）。 */
export function getSkillEmbeddedToolLabels(skill: SkillDefinition, limit = 12): string[] {
  const tools = skill.embeddedTools ?? [];
  return tools.slice(0, limit).map((tool) => getReadableToolName(tool.name, t));
}

export interface SkillPermissionSummary {
  embeddedTools: number;
  dependencies: number;
  packageFiles: number;
  scripts: number;
  references: number;
  assets: number;
  isInstructionOnly: boolean;
}

export function getSkillPermissionSummary(skill: SkillDefinition): SkillPermissionSummary {
  const files = skill.packageFiles ?? [];
  const embeddedTools = skill.embeddedTools?.length ?? 0;

  return {
    embeddedTools,
    dependencies: skill.dependencies?.length ?? 0,
    packageFiles: files.length,
    scripts: files.filter((file) => file.kind === 'script').length,
    references: files.filter((file) => file.kind === 'reference').length,
    assets: files.filter((file) => file.kind === 'asset').length,
    isInstructionOnly: embeddedTools === 0,
  };
}
