/**
 * secretMask 纯函数单测
 *
 * 覆盖：各 pattern 正例、反例（普通中文/URL/短 token/边界误伤）、多次命中、
 * 重叠命中去重、幂等性、count 与 masked 文本、shouldMaskUserContent 角色门控。
 */

import { describe, expect, it } from 'vitest';
import {
  findSecrets,
  hasSecrets,
  maskSecrets,
  shouldMaskUserContent,
} from '../secretMask';

// ============================================================================
// 测试样本
// ============================================================================

/** DeepSeek / OpenAI 风格：sk- + 24 位 */
const OPENAI_KEY = `sk-${'Ab0_-'.repeat(6)}`;
/** Authorization: Bearer <20 位> */
const BEARER_TOKEN = 'eyJhbGciOiJIUzI1NiJ9';
/** GitHub classic PAT：ghp_ + 36 位 */
const GHP_TOKEN = `ghp_${'a'.repeat(36)}`;
/** GitHub fine-grained PAT：github_pat_ + 25 位 */
const GITHUB_FINE_PAT = 'github_pat_A1b2C3d4E5f6G7h8I9j0K';
/** AWS access key id：AKIA + 16 位大写字母/数字 */
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
/** Slack bot token */
const SLACK_TOKEN = 'xoxb-1234567890-abcdefghij';
/** Google API key：AIza + 35 位 */
const GOOGLE_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';
/** Hugging Face token：hf_ + 24 位 */
const HF_TOKEN = `hf_${'a'.repeat(24)}`;

// ============================================================================
// 各 pattern 正例
// ============================================================================

