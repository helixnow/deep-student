/**
 * Wave2-B r5 — Spaces 最小命名桌面：parsePersistedDesktopName 解析层单测
 * （纯函数；坏值 → null 回退默认名、控制字符清洗、码点级截断不劈代理对）
 */
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_NAME_MAX_LENGTH,
  parsePersistedDesktopName,
} from '../persistedSettings';

describe('parsePersistedDesktopName', () => {
  it('普通名称原样通过（两端去空）', () => {
    expect(parsePersistedDesktopName('考研冲刺')).toBe('考研冲刺');
    expect(parsePersistedDesktopName('  Deep Work  ')).toBe('Deep Work');
  });

  it('非字符串 / 空串 / 纯空白 → null（展示方回退默认品牌名）', () => {
    expect(parsePersistedDesktopName(null)).toBeNull();
    expect(parsePersistedDesktopName(undefined)).toBeNull();
    expect(parsePersistedDesktopName(42)).toBeNull();
    expect(parsePersistedDesktopName({ name: 'x' })).toBeNull();
    expect(parsePersistedDesktopName('')).toBeNull();
    expect(parsePersistedDesktopName('   \t \n ')).toBeNull();
  });

  it('控制字符（含换行）清洗为空格并折叠', () => {
    expect(parsePersistedDesktopName('期末\n复习')).toBe('期末 复习');
    expect(parsePersistedDesktopName('a\u0000b\u001fc\u007fd')).toBe('a b c d');
    expect(parsePersistedDesktopName('多  个   空格')).toBe('多 个 空格');
  });

  it('超长按码点截断到 DESKTOP_NAME_MAX_LENGTH', () => {
    const long = '甲'.repeat(DESKTOP_NAME_MAX_LENGTH + 10);
    const parsed = parsePersistedDesktopName(long);
    expect(parsed).not.toBeNull();
    expect(Array.from(parsed as string)).toHaveLength(DESKTOP_NAME_MAX_LENGTH);
  });

  it('截断不劈开代理对（emoji 码点计数）', () => {
    const emoji = '😀'.repeat(DESKTOP_NAME_MAX_LENGTH + 5);
    const parsed = parsePersistedDesktopName(emoji);
    expect(parsed).toBe('😀'.repeat(DESKTOP_NAME_MAX_LENGTH));
  });

  it('恰好等长不截断', () => {
    const exact = 'x'.repeat(DESKTOP_NAME_MAX_LENGTH);
    expect(parsePersistedDesktopName(exact)).toBe(exact);
  });
});
