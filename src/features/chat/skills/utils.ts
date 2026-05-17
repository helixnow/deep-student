/**
 * Chat V2 - Skills 共享工具函数
 *
 * 提供技能模块的通用工具函数，避免循环依赖。
 * 此文件不应从 ./index.ts 或 ./components/* 导入。
 */

import type { SkillLocation } from './types';

/**
 * 获取位置标签
 */
export function getLocationLabel(location: SkillLocation, t: (key: string) => string): string {
  switch (location) {
    case 'global':
      return t('skills:location.global');
    case 'project':
      return t('skills:location.project');
    case 'builtin':
      return t('skills:location.builtin');
    default:
      return '';
  }
}

/**
 * 获取位置样式
 *
 * 走语义 token，避免硬编码 Tailwind 调色板：
 *   - builtin → 主强调色（--button-primary-*），随主题切换自动变化
 *   - global  → --info（信息蓝）
 *   - project → --success（成功绿）
 *   - 其他    → 中性 utility token
 *
 * 这样多主题（紫/蓝/绿/橙/粉/青/灰/茶）切换时，"内置" 徽章会跟随
 * --primary，而不是永远卡在固定紫色。
 */
export function getLocationStyle(location: SkillLocation): string {
  switch (location) {
    case 'global':
      return 'bg-[color:hsl(var(--info)/0.12)] text-[color:hsl(var(--info))]';
    case 'project':
      return 'bg-[color:hsl(var(--success)/0.12)] text-[color:hsl(var(--success))]';
    case 'builtin':
      return 'bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)]';
    default:
      return 'bg-[color:var(--button-utility-surface)] text-[color:var(--text-secondary)]';
  }
}

/**
 * 获取技能的本地化名称
 *
 * 优先使用 i18n 翻译（skills:builtinNames.<id>），回退到 skill.name。
 * 统一提取避免在各组件中重复定义。
 *
 * @param skillId 技能 ID
 * @param skillName 技能原始名称（回退值）
 * @param t i18n 翻译函数
 * @returns 本地化后的技能名称
 */
export function getLocalizedSkillName(
  skillId: string,
  skillName: string,
  t: (key: string, options?: { defaultValue?: string }) => string
): string {
  const translatedName = t(`skills:builtinNames.${skillId}`, { defaultValue: '' });
  return translatedName || skillName;
}

/**
 * 获取技能的本地化描述
 *
 * 优先使用 i18n 翻译（skills:builtinDescriptions.<id>），回退到 skill.description。
 */
export function getLocalizedSkillDescription(
  skillId: string,
  description: string,
  t: (key: string, options?: { defaultValue?: string }) => string
): string {
  const translatedDescription = t(`skills:builtinDescriptions.${skillId}`, { defaultValue: '' });
  return translatedDescription || description;
}
