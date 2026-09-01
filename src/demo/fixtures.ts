/**
 * Web 演示壳 - 剧本会话数据
 *
 * 架构（真链路方案）：
 * - 剧本用 playground 的 DemoBlocks 形状编写（易写易读）
 * - 编译为后端形状（BackendMessage/BackendBlock），由 mock 的
 *   `chat_v2_load_session` 返回 → 真实 TauriAdapter restore 进 store
 * - 用户发送后由 scriptPlayer 把 followUp 剧本编译成 BackendEvent
 *   事件序列，emit 到真实 adapter 监听的 channel → 100% 生产链路渲染
 */

import type { AutoReplyScenario } from '@/features/chat/dev/playground/mockData';
import type {
  BackendBlock,
  BackendMessage,
  SessionInfo,
} from '@/features/chat/adapters/types';

export type DemoBlocks = AutoReplyScenario['blocks'];

export interface DemoSessionFixture {
  /** 会话元数据（chat_v2_list_sessions / chat_v2_get_session 返回） */
  meta: SessionInfo & { groupId?: string | null };
  /** 历史消息（chat_v2_load_session 返回） */
  messages: BackendMessage[];
  blocks: BackendBlock[];
  /** 用户自由发送后播放的回复剧本 */
  followUp: DemoBlocks;
}

// ============================================================================
// 剧本 → 后端形状编译器
// ============================================================================

function compileHistory(
  sessionId: string,
  prompt: string,
  reply: DemoBlocks,
  baseTs: number,
): { messages: BackendMessage[]; blocks: BackendBlock[] } {
  const userMsgId = `${sessionId}-u1`;
  const userBlkId = `${sessionId}-u1-b0`;
  const asstMsgId = `${sessionId}-a1`;

  const blocks: BackendBlock[] = [
    {
      id: userBlkId,
      messageId: userMsgId,
      type: 'content',
      status: 'success',
      content: prompt,
      startedAt: baseTs,
      firstChunkAt: baseTs,
      endedAt: baseTs,
    },
  ];

  reply.forEach((b, i) => {
    const startedAt = baseTs + 1000 + i * 1500;
    blocks.push({
      id: `${sessionId}-a1-b${i}`,
      messageId: asstMsgId,
      type: b.type,
      status: 'success',
      content: b.content,
      toolName: b.toolName,
      toolInput: b.toolInput,
      toolOutput: b.toolOutput,
      startedAt,
      firstChunkAt: startedAt + 80,
      endedAt: startedAt + 1200,
    });
  });

  return {
    messages: [
      { id: userMsgId, sessionId, role: 'user', blockIds: [userBlkId], timestamp: baseTs },
      {
        id: asstMsgId,
        sessionId,
        role: 'assistant',
        blockIds: blocks.slice(1).map((b) => b.id),
        timestamp: baseTs + 1000,
      },
    ],
    blocks,
  };
}

function makeFixture(opts: {
  id: string;
  title: string;
  description?: string;
  minutesAgo: number;
  prompt: string;
  reply: DemoBlocks;
  followUp?: DemoBlocks;
}): DemoSessionFixture {
  const updatedAt = new Date(Date.now() - opts.minutesAgo * 60_000);
  const createdAt = new Date(updatedAt.getTime() - 10 * 60_000);
  const { messages, blocks } = compileHistory(
    opts.id,
    opts.prompt,
    opts.reply,
    createdAt.getTime(),
  );
  return {
    meta: {
      id: opts.id,
      mode: 'default',
      title: opts.title,
      description: opts.description,
      persistStatus: 'active',
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      groupId: null,
    },
    messages,
    blocks,
    followUp: opts.followUp ?? DEFAULT_FOLLOW_UP,
  };
}

// ============================================================================
// 罐头回复（自由输入）
// ============================================================================

export const DEFAULT_FOLLOW_UP: DemoBlocks = [
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 350,
    content: `这是 **Deep Student 演示环境** 的模拟回复。

当前页面运行的是与桌面版完全一致的前端界面与事件链路，但数据来自内置剧本，不会连接真实模型。

下载桌面客户端，即可用你的学习内容（教材、题库、笔记）与 AI 深度对话。`,
  },
];

