/**
 * Built-in evaluation cases.
 * 覆盖：长 markdown / 纯代码 / 纯 KaTeX / 重表格 / CJK / 中英混排 / thinking+content / burst / 引用 / 极长
 */

import type { EvalCase } from './types';

const LONG_MARKDOWN = `## DeepSeek-V3 流式响应

DeepSeek-V3 引入了新的 MoE 路由策略，激活参数量约 37B，总参数 671B。

### 核心改动

1. **专家路由**：从 top-2 调整为 top-8，更细粒度
2. **辅助损失**：去除负载均衡损失，改用偏差校正
3. **多头潜在注意力（MLA）**：复用 V2 设计

### 公式

注意力分数：
$$\\text{score}(Q, K) = \\frac{Q K^T}{\\sqrt{d_k}}$$

MoE 门控：
$$g_i = \\text{Softmax}_k(W_g x)_i$$

### 代码

\`\`\`python
def moe_forward(x, experts, gate):
    scores = gate(x)
    top_k = scores.topk(8)
    out = sum(experts[i](x) * w for i, w in zip(top_k.indices, top_k.values))
    return out
\`\`\`

### 表格

| 模型 | 激活参数 | 上下文 | MMLU |
|---|---|---|---|
| V3 | 37B | 128K | 88.5 |
| V2 | 21B | 128K | 78.5 |
| V1 | 7B | 32K  | 70.0 |

> 详见原始论文 Table 4。
`;

const PURE_CODE_TS = `\`\`\`typescript
import { createChatStore } from './store';
import type { Message, Block, Session } from './types';

interface ChatV2Props {
  sessionId: string;
  initialMessages?: Message[];
  onMessage?: (msg: Message) => void;
  onError?: (err: Error) => void;
}

export function ChatV2({ sessionId, initialMessages = [], onMessage, onError }: ChatV2Props) {
  const store = useMemo(() => createChatStore(sessionId), [sessionId]);
  const messages = useStore(store, (s) => s.messages);
  const status = useStore(store, (s) => s.sessionStatus);

  useEffect(() => {
    if (initialMessages.length === 0) return;
    initialMessages.forEach((msg) => store.getState().addMessage(msg));
  }, [initialMessages, store]);

  const send = useCallback(async (text: string) => {
    try {
      const id = generateId('msg');
      const msg: Message = { id, role: 'user', content: text, timestamp: Date.now() };
      store.getState().addMessage(msg);
      onMessage?.(msg);
      await invoke('chat_v2_send', { sessionId, content: text, messageId: id });
    } catch (err) {
      onError?.(err as Error);
    }
  }, [sessionId, store, onMessage, onError]);

  return (
    <div className="chat-v2">
      <MessageList messages={messages} />
      <InputBar onSubmit={send} disabled={status === 'streaming'} />
    </div>
  );
}
\`\`\`
`;

const PURE_KATEX = `## 数学公式集

行内公式 $E = mc^2$ 与 $\\nabla \\cdot \\mathbf{E} = \\rho/\\varepsilon_0$ 都很常见。

$$
\\mathcal{L}(\\theta) = -\\sum_{i=1}^{N} \\log P(x_i | x_{<i}; \\theta)
$$

$$
\\text{Attention}(Q,K,V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right) V
$$

$$
\\frac{\\partial}{\\partial t} \\rho + \\nabla \\cdot (\\rho \\mathbf{u}) = 0
$$

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

$$
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
$$
`;

const HEAVY_TABLE = (() => {
  const rows: string[] = [];
  rows.push('| Idx | Model | Params | Layers | Hidden | MMLU |');
  rows.push('|---|---|---|---|---|---|');
  for (let i = 1; i <= 50; i++) {
    rows.push(`| ${i} | model-${i} | ${(i * 1.7).toFixed(1)}B | ${24 + i} | ${1024 + i * 64} | ${(60 + (i % 30)).toFixed(1)} |`);
  }
  return `## 模型对比\n\n${rows.join('\n')}\n`;
})();

const CJK_ONLY = `## 大模型架构演进

近年来，大语言模型的架构演进呈现出几个明显趋势。第一，参数规模持续增长，但增长速度趋缓，业界开始更关注计算效率而非单纯堆参数。第二，混合专家模型（MoE）成为主流选择，通过条件激活降低推理成本。第三，长上下文能力大幅提升，从早期的两千 tokens 扩展到现在的百万级别。

在注意力机制方面，标准的多头注意力面临内存与计算的双重压力。线性注意力、状态空间模型、滑动窗口等替代方案各有取舍。多头潜在注意力（MLA）通过低秩压缩 KV 缓存，在保持效果的同时显著降低显存占用。这一思路被多个团队采纳并迭代。

训练数据的质量与多样性同样关键。高质量代码、数学、推理数据的占比增加，合成数据的使用也日益广泛。后训练阶段的 RLHF 与 DPO 等对齐方法持续演进，使模型在指令遵循、安全性、有用性之间取得更好平衡。
`;