describe('maskSecrets - 各 pattern 正例', () => {
  it('识别 sk- 风格（保留 sk-xx 前缀）', () => {
    const result = maskSecrets(`我的 key 是 ${OPENAI_KEY} 请勿外传`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('我的 key 是 sk-Ab•••• 请勿外传');
    expect(result.masked).not.toContain(OPENAI_KEY);
  });

  it('识别 Bearer token（保留 Bearer xx 前缀）', () => {
    const result = maskSecrets(`Authorization: Bearer ${BEARER_TOKEN}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('Authorization: Bearer ey••••');
    expect(result.masked).not.toContain(BEARER_TOKEN);
  });

  it('识别 ghp_ token', () => {
    const result = maskSecrets(`令牌 ${GHP_TOKEN} 已泄露`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('令牌 ghp_aa•••• 已泄露');
    expect(result.masked).not.toContain('a'.repeat(36));
  });

  it('识别 github_pat_ token', () => {
    const result = maskSecrets(`令牌 ${GITHUB_FINE_PAT} 已泄露`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('令牌 github_pat_A1•••• 已泄露');
    expect(result.masked).not.toContain('d4E5f6G7h8I9j0K');
  });

  it('识别 AKIA AWS access key', () => {
    const result = maskSecrets(`aws_access_key_id = ${AWS_KEY}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('aws_access_key_id = AKIAIO••••');
    expect(result.masked).not.toContain('IOSFODNN7EXAMPLE');
  });

  it('识别 Slack token', () => {
    const result = maskSecrets(`SLACK=${SLACK_TOKEN}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('SLACK=xoxb-12••••');
  });

  it('识别 Google API key', () => {
    const result = maskSecrets(`key: ${GOOGLE_KEY}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('key: AIzaSy••••');
    expect(result.masked).not.toContain('1234567890abcdefghijklmnopqrstuv');
  });

  it('识别 Hugging Face token', () => {
    const result = maskSecrets(`HF_TOKEN=${HF_TOKEN}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('HF_TOKEN=hf_aa••••');
  });
});

// ============================================================================
// 通用赋值式
// ============================================================================

describe('maskSecrets - 通用赋值式', () => {
  it('api_key = "..." 保留标签并遮蔽值（含闭合引号）', () => {
    const result = maskSecrets('api_key = "abcdefghijklmnop1234"');
    expect(result.count).toBe(1);
    expect(result.masked).toBe('api_key = "••••"');
  });

  it('token: ... 冒号赋值', () => {
    const result = maskSecrets('token: abcdefghijklmnop');
    expect(result.count).toBe(1);
    expect(result.masked).toBe('token: ••••');
  });

  it('忽略大小写（PASSWORD = ...）', () => {
    const result = maskSecrets('PASSWORD = Abc123XYZxyz');
    expect(result.count).toBe(1);
    expect(result.masked).toBe('PASSWORD = ••••');
  });

  it('access_token=... 复合键名', () => {
    const result = maskSecrets('access_token=abcdefghijklmnop1234');
    expect(result.count).toBe(1);
    expect(result.masked).toBe('access_token=••••');
  });

  it('secret=... 无引号无空格', () => {
    const result = maskSecrets('secret=abcdefghijklmnop');
    expect(result.count).toBe(1);
    expect(result.masked).toBe('secret=••••');
  });
});

// ============================================================================
// 反例：不误伤普通正文
// ============================================================================

describe('maskSecrets - 反例（不误伤）', () => {
  const negativeCases: Array<[string, string]> = [
    ['普通中文', '这是一段普通中文文本，里面没有任何密钥或令牌。'],
    ['普通 URL', 'https://example.com/path/to/some/page?page=2&sort=asc'],
    ['短 token', 'sk-abc123 太短不算'],
    ['短 Bearer', 'Bearer token 认证方式'],
    ['单词包含 sk-', 'task-abcdefghijklmnopqrstuvwx 只是一个任务 ID'],
    ['mytoken 边界', 'mytoken = abcdefghijklmnop'],
    ['password 普通句子', 'the password is correct'],
    ['赋值但值太短', 'secret: short'],
    ['空字符串', ''],
    ['中文标点', '密钥是「sk-短」这种格式。'],
  ];

  it.each(negativeCases)('%s 不命中', (_name, text) => {
    const result = maskSecrets(text);
    expect(result.count).toBe(0);
    expect(result.masked).toBe(text);
    expect(hasSecrets(text)).toBe(false);
  });
});

// ============================================================================
// 多次命中 / 重叠 / 幂等
// ============================================================================

describe('maskSecrets - 多次命中与幂等性', () => {
  it('同一文本多处命中，count 正确且中间文本保留', () => {
    const text = `旧 key ${OPENAI_KEY} 新 key ${GHP_TOKEN} 结束`;
    const result = maskSecrets(text);
    expect(result.count).toBe(2);
    expect(result.masked).toBe('旧 key sk-Ab•••• 新 key ghp_aa•••• 结束');
  });

  it('相邻命中互不干扰', () => {
    const text = `${OPENAI_KEY} ${GHP_TOKEN}`;
    const result = maskSecrets(text);
    expect(result.count).toBe(2);
    expect(result.masked).toBe('sk-Ab•••• ghp_aa••••');
  });

  it('重叠命中只计一次（assignment 覆盖内部 sk- token）', () => {
    const text = `api_key=sk-${'a'.repeat(20)}`;
    const result = maskSecrets(text);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('api_key=••••');
    expect(result.masked).not.toContain('sk-');
  });

  it('多次调用结果稳定（命中顺序与 start/end 递增）', () => {
    const text = `${OPENAI_KEY} 与 ${HF_TOKEN}`;
    const first = maskSecrets(text);
    const second = maskSecrets(text);
    expect(second).toEqual(first);
  });

  it('幂等：脱敏后再脱敏 count=0 且内容不变', () => {
    const text = `key=${OPENAI_KEY} bearer=Bearer ${BEARER_TOKEN} pwd=password="abcdefghijklmnop"`;
    const first = maskSecrets(text);
    expect(first.count).toBeGreaterThan(0);

    const second = maskSecrets(first.masked);
    expect(second.count).toBe(0);
    expect(second.masked).toBe(first.masked);
  });
});

// ============================================================================
// findSecrets 细节
// ============================================================================

describe('findSecrets', () => {
  it('返回原文下标区间与类别，且区间切片以可识别前缀开头', () => {
    const text = `前 ${OPENAI_KEY} 后`;
    const matches = findSecrets(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe('openai');
    expect(matches[0].start).toBe(2);
    expect(text.slice(matches[0].start, matches[0].end)).toBe(OPENAI_KEY);
    expect(matches[0].masked.startsWith('sk-Ab')).toBe(true);
    expect(matches[0].masked.endsWith('••••')).toBe(true);
  });

  it('按原文顺序返回、互不重叠', () => {
    const text = `${GHP_TOKEN} abc ${OPENAI_KEY}`;
    const matches = findSecrets(text);
    expect(matches.map((m) => m.kind)).toEqual(['github_pat', 'openai']);
    for (let i = 1; i < matches.length; i += 1) {
      expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].end);
    }
  });

  it('无命中返回空数组', () => {
    expect(findSecrets('普通中文文本，没有敏感信息。')).toEqual([]);
    expect(findSecrets('')).toEqual([]);
    expect(findSecrets('sk-abc')).toEqual([]);
  });
});

// ============================================================================
// shouldMaskUserContent 角色门控
// ============================================================================

describe('shouldMaskUserContent', () => {
  it('用户消息命中敏感串时启用', () => {
    expect(shouldMaskUserContent('user', `我的 key ${OPENAI_KEY}`)).toBe(true);
  });

  it('assistant 消息不启用（即使内容含密钥）', () => {
    expect(shouldMaskUserContent('assistant', `我的 key ${OPENAI_KEY}`)).toBe(false);
  });

  it('角色缺失/为 null 时不启用', () => {
    expect(shouldMaskUserContent(undefined, OPENAI_KEY)).toBe(false);
    expect(shouldMaskUserContent(null, OPENAI_KEY)).toBe(false);
  });

  it('用户消息但无敏感串时不启用', () => {
    expect(shouldMaskUserContent('user', '普通中文消息，没有密钥。')).toBe(false);
  });

  it('内容缺失/为空时不启用', () => {
    expect(shouldMaskUserContent('user', '')).toBe(false);
    expect(shouldMaskUserContent('user', null)).toBe(false);
    expect(shouldMaskUserContent('user', undefined)).toBe(false);
  });
});