// ============================================================================
// 剧本内容
// ============================================================================

const ANKI_REPLY: DemoBlocks = [
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    delay: 200,
    content: `用户给了三道高数错题：
1. 极限计算（等价无穷小误用）
2. 定积分换元（换元后忘记换上下限）
3. 中值定理证明（构造辅助函数方向错误）

制卡策略：
- 每张卡聚焦一个易错点，正反面分离"错因识别"和"正确做法"
- 用 cloze 卡片不合适——这里用问答卡更利于主动回忆
- 给每张卡打上对应章节标签，便于 FSRS 按知识点调度`,
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `已分析 3 道错题，生成 **5 张 Anki 卡片**（错题 2 拆出了两个独立易错点）：

## 卡片预览

**卡片 1 · 极限**
> **Q**：求 $\\lim_{x \\to 0} \\frac{\\sin x - x}{x^3}$ 时，直接把 $\\sin x$ 换成 $x$ 为什么错？
>
> **A**：等价无穷小替换只能用于**乘除因子**，不能用于相减的项。正确做法：泰勒展开 $\\sin x = x - \\frac{x^3}{6} + o(x^3)$，得极限 $-\\frac{1}{6}$。

**卡片 2 · 定积分**
> **Q**：$\\int_0^{\\pi} \\sin^2 x\\,dx$ 用换元 $u = \\cos x$ 时最容易漏掉什么？
>
> **A**：换元必须**同时换上下限**：$x=0 \\to u=1$，$x=\\pi \\to u=-1$，漏换会得到错误符号。

**卡片 3 · 定积分**
> **Q**：什么结构特征的积分适合"区间再现"技巧（$\\int_a^b f(x)dx = \\int_a^b f(a+b-x)dx$）？
>
> **A**：被积函数含 $\\sin x$、$\\cos x$ 且在 $[0, \\pi]$ 或 $[0, \\frac{\\pi}{2}]$ 上时，优先考虑。

**卡片 4 · 中值定理**
> **Q**：证明"存在 $\\xi$ 使 $f'(\\xi) = \\frac{f(b)-f(a)}{b-a}$"类命题时，辅助函数的构造思路是什么？
>
> **A**：把结论改写为 $F'(\\xi) = 0$ 的形式，$F(x) = f(x) - \\frac{f(b)-f(a)}{b-a}(x-a)$，验证端点值相等后用罗尔定理。

**卡片 5 · 中值定理**
> **Q**：拉格朗日中值定理的两个前提条件分别是什么？缺一会怎样？
>
> **A**：闭区间连续 + 开区间可导。缺连续性结论不成立（如 $f(x)=1/x$ 在 $[-1,1]$）。

---

卡片已写入牌组「高等数学 · 错题本」，FSRS 调度已开启，明天会推送第一轮复习。`,
  },
];

const FEYNMAN_REPLY: DemoBlocks = [
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    delay: 200,
    content: `用户在学"费曼学习法"。这是一个概念讲解类请求，应该：
1. 先给一句话本质
2. 拆解步骤（4 步流程）
3. 结合他的身份（备考场景）给落地建议
4. 可以结合我们的 Anki/题库功能说明如何配合`,
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `## 费曼学习法

**一句话本质**：用"教会别人"倒逼自己暴露理解盲区——讲不清楚的地方，就是没学会的地方。

## 四个步骤

1. **选定概念**：挑一个你正在学的知识点（比如"贝叶斯定理"）
2. **讲给外行听**：想象对面坐着一个 12 岁的小孩，用最朴素的话讲清楚它。禁用术语——每个术语都要翻译成大白话
3. **卡住即回炉**：讲不下去、开始含糊、只能用术语解释术语的地方，就是你的知识裂缝，回到教材重新学这一处
4. **简化和类比**：给这个概念找一个生活类比。好的类比说明你真的理解了（比如把"边际效用递减"比作"吃包子"）

## 和 Deep Student 配合的用法

| 步骤 | 对应功能 |
| --- | --- |
| 讲给外行听 | 直接对我讲，我会追问你含糊的地方 |
| 暴露盲区 | 把卡壳点一键转成题库错题 |
| 定期回炉 | 盲区转成 Anki 卡片，FSRS 自动排期复习 |

> 💡 试试现在就对我讲一个你最近学的概念，我来扮演那个"12 岁的小孩"。`,
  },
];

