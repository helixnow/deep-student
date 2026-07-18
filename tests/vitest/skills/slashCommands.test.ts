/**
 * 技能斜杠命令解析测试
 *
 * 覆盖：消息开头 /skill-id 令牌识别、多技能叠加上限、
 * 非技能令牌截断、路径参数不误吞、纯激活命令。
 */

import { describe, it, expect } from 'vitest';
import { parseLeadingSkillCommands, MAX_SLASH_SKILLS } from '@/features/chat/skills/slashCommands';

const KNOWN_SKILLS = ['tutor-mode', 'pdf-tools', 'chat-anki', 'skill-installer', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'];

const resolve = (token: string): string | null => {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(token);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return KNOWN_SKILLS.includes(id) ? id : null;
};

describe('parseLeadingSkillCommands', () => {
  it('识别单个技能命令并剥离正文', () => {
    const result = parseLeadingSkillCommands('/tutor-mode 帮我复习函数', resolve);
    expect(result.skillIds).toEqual(['tutor-mode']);
    expect(result.rest).toBe('帮我复习函数');
  });

  it('支持多技能叠加', () => {
    const result = parseLeadingSkillCommands('/tutor-mode /pdf-tools 讲讲这份讲义', resolve);
    expect(result.skillIds).toEqual(['tutor-mode', 'pdf-tools']);
    expect(result.rest).toBe('讲讲这份讲义');
  });

  it('大小写不敏感，去重保持顺序', () => {
    const result = parseLeadingSkillCommands('/Tutor-Mode /TUTOR-MODE /pdf-tools 内容', resolve);
    expect(result.skillIds).toEqual(['tutor-mode', 'pdf-tools']);
    expect(result.rest).toBe('内容');
  });

  it('遇到第一个非技能令牌即停止（路径参数不被吞）', () => {
    const result = parseLeadingSkillCommands('/pdf-tools /tmp/report.pdf 总结一下', resolve);
    expect(result.skillIds).toEqual(['pdf-tools']);
    expect(result.rest).toBe('/tmp/report.pdf 总结一下');
  });

  it('未知技能令牌不解析，原文返回', () => {
    const input = '/no-such-skill 你好';
    const result = parseLeadingSkillCommands(input, resolve);
    expect(result.skillIds).toEqual([]);
    expect(result.rest).toBe(input);
  });

  it('非斜杠开头的消息原样返回', () => {
    const input = '普通消息 /tutor-mode 不在开头';
    const result = parseLeadingSkillCommands(input, resolve);
    expect(result.skillIds).toEqual([]);
    expect(result.rest).toBe(input);
  });

  it('纯激活命令（无正文）rest 为空串', () => {
    const result = parseLeadingSkillCommands('/tutor-mode', resolve);
    expect(result.skillIds).toEqual(['tutor-mode']);
    expect(result.rest).toBe('');
  });

  it('最多识别 MAX_SLASH_SKILLS 个技能', () => {
    const result = parseLeadingSkillCommands('/a1 /a2 /a3 /a4 /a5 /a6 正文', resolve);
    expect(result.skillIds).toHaveLength(MAX_SLASH_SKILLS);
    expect(result.skillIds).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(result.rest).toBe('/a6 正文');
  });

  it('斜杠数字/下划线 id 合法', () => {
    const result = parseLeadingSkillCommands('/a1 问题', resolve);
    expect(result.skillIds).toEqual(['a1']);
  });
});
