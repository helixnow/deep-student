/**
 * LLM Output Playground - 模拟数据生成器
 *
 * 覆盖所有 BlockType 和 BlockStatus 的模拟内容，
 * 用于视觉调试 LLM 输出渲染效果。
 */

import type { BlockType, BlockStatus } from '../../core/types/block';
import type { TodoListOutput } from '../../plugins/blocks/todoList';

// ============================================================================
// 模拟内容模板
// ============================================================================

/** Markdown 富文本演示 */
export const MOCK_MARKDOWN_CONTENT = `## 这是一个 Markdown 渲染演示

### 代码块

\`\`\`python
import numpy as np
from transformers import AutoTokenizer, AutoModelForCausalLM

def generate_response(prompt: str, max_tokens: int = 512) -> str:
    """使用 LLM 生成回复"""
    tokenizer = AutoTokenizer.from_pretrained("deepseek-ai/deepseek-v3")
    model = AutoModelForCausalLM.from_pretrained("deepseek-ai/deepseek-v3")
    
    inputs = tokenizer(prompt, return_tensors="pt")
    outputs = model.generate(**inputs, max_new_tokens=max_tokens)
    return tokenizer.decode(outputs[0], skip_special_tokens=True)
\`\`\`

\`\`\`typescript
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

function processStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  return async function* () {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  };
}
\`\`\`

### LaTeX 数学公式

行内公式：$E = mc^2$，以及 $\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}$

块级公式：

$$
\\mathcal{L}(\\theta) = \\sum_{i=1}^{N} \\log P(x_i | x_{<i}; \\theta) = \\sum_{i=1}^{N} \\log \\frac{\\exp(h_i^T w_{x_i})}{\\sum_{j=1}^{V} \\exp(h_i^T w_j)}
$$

$$
\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V
$$

### 表格

| 模型 | 参数量 | 上下文长度 | MMLU |
|------|--------|-----------|------|
| DeepSeek-V3 | 671B | 128K | 88.5 |
| GPT-4o | ~200B | 128K | 87.2 |
| Claude 3.5 | ~175B | 200K | 88.7 |
| Qwen-2.5 | 72B | 128K | 85.3 |

### 列表

1. **有序列表项 1** - 带有加粗文本
2. *有序列表项 2* - 带有斜体文本
3. ~~有序列表项 3~~ - 带有删除线
4. \`有序列表项 4\` - 带有行内代码

- 无序列表项
  - 嵌套列表项
    - 更深层嵌套
  - 另一个嵌套项

### 引用

> 这是一段引用文本。引用可以包含 **加粗**、*斜体* 和 \`代码\`。
>
> > 嵌套引用也是支持的。

### 链接和图片

[DeepSeek 官网](https://deepseek.com) | [GitHub](https://github.com)

### 任务列表

- [x] 已完成的任务
- [x] 另一个已完成的任务
- [ ] 未完成的任务
- [ ] 待处理的任务
`;

/** 思维链演示 */
export const MOCK_THINKING_CONTENT = `让我分析一下这个问题...

首先，我需要理解用户的需求：
1. 用户想要了解 Transformer 架构的核心原理
2. 需要用简单的语言解释
3. 最好能给出直观的类比

让我从 Self-Attention 机制开始解释：
- Query、Key、Value 的概念可以类比为"搜索引擎"
- Query 是你的搜索词
- Key 是每个文档的标题/标签
- Value 是文档的实际内容

注意力分数的计算：
$$\\text{score}(Q, K) = \\frac{Q \\cdot K^T}{\\sqrt{d_k}}$$

这里除以 $\\sqrt{d_k}$ 是为了防止点积值过大导致 softmax 梯度消失。

接下来考虑多头注意力的好处：
- 不同的头可以关注不同类型的关系
- 有的头关注语法结构
- 有的头关注语义相似性
- 有的头关注位置关系

我认为最好的解释方式是先给出整体架构图，然后逐层深入...`;

/** 短回复 */
export const MOCK_SHORT_CONTENT = `好的，我来帮你解释一下。

React Hooks 的核心思想是让函数组件拥有状态管理和副作用处理的能力，而不需要使用 class 组件。

最常用的 Hooks：
- \`useState\` - 状态管理
- \`useEffect\` - 副作用处理
- \`useMemo\` / \`useCallback\` - 性能优化`;