const CJK_EN_MIXED = `## React 19 关键更新

React 19 introduces several major features. **Actions** simplify form handling and async state management.

\`\`\`tsx
function SubmitButton() {
  const [error, submitAction, isPending] = useActionState(
    async (prev, formData) => { /* ... */ },
    null,
  );
  return <button disabled={isPending}>提交</button>;
}
\`\`\`

新的 \`use()\` hook 可以在 render 期间读取 promise 或 context，但**不能**在条件分支之外使用。

> Note: \`use()\` may suspend the component, so combine it with \`<Suspense>\`.

性能方面，React Compiler（formerly known as React Forget）能自动 memoize，减少手写 \`useMemo\` / \`useCallback\` 的负担。
`;

const THINKING_THEN_CONTENT = `<thinking>
让我分析一下这个问题。用户想了解 Transformer 的核心机制。

我需要解释：
1. Self-Attention 的计算过程
2. Multi-Head 的设计动机
3. 位置编码如何引入序列信息
4. Feed-Forward 在层中的角色

最好用一个直观的类比开始，然后深入数学，最后给代码示例。
</thinking>

## Transformer 核心机制

Transformer 通过 self-attention 让每个位置的表示同时关注序列中所有其他位置。计算分三步：

1. **生成 Q/K/V 三组向量**：通过线性投影
2. **打分**：$\\text{score}(Q,K) = QK^T / \\sqrt{d_k}$
3. **加权求和**：softmax 后乘以 V

\`\`\`python
def attention(q, k, v):
    scores = q @ k.transpose(-2, -1) / (q.size(-1) ** 0.5)
    attn = scores.softmax(dim=-1)
    return attn @ v
\`\`\`
`;

const BURST_SHORT = `好的。

我来回答你的问题。

React 19 主要新增了 Actions、use() hook、Server Components 优化。

需要更详细的说明吗？
`;

const WITH_CITATIONS = `根据知识库内容，Transformer 架构由以下部分组成 [知识库-1]：

- 编码器堆栈
- 解码器堆栈
- Self-Attention 模块
- Feed-Forward 网络

其中 Self-Attention 的计算复杂度为 $O(n^2 d)$ [知识库-2]。

参考网络资料 [网络-1]，FlashAttention 通过 tiling 与 online softmax 大幅降低显存占用。
`;

const EXTREME_LONG = (() => {
  const seg = LONG_MARKDOWN + '\n---\n\n' + CJK_ONLY + '\n---\n\n' + PURE_KATEX + '\n---\n\n';
  return (seg + seg).slice(0, 8000);
})();

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'long-markdown-mixed',
    label: 'Long markdown (mixed)',
    description: 'Markdown + KaTeX + code + table',
    source: LONG_MARKDOWN,
    targetCps: 480,
  },
  {
    id: 'pure-code-typescript',
    label: 'Pure code · TypeScript',
    description: 'Long TS code block',
    source: PURE_CODE_TS,
    targetCps: 500,
  },
  {
    id: 'pure-katex',
    label: 'Pure KaTeX',
    description: '6 display math blocks',
    source: PURE_KATEX,
    targetCps: 300,
  },
  {
    id: 'heavy-table',
    label: 'Heavy table',
    description: '50-row table',
    source: HEAVY_TABLE,
    targetCps: 600,
  },
  {
    id: 'cjk-only',
    label: 'CJK only',
    description: 'Long Chinese paragraphs',
    source: CJK_ONLY,
    targetCps: 360,
  },
  {
    id: 'cjk-en-mixed',
    label: 'CJK + English mixed',
    description: 'Code + ZH + EN inline',
    source: CJK_EN_MIXED,
    targetCps: 420,
  },
  {
    id: 'thinking-then-content',
    label: 'Thinking → content',
    description: '<thinking> tag + main answer',
    source: THINKING_THEN_CONTENT,
    targetCps: 480,
  },
  {
    id: 'burst-short',
    label: 'Burst short replies',
    description: 'Multiple short paragraphs',
    source: BURST_SHORT,
    targetCps: 500,
  },
  {
    id: 'with-citations',
    label: 'With citations',
    description: 'Inline citation placeholders',
    source: WITH_CITATIONS,
    targetCps: 480,
  },
  {
    id: 'extreme-long',
    label: 'Extreme long (8K)',
    description: '8000-char concatenation',
    source: EXTREME_LONG,
    targetCps: 600,
  },
];