const RESEARCH_REPLY: DemoBlocks = [
  {
    type: 'web_search',
    status: 'success',
    delay: 400,
    toolName: 'web_search',
    toolInput: { query: 'spaced repetition LLM personalized scheduling 2025' },
    toolOutput: {
      results: [
        { title: 'FSRS-6: 面向大模型的个性化记忆调度', url: 'https://example.com/fsrs6' },
        { title: 'Spaced Repetition at Scale: A 2025 Meta-Analysis', url: 'https://example.com/sr-meta' },
        { title: 'LLM-Generated Anki Cards Improve Retention by 23%', url: 'https://example.com/llm-anki' },
      ],
    },
  },
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    delay: 200,
    content: `检索到 3 篇相关文献。用户关心"间隔重复的最新进展"，重点提炼：
1. 算法侧：FSRS 系列迭代到第 6 版，开始引入 LLM 做难度初判
2. 效果侧：2025 年元分析的整体效应量
3. 与我们产品相关的点：LLM 自动制卡的留存提升数据`,
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `## 间隔重复研究近况（2025）

**算法侧**：FSRS 调度器已迭代到第 6 版，开始用大模型对卡片做"初始难度"预判，新卡片前 3 次复习的安排更合理，早期遗忘率下降约 15%。

**效果侧**：一篇覆盖 42 项实验的元分析显示，间隔重复对长期留存的提升效应量稳定在 **d ≈ 0.55**，且在"生成式回忆"（自己写答案）场景下效应量翻倍。

**最值得关注的交叉点**：LLM 自动生成的 Anki 卡片对照手工卡片，30 天留存率提升 **23%**——原因是 LLM 更擅长把知识点拆成"最小可回忆单元"，避免了一张卡里塞多个考点。

## 对你的建议

- 你的错题本适合用"最小单元"原则重新拆分（一道错题 → 多张单点卡）
- 生成式回忆 > 看卡认答案：复习时先默写再翻面

---

*以上为演示环境的模拟检索结果。*`,
  },
];

// ============================================================================
// 导出
// ============================================================================

export const DEMO_SESSIONS: DemoSessionFixture[] = [
  makeFixture({
    id: 'demo-anki-cards',
    title: '高数错题 → Anki 卡片',
    description: '把三道高数错题整理成 5 张 Anki 卡片',
    minutesAgo: 3,
    prompt: '帮我把这三道高数错题整理成 Anki 卡片，重点突出每道题的易错点',
    reply: ANKI_REPLY,
  }),
  makeFixture({
    id: 'demo-feynman',
    title: '什么是费曼学习法',
    description: '费曼学习法讲解与备考落地建议',
    minutesAgo: 25,
    prompt: '给我讲讲费曼学习法，最好结合我备考的场景',
    reply: FEYNMAN_REPLY,
  }),
  makeFixture({
    id: 'demo-spaced-repetition',
    title: '间隔重复最新研究',
    description: '网络检索 + 间隔重复领域近况综述',
    minutesAgo: 62,
    prompt: '帮我查一下间隔重复（spaced repetition）领域最近有什么新进展',
    reply: RESEARCH_REPLY,
  }),
];

/** 演示用模型列表（get_model_profiles） */
export const DEMO_MODEL_PROFILES = [
  { id: 'demo-deepseek-v4', label: 'DeepSeek V4（演示）', model: 'deepseek-v4' },
  { id: 'demo-kimi-k3', label: 'Kimi K3（演示）', model: 'kimi-k3' },
];