/** 工具调用模拟数据 */
export const MOCK_TOOL_CALLS: Record<string, { toolName: string; toolInput: Record<string, unknown>; toolOutput?: unknown }> = {
  web_search: {
    toolName: 'web_search',
    toolInput: { query: 'React 19 new features 2024', max_results: 5 },
    toolOutput: {
      results: [
        { title: 'React 19 Release Notes', url: 'https://react.dev/blog/2024/react-19', snippet: 'React 19 introduces Actions, use() hook, and more...' },
        { title: 'What\'s New in React 19', url: 'https://example.com/react-19', snippet: 'A comprehensive guide to React 19 features...' },
      ],
    },
  },
  mcp_tool: {
    toolName: 'file_read',
    toolInput: { path: '/src/components/App.tsx', encoding: 'utf-8' },
    toolOutput: 'import React from "react";\n\nexport function App() {\n  return <div>Hello World</div>;\n}',
  },
  image_gen: {
    toolName: 'image_generation',
    toolInput: { prompt: '一只可爱的猫咪坐在书桌上，旁边有一台笔记本电脑，赛博朋克风格', size: '1024x1024', model: 'dall-e-3' },
    toolOutput: { url: 'https://placehold.co/1024x1024/1a1a2e/e0e0e0?text=Generated+Image', revised_prompt: 'A cute cat sitting on a desk...' },
  },
  academic_search: {
    toolName: 'academic_search',
    toolInput: { query: 'attention mechanism transformer architecture', limit: 3 },
    toolOutput: {
      papers: [
        { title: 'Attention Is All You Need', authors: 'Vaswani et al.', year: 2017, citations: 95000 },
        { title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: 'Devlin et al.', year: 2019, citations: 72000 },
      ],
    },
  },
  todo_init: {
    toolName: 'todo_init',
    toolInput: {
      title: '迁移 study-ui playground 调试能力',
      steps: [
        '梳理真实阻塞交互链路',
        '补 ask_user / approval / tool_limit playground',
        '增加 todo sample 数据与交互入口',
        '跑测试并记录剩余风险',
      ],
    },
    toolOutput: {
      success: true,
      todoListId: 'todo_playground_migration',
      title: '迁移 study-ui playground 调试能力',
      progress: '2/4 completed',
      completedCount: 2,
      totalCount: 4,
      isAllDone: false,
      continue_execution: true,
      currentRunning: {
        id: 'todo_3',
        description: '增加 todo sample 数据与交互入口',
        status: 'running',
        createdAt: 1716307200000,
        updatedAt: 1716307800000,
      },
      nextStep: {
        id: 'todo_4',
        description: '跑测试并记录剩余风险',
        status: 'pending',
        createdAt: 1716307200000,
      },
      steps: [
        {
          id: 'todo_1',
          description: '梳理真实阻塞交互链路',
          status: 'completed',
          result: '已确认输入栏接管依赖 pendingBlockingInteraction。',
          createdAt: 1716307200000,
          updatedAt: 1716307300000,
        },
        {
          id: 'todo_2',
          description: '补 ask_user / approval / tool_limit playground',
          status: 'completed',
          result: '真实阻塞交互入口已接入控制面板。',
          createdAt: 1716307200000,
          updatedAt: 1716307600000,
        },
        {
          id: 'todo_3',
          description: '增加 todo sample 数据与交互入口',
          status: 'running',
          result: '正在校准 todo panel 的 sample 数据与折叠摘要。',
          createdAt: 1716307200000,
          updatedAt: 1716307800000,
        },
        {
          id: 'todo_4',
          description: '跑测试并记录剩余风险',
          status: 'pending',
          createdAt: 1716307200000,
        },
      ],
      message: '还剩 2 项，继续执行中。',
    } satisfies TodoListOutput,
  },
};

export const PLAYGROUND_BLOCKING_SAMPLES = {
  askUser: {
    question: '你希望我下一步怎么做？',
    options: ['继续自动执行', '先解释方案', '只给我 patch'],
    allowCustom: true,
    context: '这是 playground 中的真实 ask_user 调试入口，会接管输入栏。',
  },
  toolApproval: {
    toolName: 'builtin-session_archive',
    arguments: {
      session_ids: ['sess_alpha', 'sess_beta'],
      confirmed: false,
    },
    sensitivity: 'high' as const,
    description: '调试真实审批条，验证参数展开、批准/拒绝与 resolved 状态。',
    timeoutSeconds: 45,
  },
  toolLimit: {
    content: '已达到工具调用上限，点击继续以验证真实 tool_limit 接管条。',
  },
  todoList: {
    toolName: 'todo_init',
    toolInput: MOCK_TOOL_CALLS.todo_init.toolInput,
    toolOutput: MOCK_TOOL_CALLS.todo_init.toolOutput as TodoListOutput,
    content: 'Agent 已初始化一份待办列表，正在执行第 3 步。',
  },
};

