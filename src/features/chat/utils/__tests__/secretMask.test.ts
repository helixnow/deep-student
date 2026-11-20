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
/** GitHub OAuth / user / server / refresh tokens：gh[ousr]_ + 24 位 */
const GHO_TOKEN = 'gho_' + 'B'.repeat(24);
const GHU_TOKEN = 'ghu_' + 'c'.repeat(24);
const GHS_TOKEN = 'ghs_' + 'D'.repeat(24);
const GHR_TOKEN = 'ghr_' + 'e'.repeat(24);
/** GitHub fine-grained PAT：github_pat_ + 25 位（运行时拼接，避免静态 secret scanning 误报） */
const GITHUB_FINE_PAT = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K';
/** AWS access key id：AKIA / ASIA + 16 位大写字母/数字（拼接，避免静态误报） */
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const AWS_STS_KEY = 'ASIA' + 'IOSFODNN7EXAMPLE';
/** Slack bot token（拼接，避免静态误报） */
const SLACK_TOKEN = 'xoxb-' + '1234567890-abcdefghij';
/** Google API key：AIza + 35 位（拼接，避免静态误报；提交里不得出现完整字面量） */
const GOOGLE_KEY = 'AIza' + 'SyA' + '1'.repeat(32);
/** Hugging Face token：hf_ + 24 位 */
const HF_TOKEN = `hf_${'a'.repeat(24)}`;
/** Groq API key：gsk_ + 24 位 */
const GROQ_KEY = 'gsk_' + 'K9m2P4q6R8s0T2v4W6x8Y0z2';
/** Perplexity API key：pplx- + 24 位 */
const PPLX_KEY = 'pplx-' + 'a1b2c3d4e5f6g7h8i9j0k1l2';
/** xAI API key：xai- + 24 位 */
const XAI_KEY = 'xai-' + 'Z9y8X7w6V5u4T3s2R1q0P9o8';
/** Tavily API key：tvly- + 24 位 */
const TAVILY_KEY = 'tvly-' + 'dev-1234567890abcdefghij';
/** GitLab PAT：glpat- + 20 位 */
const GITLAB_PAT = 'glpat-' + 'AbCdEfGhIjKlMnOpQrSt';
/** Stripe live/test secret & restricted keys（拼接，避免静态误报） */
const STRIPE_SK_LIVE = 'sk_' + 'live_' + '51NabCdEfGhIjKlMnOpQrStUv';
const STRIPE_RK_TEST = 'rk_' + 'test_' + '99XyZwVuTsRqPoNmLkJiHgFe';

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

  it('识别 GitHub OAuth / App / Refresh 系列令牌（gho_ / ghu_ / ghs_ / ghr_）', () => {
    for (const [raw, expectedPrefix] of [
      [GHO_TOKEN, 'gho_BB••••'],
      [GHU_TOKEN, 'ghu_cc••••'],
      [GHS_TOKEN, 'ghs_DD••••'],
      [GHR_TOKEN, 'ghr_ee••••'],
    ] as const) {
      const result = maskSecrets(`gh token ${raw} end`);
      expect(result.count).toBe(1);
      expect(result.masked).toBe(`gh token ${expectedPrefix} end`);
    }
  });

  it('识别 ASIA AWS STS 临时访问密钥', () => {
    const result = maskSecrets(`aws_sts = ${AWS_STS_KEY}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('aws_sts = ASIAIO••••');
    expect(result.masked).not.toContain('IOSFODNN7EXAMPLE');
  });

  it('识别 Groq gsk_ 密钥', () => {
    const result = maskSecrets(`GROQ_API_KEY=${GROQ_KEY}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('GROQ_API_KEY=gsk_K9••••');
    expect(result.masked).not.toContain(GROQ_KEY);
  });

  it('识别 Perplexity pplx- 密钥', () => {
    const result = maskSecrets(`perplexity: ${PPLX_KEY}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('perplexity: pplx-a1••••');
    expect(result.masked).not.toContain(PPLX_KEY);
  });

  it('识别 xAI xai- 密钥', () => {
    const result = maskSecrets(`xai key ${XAI_KEY}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('xai key xai-Z9••••');
    expect(result.masked).not.toContain(XAI_KEY);
  });

  it('识别 Tavily tvly- 密钥', () => {
    const result = maskSecrets(`tavily=${TAVILY_KEY}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('tavily=tvly-de••••');
    expect(result.masked).not.toContain(TAVILY_KEY);
  });

  it('识别 GitLab glpat- 个人访问令牌', () => {
    const result = maskSecrets(`gitlab: ${GITLAB_PAT}`);
    expect(result.count).toBe(1);
    expect(result.masked).toBe('gitlab: glpat-Ab••••');
    expect(result.masked).not.toContain(GITLAB_PAT);
  });

  it('识别 Stripe sk_live_ / rk_test_ 密钥', () => {
    const liveRes = maskSecrets(`stripe=${STRIPE_SK_LIVE}`);
    expect(liveRes.count).toBe(1);
    expect(liveRes.masked).toBe('stripe=sk_live_51••••');

    const rkRes = maskSecrets(`restricted=${STRIPE_RK_TEST}`);
    expect(rkRes.count).toBe(1);
    expect(rkRes.masked).toBe('restricted=rk_test_99••••');
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
    ['短新平台前缀', 'gsk_short pplx-123 xai-abc tvly-dev glpat-123 sk_live_short gho_123 ASIA12345'],
    ['单词内嵌前缀不误伤', `mygsk_${'a'.repeat(24)} sub_glpat-${'b'.repeat(20)}`],
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
    const text = [
      `key=${OPENAI_KEY}`,
      `bearer=Bearer ${BEARER_TOKEN}`,
      `pwd=password="abcdefghijklmnop"`,
      GHO_TOKEN,
      AWS_STS_KEY,
      GROQ_KEY,
      PPLX_KEY,
      XAI_KEY,
      TAVILY_KEY,
      GITLAB_PAT,
      STRIPE_SK_LIVE,
      STRIPE_RK_TEST,
    ].join(' ');
    const first = maskSecrets(text);
    expect(first.count).toBe(12);

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
