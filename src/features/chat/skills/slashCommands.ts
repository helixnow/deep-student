/**
 * Chat V2 - 技能斜杠命令解析
 *
 * 消息开头的 `/skill-id` 令牌被识别为显式技能激活命令（支持多个前置斜杠技能令牌叠加）：
 *
 * - 从首个令牌开始逐个匹配，遇到第一个非技能令牌即停止（`/tmp/x.pdf` 这类
 *   路径参数不会被吞掉）
 * - 一条消息最多识别 MAX_SLASH_SKILLS 个技能
 * - 匹配大小写不敏感，按 skill id 精确匹配
 */

import { skillRegistry } from './registry';
import { isSkillDisabled } from './skillEnableStorage';

/** 一条消息最多叠加的技能数（限制为五个以控制上下文大小） */
export const MAX_SLASH_SKILLS = 5;

/** 斜杠令牌格式：/ + 合法 skill id 字符 */
const SLASH_TOKEN_PATTERN = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)$/;

export interface ParsedSkillCommands {
  /** 识别出的技能 ID（registry 中的真实 id，已去重、保持出现顺序） */
  skillIds: string[];
  /** 去掉技能命令后的剩余消息文本 */
  rest: string;
}

/**
 * 把令牌解析为已注册且未停用的技能 id；不匹配返回 null。
 *
 * 独立导出便于测试注入；默认实现查 skillRegistry。
 * `userInvocable: false` 的技能不可被斜杠命令激活
 * （与输入栏 SkillSlashPopover 的补全过滤语义保持一致）。
 */
export function resolveSkillToken(token: string): string | null {
  const match = SLASH_TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  const skill = skillRegistry
    .getAll()
    .find((s) => s.id.toLowerCase() === candidate);
  if (!skill) return null;
  if (skill.userInvocable === false) return null;
  if (isSkillDisabled(skill.id)) return null;
  return skill.id;
}

/**
 * 解析消息开头的技能斜杠命令。
 *
 * @param input 原始输入
 * @param resolve 令牌解析器（默认查 registry），返回真实 skill id 或 null
 */
export function parseLeadingSkillCommands(
  input: string,
  resolve: (token: string) => string | null = resolveSkillToken,
): ParsedSkillCommands {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) {
    return { skillIds: [], rest: input };
  }

  const skillIds: string[] = [];
  let remaining = trimmed;

  while (skillIds.length < MAX_SLASH_SKILLS) {
    const spaceIndex = remaining.search(/\s/);
    const token = spaceIndex === -1 ? remaining : remaining.slice(0, spaceIndex);
    if (!token.startsWith('/')) break;

    const skillId = resolve(token);
    if (!skillId) break;

    if (!skillIds.includes(skillId)) {
      skillIds.push(skillId);
    }
    remaining = spaceIndex === -1 ? '' : remaining.slice(spaceIndex + 1).trimStart();
  }

  if (skillIds.length === 0) {
    return { skillIds: [], rest: input };
  }
  return { skillIds, rest: remaining };
}