/** RAG 检索模拟 */
export const MOCK_RAG_CITATIONS = [
  { id: 'cite-1', source: '深度学习基础.pdf', page: 42, content: 'Transformer 架构由编码器和解码器组成...' },
  { id: 'cite-2', source: '机器学习笔记.md', page: 15, content: '注意力机制允许模型关注输入序列的不同部分...' },
  { id: 'cite-3', source: 'NLP 教程第三章.pdf', page: 78, content: '自注意力机制的计算复杂度为 O(n²d)...' },
];

// ============================================================================
// Block 模板工厂
// ============================================================================

export interface MockBlockTemplate {
  type: BlockType;
  label: string;
  description: string;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  citations?: typeof MOCK_RAG_CITATIONS;
  /** 默认状态 */
  defaultStatus: BlockStatus;
  /** 是否支持流式模拟 */
  supportsStreaming: boolean;
}

/**
 * 所有可用的 Block 模板
 */
export const BLOCK_TEMPLATES: MockBlockTemplate[] = [
  // === 流式内容块 ===
  {
    type: 'thinking',
    label: '思维链',
    description: '模拟 LLM 推理过程（thinking/reasoning）',
    content: MOCK_THINKING_CONTENT,
    defaultStatus: 'success',
    supportsStreaming: true,
  },
  {
    type: 'content',
    label: '正文内容',
    description: '主要文本输出（Markdown + LaTeX + 代码）',
    content: MOCK_MARKDOWN_CONTENT,
    defaultStatus: 'success',
    supportsStreaming: true,
  },
  {
    type: 'content',
    label: '短回复',
    description: '简短的文本回复',
    content: MOCK_SHORT_CONTENT,
    defaultStatus: 'success',
    supportsStreaming: true,
  },
  // === 知识检索块 ===
  {
    type: 'rag',
    label: 'RAG 知识库检索',
    description: '文档知识库检索结果',
    citations: MOCK_RAG_CITATIONS,
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'memory',
    label: '用户记忆',
    description: '用户记忆检索',
    content: '检索到 3 条相关记忆',
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'web_search',
    label: '网络搜索',
    description: '网络搜索结果',
    ...MOCK_TOOL_CALLS.web_search,
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'multimodal_rag',
    label: '多模态知识库',
    description: '多模态知识库检索',
    content: '检索到 5 个相关图文片段',
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'academic_search',
    label: '学术搜索',
    description: '学术论文搜索结果',
    ...MOCK_TOOL_CALLS.academic_search,
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  // === 工具调用块 ===
  {
    type: 'mcp_tool',
    label: 'MCP 工具调用',
    description: '外部工具调用（文件读取示例）',
    ...MOCK_TOOL_CALLS.mcp_tool,
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'image_gen',
    label: '图片生成',
    description: '图片生成工具调用',
    ...MOCK_TOOL_CALLS.image_gen,
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  // === 特殊功能块 ===
  {
    type: 'anki_cards',
    label: 'Anki 卡片',
    description: 'Anki 闪卡生成',
    content: JSON.stringify([
      { front: 'Transformer 的核心机制是什么？', back: 'Self-Attention（自注意力机制）' },
      { front: 'Multi-Head Attention 的作用？', back: '让模型同时关注不同子空间的信息' },
    ]),
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'todo_list',
    label: '待办列表',
    description: '待办事项生成',
    content: JSON.stringify([
      { text: '阅读 Attention Is All You Need 论文', done: true },
      { text: '实现简单的 Self-Attention', done: false },
      { text: '对比 RNN 和 Transformer 的性能', done: false },
    ]),
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'ask_user',
    label: '用户交互',
    description: '向用户提问/确认',
    content: '你希望我用哪种编程语言来实现这个算法？\n\n1. Python\n2. TypeScript\n3. Rust',
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'template_preview',
    label: '模板预览',
    description: '模板预览卡片',
    content: '{"templateId": "tpl_001", "name": "学术论文分析模板"}',
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  // === 多 Agent 协作块 ===
  {
    type: 'workspace_status',
    label: '工作区状态',
    description: '多 Agent 工作区状态面板',
    content: JSON.stringify({
      agents: [
        { id: 'agent-1', name: '研究员', status: 'running', task: '搜索相关论文' },
        { id: 'agent-2', name: '编码员', status: 'pending', task: '等待研究结果' },
        { id: 'agent-3', name: '审核员', status: 'idle', task: '待分配' },
      ],
    }),
    defaultStatus: 'running',
    supportsStreaming: false,
  },
  {
    type: 'subagent_embed',
    label: '子代理嵌入',
    description: '子代理执行结果嵌入',
    content: '子代理已完成论文摘要提取任务',
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  {
    type: 'subagent_retry',
    label: '子代理重试',
    description: '子代理重试提醒',
    content: '子代理执行超时，建议重试',
    defaultStatus: 'error',
    supportsStreaming: false,
  },
  {
    type: 'sleep',
    label: '协调器休眠',
    description: '协调器等待状态',
    content: '等待子代理完成...',
    defaultStatus: 'running',
    supportsStreaming: false,
  },
  // === 系统提示块 ===
  {
    type: 'tool_limit',
    label: '工具递归限制',
    description: '工具调用达到递归上限',
    content: '已达到工具调用上限（30次），停止递归执行。',
    defaultStatus: 'error',
    supportsStreaming: false,
  },
  // === 知识图谱 ===
  {
    type: 'graph',
    label: '知识图谱',
    description: '知识图谱检索结果',
    content: JSON.stringify({
      nodes: ['Transformer', 'Attention', 'BERT', 'GPT'],
      edges: [
        { from: 'Transformer', to: 'Attention', label: '核心机制' },
        { from: 'Transformer', to: 'BERT', label: '衍生模型' },
        { from: 'Transformer', to: 'GPT', label: '衍生模型' },
      ],
    }),
    defaultStatus: 'success',
    supportsStreaming: false,
  },
  // === 后端扩展块 ===
  {
    type: 'paper_save',
    label: '论文保存',
    description: '论文保存进度',
    content: '正在保存论文到知识库...',
    defaultStatus: 'running',
    supportsStreaming: false,
  },
  // === 通用/回退 ===
  {
    type: 'generic',
    label: '通用块（兜底）',
    description: '未知类型的回退渲染',
    content: '这是一个未知类型的块，使用通用渲染器显示。',
    defaultStatus: 'success',
    supportsStreaming: false,
  },
];

/**
 * 所有可用的 BlockStatus
 */
export const ALL_BLOCK_STATUSES: BlockStatus[] = ['pending', 'running', 'success', 'error'];

/**
 * 预设的自动回复场景
 */
export interface AutoReplyScenario {
  id: string;
  label: string;
  description: string;
  /** 要生成的 block 序列 */
  blocks: Array<{
    type: BlockType;
    status: BlockStatus;
    content?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: unknown;
    /** 模拟延迟（ms） */
    delay?: number;
    /** 是否模拟流式输出 */
    streaming?: boolean;
  }>;
}

export const AUTO_REPLY_SCENARIOS: AutoReplyScenario[] = [
  {
    id: 'full-response',
    label: '完整回复（思考 + 正文）',
    description: '模拟标准的 thinking + content 流式输出',
    blocks: [
      { type: 'thinking', status: 'success', content: MOCK_THINKING_CONTENT, delay: 100, streaming: true },
      { type: 'content', status: 'success', content: MOCK_MARKDOWN_CONTENT, delay: 200, streaming: true },
    ],
  },
  {
    id: 'rag-response',
    label: 'RAG 检索 + 回复',
    description: '先检索知识库，再生成回复',
    blocks: [
      { type: 'rag', status: 'success', delay: 300 },
      { type: 'thinking', status: 'success', content: '基于检索到的文档，让我来回答...', delay: 100, streaming: true },
      { type: 'content', status: 'success', content: MOCK_SHORT_CONTENT, delay: 200, streaming: true },
    ],
  },
  {
    id: 'web-search-response',
    label: '网络搜索 + 回复',
    description: '先搜索网络，再生成回复',
    blocks: [
      { type: 'web_search', status: 'success', ...MOCK_TOOL_CALLS.web_search, delay: 500 },
      { type: 'content', status: 'success', content: '根据搜索结果，React 19 引入了以下新特性...', delay: 200, streaming: true },
    ],
  },
  {
    id: 'tool-chain',
    label: '工具链调用',
    description: '多个工具连续调用',
    blocks: [
      { type: 'thinking', status: 'success', content: '我需要先读取文件，然后搜索相关资料...', delay: 100, streaming: true },
      { type: 'mcp_tool', status: 'success', ...MOCK_TOOL_CALLS.mcp_tool, delay: 400 },
      { type: 'web_search', status: 'success', ...MOCK_TOOL_CALLS.web_search, delay: 400 },
      { type: 'content', status: 'success', content: '综合以上信息，我的分析如下...', delay: 200, streaming: true },
    ],
  },
  {
    id: 'image-gen',
    label: '图片生成',
    description: '思考 + 图片生成 + 说明',
    blocks: [
      { type: 'thinking', status: 'success', content: '用户想要一张赛博朋克风格的猫咪图片...', delay: 100, streaming: true },
      { type: 'image_gen', status: 'success', ...MOCK_TOOL_CALLS.image_gen, delay: 2000 },
      { type: 'content', status: 'success', content: '我已经为你生成了一张赛博朋克风格的猫咪图片。', delay: 100, streaming: true },
    ],
  },
  {
    id: 'multi-agent',
    label: '多 Agent 协作',
    description: '工作区状态 + 子代理 + 结果',
    blocks: [
      { type: 'workspace_status', status: 'running', delay: 200 },
      { type: 'subagent_embed', status: 'success', content: '研究员完成了论文检索', delay: 1000 },
      { type: 'workspace_status', status: 'success', delay: 200 },
      { type: 'content', status: 'success', content: '所有代理已完成任务，以下是综合结果...', delay: 200, streaming: true },
    ],
  },
  {
    id: 'error-recovery',
    label: '错误 + 恢复',
    description: '工具调用失败后重试成功',
    blocks: [
      { type: 'mcp_tool', status: 'error', toolName: 'file_read', toolInput: { path: '/nonexistent' }, delay: 300 },
      { type: 'thinking', status: 'success', content: '文件读取失败，让我尝试其他路径...', delay: 100, streaming: true },
      { type: 'mcp_tool', status: 'success', ...MOCK_TOOL_CALLS.mcp_tool, delay: 300 },
      { type: 'content', status: 'success', content: '找到了正确的文件，内容如下...', delay: 200, streaming: true },
    ],
  },
  {
    id: 'all-running',
    label: '全部加载中',
    description: '所有块都处于 running 状态（调试加载动画）',
    blocks: [
      { type: 'thinking', status: 'running', content: '正在思考', delay: 0 },
      { type: 'rag', status: 'running', delay: 0 },
      { type: 'web_search', status: 'running', delay: 0 },
      { type: 'mcp_tool', status: 'running', toolName: 'file_read', toolInput: { path: '/src/app.ts' }, delay: 0 },
      { type: 'image_gen', status: 'running', toolName: 'image_generation', toolInput: { prompt: 'loading...' }, delay: 0 },
    ],
  },
  {
    id: 'all-errors',
    label: '全部错误',
    description: '所有块都处于 error 状态（调试错误样式）',
    blocks: [
      { type: 'thinking', status: 'error', content: '思考过程中断', delay: 0 },
      { type: 'content', status: 'error', content: '内容生成失败', delay: 0 },
      { type: 'mcp_tool', status: 'error', toolName: 'file_read', toolInput: { path: '/error' }, delay: 0 },
      { type: 'web_search', status: 'error', delay: 0 },
    ],
  },
  {
    id: 'academic-flow',
    label: '学术研究流程',
    description: '学术搜索 + 记忆 + 图谱 + 回复',
    blocks: [
      { type: 'memory', status: 'success', content: '检索到 2 条相关记忆', delay: 200 },
      { type: 'academic_search', status: 'success', ...MOCK_TOOL_CALLS.academic_search, delay: 500 },
      { type: 'graph', status: 'success', delay: 300 },
      { type: 'thinking', status: 'success', content: '综合记忆、学术文献和知识图谱...', delay: 100, streaming: true },
      { type: 'content', status: 'success', content: MOCK_MARKDOWN_CONTENT, delay: 200, streaming: true },
    ],
  },
];
