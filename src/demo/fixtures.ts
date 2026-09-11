/**
 * Web 演示壳 - 剧本会话数据
 *
 * 架构（真链路方案）：
 * - 剧本用 playground 的 DemoBlocks 形状编写（易写易读）
 * - 会话静态历史为空；点进会话后 autoPlay 经真实 store.sendMessage 发送第一问
 * - mock 的 chat_v2_send_message 把回复剧本转成 BackendEvent 事件序列，
 *   emit 到真实 adapter 监听的 channel → 100% 生产链路渲染
 *
 * 剧本设计原则（2026-09 改版）：
 * - 每个会话演示一条"集成链"（检索 → 引用 → 产出可交互产物），而不是纯文本问答
 * - 块类型全部走生产渲染器：rag / memory / web_search / academic_search /
 *   anki_cards / todo_init / 正文内联引用徽章（[知识库-N] [搜索-N] [PDF@id:页] [思维导图:mm_xx]）
 * - 数据契约与真实后端对齐（sources / TodoListOutput / AnkiCardsBlockData），
 *   文献与工具名尽量使用真实存在的（FSRS、PNAS 2019、ACL 2016 等）
 */

import type { AutoReplyScenario } from '@/features/chat/dev/playground/mockData';
import type {
  BackendBlock,
  BackendMessage,
  SessionInfo,
} from '@/features/chat/adapters/types';
import type { ContextRef } from '@/features/chat/context/types';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
import type { GeneratedQuestionDraft } from '@/types/qbankGeneration';
import {
  DEMO_IMAGE_ASSETS,
  DEMO_PDF_NAME,
  DEMO_PDF_RESOURCE_ID,
  DEMO_PDF_SOURCE_ID,
} from './attachmentAssets';

/** 演示块定义：在生产 AutoReplyScenario 块的基础上加演示节奏字段 */
export type DemoBlockDef = AutoReplyScenario['blocks'][number] & {
  /** 非流式块的模拟执行耗时（覆盖 scriptPlayer 的 PACE.toolDwell） */
  dwellMs?: number;
  /**
   * 逐条 chunk 原文（与 content 流式互斥）。
   * 用于 anki_cards 这类"chunk 即完整 JSON 记录"的流式协议——
   * 每条元素作为一个 chunk 事件原样 emit，由生产解析器逐条消费。
   */
  chunks?: string[];
  /** start 事件附加 payload（如 anki_cards 的 templateId / options.deck_name） */
  payload?: Record<string, unknown>;
};

export type DemoBlocks = DemoBlockDef[];

export interface DemoFollowUp {
  id: string;
  label: string;
  prompt: string;
  reply: DemoBlocks;
}

export interface DemoSessionFixture {
  /** 会话元数据（chat_v2_list_sessions / chat_v2_get_session 返回） */
  meta: SessionInfo & { groupId?: string | null };
  /** 历史消息（chat_v2_load_session 返回）——演示固定为空，首轮问答由自动播放实时完成 */
  messages: BackendMessage[];
  blocks: BackendBlock[];
  /** 首轮发送播放的回复剧本（自动播放的第一答；首播后自由输入走 DEFAULT_FOLLOW_UP） */
  followUp: DemoBlocks;
  /** 点进会话时自动播放的首条用户消息（经真实 sendMessage 链路发送） */
  autoPrompt?: string;
  /**
   * 首条消息携带的附件引用（autoPlay 在打字前经生产 addContextRef 注入
   * pendingContextRefs，发送时由 store 打包进 _meta.contextSnapshot——
   * 缩略图/文件 chip/点击预览全走真实链路）
   */
  attachmentRefs?: ContextRef[];
  continuations?: DemoFollowUp[];
}

// ============================================================================
// 剧本 → 后端形状编译器
// ============================================================================

function makeFixture(opts: {
  id: string;
  title: string;
  description?: string;
  minutesAgo: number;
  /** 进入会话后自动发送的第一条用户消息（经真实 sendMessage 链路） */
  autoPrompt: string;
  /** 首条消息携带的附件引用（见 DemoSessionFixture.attachmentRefs） */
  attachmentRefs?: ContextRef[];
  /** 自动播放的回复剧本（思维链 + 流式输出 + 工具块） */
  reply: DemoBlocks;
  continuations?: DemoFollowUp[];
}): DemoSessionFixture {
  const updatedAt = new Date(Date.now() - opts.minutesAgo * 60_000);
  const createdAt = new Date(updatedAt.getTime() - 10 * 60_000);
  return {
    meta: {
      id: opts.id,
      mode: 'chat',
      title: opts.title,
      description: opts.description,
      persistStatus: 'active',
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      groupId: null,
    },
    // 静态历史为空：第一问第一答由自动播放实时走完，观感从头开始
    messages: [],
    blocks: [],
    followUp: opts.reply,
    autoPrompt: opts.autoPrompt,
    attachmentRefs: opts.attachmentRefs,
    continuations: opts.continuations,
  };
}

// ============================================================================
// 演示用 Anki 模板（get_all_custom_templates mock 返回；
// 卡片带 template_id 时块内走 ShadowDOM 模板渲染 + 翻面，和桌面版一致）
// ============================================================================

const DEMO_TEMPLATE_BASE = {
  author: 'Deep Student',
  version: '1.0',
  generation_prompt: '',
  preview_front: '',
  preview_back: '',
  is_active: true,
  is_built_in: true,
};

export const DEMO_ANKI_TEMPLATES: CustomAnkiTemplate[] = [
  {
    ...DEMO_TEMPLATE_BASE,
    id: 'tpl_demo_basic',
    name: '问答题',
    description: '标准问答卡：正面问题，背面答案',
    note_type: 'Basic',
    fields: ['Front', 'Back'],
    front_template:
      '<div class="card"><div class="qa-front">{{Front}}</div></div>',
    back_template:
      '<div class="card"><div class="qa-front qa-front--dim">{{Front}}</div><hr id="answer" /><div class="qa-back">{{Back}}</div></div>',
    // 注意：沙箱把模板输出直接放进 body，没有 .card 外壳；这里手动包一层。
    // 颜色不写死——跟随沙箱暗色兜底的 body 前景色，深浅主题都可读。
    css_style:
      '.card { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 15px; line-height: 1.75; padding: 18px 20px; box-sizing: border-box; } ' +
      '.qa-front { font-weight: 600; } ' +
      '.qa-front--dim { font-weight: 500; opacity: 0.6; font-size: 13px; } ' +
      '.qa-back { white-space: pre-wrap; } ' +
      'hr#answer { border: none; border-top: 1px dashed currentColor; opacity: 0.3; margin: 10px 0; }',
    field_extraction_rules: {
      Front: { field_type: 'text', is_required: true, description: '问题' },
      Back: { field_type: 'text', is_required: true, description: '答案' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as CustomAnkiTemplate,
  {
    ...DEMO_TEMPLATE_BASE,
    id: 'tpl_demo_cloze',
    name: '填空题',
    description: '挖空卡：{{c1::答案}} 背诵模式',
    note_type: 'Cloze',
    fields: ['Text'],
    front_template:
      '<div class="card"><div class="cloze-text">{{cloze:Text}}</div></div>',
    back_template:
      '<div class="card"><div class="cloze-text">{{cloze:Text}}</div></div>',
    css_style:
      '.card { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 15px; line-height: 1.75; padding: 18px 20px; box-sizing: border-box; } ' +
      '.cloze-text { white-space: pre-wrap; } ' +
      // 引擎正面输出 .cloze（挖空占位），背面输出 .cloze-revealed（揭示答案）
      '.cloze { font-weight: 700; border-bottom: 1.5px dashed currentColor; padding: 0 2px; } ' +
      '.cloze-revealed { font-weight: 700; border-bottom: 1.5px solid currentColor; padding: 0 2px; }',
    field_extraction_rules: {
      Text: { field_type: 'text', is_required: true, description: '挖空文本' },
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as CustomAnkiTemplate,
];

// ============================================================================
// 演示用思维导图（vfs_get_mindmap / vfs_get_mindmap_content mock 返回；
// 正文里的 [思维导图:mm_demo_mlsys_ch3:标题] 会内嵌渲染这张导图的 ReactFlow 预览）
// ============================================================================

export const DEMO_MINDMAP_ID = 'mm_demo_mlsys_ch3';

export const DEMO_MINDMAP_META = {
  id: DEMO_MINDMAP_ID,
  resourceId: DEMO_MINDMAP_ID,
  title: '第 3 章 · 数据并行训练',
  description: '《机器学习系统》第 3 章知识框架',
  isFavorite: false,
  defaultView: 'mindmap' as const,
  createdAt: '2026-08-30T09:12:00.000Z',
  updatedAt: '2026-09-01T21:40:00.000Z',
};

const mmNode = (id: string, text: string, children: unknown[] = []) => ({
  id,
  text,
  children,
});

export const DEMO_MINDMAP_CONTENT = JSON.stringify({
  version: '1.0',
  root: mmNode('root', '数据并行训练', [
    mmNode('n1', '基本范式', [
      mmNode('n1-1', 'mini-batch 切分到 K 个 worker'),
      mmNode('n1-2', '参数服务器 / AllReduce 聚合梯度'),
      mmNode('n1-3', '更新值广播回各 worker'),
    ]),
    mmNode('n2', '同步的代价', [
      mmNode('n2-1', 'straggler 效应'),
      mmNode('n2-2', '加速比偏离线性'),
    ]),
    mmNode('n3', '优化方向', [
      mmNode('n3-1', '梯度压缩（量化 / 稀疏化）'),
      mmNode('n3-2', '计算与通信重叠'),
      mmNode('n3-3', '异步 SGD（陈旧梯度）'),
    ]),
  ]),
  meta: { createdAt: '2026-08-30T09:12:00.000Z', updatedAt: '2026-09-01T21:40:00.000Z' },
});

// ============================================================================
// 罐头回复（自由输入）
// ============================================================================

export const DEFAULT_FOLLOW_UP: DemoBlocks = [
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 350,
    content: `这里的交互内容来自预设学习材料。你可以打开 PDF 页码引用、查看章节导图、翻阅卡片，以及展开会话底部的学习产物。

下载 Deep Student 桌面版并连接所选模型后，就可以带入自己的教材、照片与笔记，继续提问、整理资料和准备练习。`,
  },
];

// ============================================================================
// 剧本 ①：高数错题 → Anki 卡片（知识库检索 + 内联引用 + 交互卡片栈）
// ============================================================================

// 注意：卡片正文走模板 ShadowDOM 渲染（anka 模板引擎不做 markdown/LaTeX
// 后处理），所以卡片字段一律用纯文本 + Unicode 数学符号，不写 $...$ / ** 标记。
const ANKI_CARDS: AnkiCard[] = [
  {
    id: 'chat-batch-demo-1',
    front: '求 lim(x→0) (sin x − x) / x³ 时，泰勒展开应保留到哪一阶？',
    back: '保留到三阶。\n展开 sin x = x − x³/6 + o(x³)，相减后首个非零项是 −x³/6，除以 x³ 得极限 −1/6。',
    tags: ['高数', '极限', '等价无穷小'],
    images: [],
    template_id: 'tpl_demo_basic',
  },
  {
    id: 'chat-batch-demo-2',
    front: '∫₀^π sin²x dx 用换元 u = cos x 时，上下限和微分怎样变化？',
    back: 'x = 0 对应 u = 1，x = π 对应 u = −1，du = −sin x dx。\n在 [0, π] 上 sin x ≥ 0，原式转为 ∫₋₁¹ √(1 − u²) du = π/2。',
    tags: ['高数', '定积分', '换元法'],
    images: [],
    template_id: 'tpl_demo_basic',
  },
  {
    id: 'chat-batch-demo-3',
    front: '什么结构特征的定积分适合用「区间再现」∫ₐᵇ f(x) dx = ∫ₐᵇ f(a+b−x) dx？',
    back: '被积函数由 sin x、cos x 构成且积分区间为 [0, π] 或 [0, π/2] 时优先考虑。',
    tags: ['高数', '定积分', '技巧'],
    images: [],
    template_id: 'tpl_demo_basic',
  },
  {
    id: 'chat-batch-demo-4',
    front: '证明「存在 ξ 使 f′(ξ) = (f(b) − f(a)) / (b − a)」类命题时，辅助函数怎么构造？',
    back: '把结论改写为 F′(ξ) = 0 的形式：F(x) = f(x) − [(f(b) − f(a)) / (b − a)]·(x − a)，验证 F(a) = F(b) 后落罗尔定理。',
    tags: ['高数', '中值定理', '证明'],
    images: [],
    template_id: 'tpl_demo_basic',
  },
  {
    id: 'chat-batch-demo-5',
    front: '应用拉格朗日中值定理前，需要逐项核对哪些条件？',
    back: '核对 f 在闭区间 [a, b] 上连续，并在开区间 (a, b) 内可导。\n满足这两个条件后，可找到 ξ ∈ (a, b)，使 f′(ξ) 等于端点连线的斜率。',
    tags: ['高数', '中值定理'],
    images: [],
    template_id: 'tpl_demo_basic',
  },
];

const ANKI_REPLY: DemoBlocks = [
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    delay: 200,
    content: `先从三张照片中提取题目与解题步骤，再对照教材、错题笔记，分别整理极限展开、积分换元和辅助函数构造。

每张问答卡围绕一个知识点提问，背面保留推导要点，标签标明对应章节，方便后续整理。`,
  },
  {
    type: 'rag',
    status: 'success',
    dwellMs: 1000,
    toolOutput: {
      query: '等价无穷小 换元积分 中值定理 错题',
      totalResults: 3,
      durationMs: 862,
      sources: [
        {
          title: '高等数学（第七版）上册.pdf',
          url: '/教材/高等数学（第七版）上册.pdf',
          snippet:
            '……等价无穷小替换仅适用于乘除因子；对相减的项直接替换会破坏阶的一致性，典型反例即 sin x − x ~ −x³/6……',
          score: 0.91,
          metadata: { pageIndex: 58, resourceId: 'tb_demo_calculus', resourceType: 'textbook' },
        },
        {
          title: '高数错题本（8 月）.md',
          url: '/笔记/高数错题本（8 月）.md',
          snippet:
            '……积分换元需要同步写出变量、上下限与微分的变化；∫₀^π sin²x dx 也可用降幂公式求得 π/2……',
          score: 0.86,
          metadata: { resourceId: 'note_demo_errorbook', resourceType: 'note' },
        },
        {
          title: '中值定理证明套路.md',
          url: '/笔记/中值定理证明套路.md',
          snippet:
            '……结论形如 f′(ξ) = k 时，构造 F(x) = f(x) − k(x−a)，验证端点等值后落罗尔定理……',
          score: 0.82,
          metadata: { resourceId: 'note_demo_mvt', resourceType: 'note' },
        },
      ],
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 250,
    content: `三道题分别对应**极限的展开阶数、积分换元的完整步骤、中值定理的辅助函数**。我对照了教材与错题笔记，将这三个主题拆成五张问答卡。

### 从解题步骤找到复习重点

- **极限**：展开 sin x 到三阶，保留相减后的首个非零项，再除以 x³ 得到 −1/6。[知识库-1]
- **定积分**：令 u = cos x，同时写出上下限和 du；也可以用 sin²x = (1 − cos 2x)/2 求得 π/2。[知识库-2]
- **中值定理**：先把目标整理为 F′(ξ) = 0，再构造 F(x) = f(x) − k(x − a)，核对端点值与可导条件。[知识库-3]

接下来逐张生成卡片。你可以先看正面尝试回忆，再翻面核对推导。`,
  },
  {
    type: 'anki_cards',
    status: 'success',
    delay: 400,
    // 真实后端是逐张流式出卡：每个 chunk 是一张某卡的 JSON 数组
    chunks: ANKI_CARDS.map((card) => JSON.stringify([card])),
    dwellMs: 420,
    // start payload 带生成选项：anki_cards 处理器据此初始化块数据
    // （牌组选择器初始值来自 options.deck_name）
    payload: {
      templateId: 'tpl_demo_basic',
      options: { deck_name: '高等数学 · 错题本' },
    },
    toolOutput: {
      cards: ANKI_CARDS,
      documentId: 'doc_demo_anki_gaoshu',
      syncStatus: 'pending',
      finalStatus: 'completed',
      deliveryStatus: 'ready',
      ankiConnect: { available: false, checkedAt: new Date().toISOString() },
      progress: { stage: 'completed', cardsGenerated: 5, completedRatio: 1 },
      options: { deck_name: '高等数学 · 错题本' },
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `五张卡片已准备好，牌组名称预填为 **「高等数学 · 错题本」**。

点击卡片可以翻面预览，也可以进入编辑调整题目与答案。检查内容后，点击「加入卡片库」完成收录。桌面版中的复习安排会依据卡片状态与实际作答记录生成。`,
  },
];

// ============================================================================
// 剧本 ②：PDF 章节精读（PDF 页码引用 + 内嵌思维导图 + 挖空卡）
// ============================================================================

const MLSYS_CARDS: AnkiCard[] = [
  {
    id: 'chat-batch-demo-6',
    front: '',
    back: '',
    text: '采用参数服务器架构时，各 worker 的梯度由 {{c1::参数服务器（Parameter Server）}} 聚合；采用集合通信时，可通过 {{c2::AllReduce}} 完成梯度归约。',
    tags: ['机器学习系统', '数据并行'],
    images: [],
    template_id: 'tpl_demo_cloze',
  },
  {
    id: 'chat-batch-demo-7',
    front: '',
    back: '',
    text: '同步 SGD 中所有 worker 必须等待最慢者，这一现象称为 {{c1::straggler 效应}}，它使加速比随 worker 数增加而偏离线性。',
    tags: ['机器学习系统', '数据并行'],
    images: [],
    template_id: 'tpl_demo_cloze',
  },
  {
    id: 'chat-batch-demo-8',
    front: '',
    back: '',
    text: '数据并行的通信优化包括 {{c1::梯度压缩}} 与 {{c2::计算通信重叠}}；分析效果时需要同时观察吞吐量和收敛情况。',
    tags: ['机器学习系统', '并行策略'],
    images: [],
    template_id: 'tpl_demo_cloze',
  },
];

const PDF_REPLY: DemoBlocks = [
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    delay: 200,
    content: `先定位教材中的数据并行、同步等待和通信优化段落，为每条结论保留页码。随后整理概念之间的关系，生成章节导图和挖空卡片，最后准备几道自测题，帮助读者检查理解。`,
  },
  {
    type: 'rag',
    status: 'success',
    dwellMs: 1100,
    toolOutput: {
      query: '数据并行 参数服务器 同步 SGD 第 3 章',
      totalResults: 3,
      durationMs: 1043,
      sources: [
        {
          title: '机器学习系统.pdf · 第 3 章',
          url: '/上传/机器学习系统（第 3 章）·数据并行训练.pdf',
          snippet:
            '……数据并行将 mini-batch 切分到 K 个 worker，各自在完整模型副本上计算梯度，由参数服务器（Parameter Server）聚合后再广播更新值……',
          score: 0.93,
          metadata: { pageIndex: 45, resourceId: 'file_demo_mlsys', resourceType: 'file' },
        },
        {
          title: '机器学习系统.pdf · 第 3 章',
          url: '/上传/机器学习系统（第 3 章）·数据并行训练.pdf',
          snippet:
            '……同步随机梯度下降要求所有 worker 等待最慢的一步，straggler 效应使加速比随 worker 数增加而显著偏离线性……',
          score: 0.9,
          metadata: { pageIndex: 47, resourceId: 'file_demo_mlsys', resourceType: 'file' },
        },
        {
          title: '机器学习系统.pdf · 第 3 章',
          url: '/上传/机器学习系统（第 3 章）·数据并行训练.pdf',
          snippet:
            '……在通信受限场景下，梯度压缩（量化 / 稀疏化）与流水线并行是降低同步开销的两条主要路径……',
          score: 0.84,
          metadata: { pageIndex: 52, resourceId: 'file_demo_mlsys', resourceType: 'file' },
        },
      ],
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 250,
    content: `这一章可以沿着三个问题来读：**训练数据怎样分配、梯度怎样汇合、同步时间怎样影响训练效率**。

### 沿着页码理解章节

**数据与模型副本**：mini-batch 分配给多个 worker，各自在模型副本上计算梯度。教材用参数服务器说明梯度聚合与参数更新的过程。[PDF@file_demo_mlsys:45]

**同步等待**：同步 SGD 需要各 worker 完成当前步骤，计算较慢的节点会拉长等待时间。分析加速效果时，应同时观察计算时间与通信时间。[PDF@file_demo_mlsys:47]

**通信优化**：教材介绍了梯度压缩等思路。阅读时可以结合通信量、吞吐量与收敛情况，理解每种方法的适用条件。[PDF@file_demo_mlsys:52]

下面的导图把基本范式、同步开销与优化方向连接起来。你可以缩放画布、拖动查看各个分支。

[思维导图:mm_demo_mlsys_ch3:第 3 章 · 数据并行训练]

再用三张挖空卡回忆关键概念。`,
  },
  {
    type: 'anki_cards',
    status: 'success',
    delay: 400,
    chunks: MLSYS_CARDS.map((card) => JSON.stringify([card])),
    dwellMs: 420,
    payload: {
      templateId: 'tpl_demo_cloze',
      options: { deck_name: '机器学习系统 · 第 3 章' },
    },
    toolOutput: {
      cards: MLSYS_CARDS,
      documentId: 'doc_demo_anki_mlsys',
      syncStatus: 'pending',
      finalStatus: 'completed',
      deliveryStatus: 'ready',
      ankiConnect: { available: false, checkedAt: new Date().toISOString() },
      progress: { stage: 'completed', cardsGenerated: 3, completedRatio: 1 },
      options: { deck_name: '机器学习系统 · 第 3 章' },
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `三张挖空卡已生成，牌组名称预填为 **「机器学习系统 · 第 3 章」**。翻面检查内容后，可以通过「加入卡片库」收录。

### 读完后，用三个问题检查理解

1. 采用参数服务器时，worker 的梯度经过哪些步骤参与参数更新？
2. 一个 worker 明显较慢时，同步 SGD 的每轮训练时间会怎样变化？
3. 梯度压缩减少了传输量，评估训练效果时还需要记录哪些指标？

**参考思路**：第一题沿着计算、聚合、更新、分发描述数据流；第二题结合最慢节点与同步等待解释；第三题同时观察通信耗时、吞吐量与收敛情况。你可以回到第 45、47、52 页核对自己的回答。`,
  },
];

// ============================================================================
// 剧本 ③：间隔重复研究综述（记忆 + 网络检索 + 学术搜索 + 待办面板）
// ============================================================================

const RESEARCH_COMPARISON: GenerativeUIIntent = {
  version: '1.1',
  layout: { mode: 'stack' },
  meta: { title: '间隔重复 · 研究路径对照', description: '从记忆建模到复习安排，整理继续阅读的线索' },
  blocks: [{
    type: 'table',
    props: {
      title: '带着问题读文献',
      columns: [
        { key: 'source', label: '阅读材料' },
        { key: 'question', label: '关注的问题' },
        { key: 'use', label: '阅读后可以整理什么' },
      ],
      rows: [
        { source: 'HLR · ACL 2016', question: '怎样用练习记录预测回忆概率？', use: '输入特征、半衰期与预测目标' },
        { source: 'Spaced Repetition Optimization · PNAS 2019', question: '怎样把复习时间安排写成优化问题？', use: '建模假设、目标函数与求解思路' },
        { source: 'FSRS 开源项目', question: '记忆模型怎样用于实际调度？', use: '状态更新、参数训练与复习间隔' },
      ],
      caption: '结合下方原始来源，逐项核对研究假设与适用条件。',
    },
  }, {
    type: 'markdown',
    props: { body: '[HLR 论文](https://aclanthology.org/P16-1174/) · [PNAS 论文](https://www.pnas.org/doi/10.1073/pnas.1815156116) · [FSRS 项目](https://github.com/open-spaced-repetition/fsrs4anki)' },
  }, {
    type: 'action-bar',
    props: { actions: [{ id: 'export-intent', label: '复制为 Markdown', riskLevel: 'low' }] },
  }],
};

const RESEARCH_REPLY: DemoBlocks = [
  {
    type: 'thinking', status: 'success', streaming: true,
    content: '先结合学习档案确认每天可用的复习时间，再分别查阅开源项目和学术文献。整理时区分模型的预测目标、调度方法与阅读者自己的练习安排，为每条研究线索保留来源。',
  },
  {
    type: 'memory', status: 'success', dwellMs: 500,
    toolOutput: { sources: [
      { title: '学习档案', snippet: '每天计划安排 90 分钟复习。', metadata: { note_id: 'note_demo_profile' } },
      { title: '复习偏好', snippet: '喜欢先合上材料写出答案，再核对原文和推导过程。', metadata: { note_id: 'note_demo_preference' } },
    ] },
  },
  {
    type: 'web_search', status: 'success', dwellMs: 850,
    toolName: 'web_search',
    toolInput: { query: 'FSRS spaced repetition memory model documentation' },
    toolOutput: { sources: [
      { title: 'FSRS 开源项目', url: 'https://github.com/open-spaced-repetition/fsrs4anki', snippet: '记忆状态建模、参数优化与间隔重复调度的开源实现。' },
      { title: 'FSRS Rust 实现', url: 'https://github.com/open-spaced-repetition/fsrs-rs', snippet: '用于参数训练与复习调度的 Rust 实现。' },
    ] },
  },
  {
    type: 'academic_search', status: 'success', dwellMs: 950,
    toolName: 'scholar_search',
    toolInput: { query: 'spaced repetition memory model optimal scheduling', limit: 2 },
    toolOutput: { sources: [
      { title: 'A Trainable Spaced Repetition Model for Language Learning · ACL 2016', url: 'https://aclanthology.org/P16-1174/', snippet: 'Settles 与 Meeder 使用半衰期回归建模语言学习中的回忆概率。', metadata: { source_type: 'academic' } },
      { title: 'Enhancing Human Learning via Spaced Repetition Optimization · PNAS 2019', url: 'https://www.pnas.org/doi/10.1073/pnas.1815156116', snippet: 'Tabibian 等人将复习安排形式化为随机最优控制问题。', metadata: { source_type: 'academic' } },
    ] },
  },
  {
    type: 'content', status: 'success', streaming: true,
    content: `## 间隔重复：从记忆预测到复习安排

可以沿着**记忆模型、调度目标、日常应用**三条线理解这个领域。

**记忆模型**关注练习记录怎样帮助估计回忆概率。HLR 论文以语言学习为背景，把学习行为特征与记忆半衰期联系起来。[搜索-3]

**调度方法**关注复习时间如何安排。PNAS 2019 的研究把这一问题写成随机最优控制模型，适合进一步阅读它的建模假设与优化目标。[搜索-4]

**开源实现**帮助我们理解模型如何进入实际复习流程。FSRS 项目及其 Rust 实现提供了记忆状态更新、参数训练和调度相关代码，可以结合项目文档继续查阅。[搜索-1] [搜索-2]

### 怎样接到自己的学习中

学习档案里记录了每天九十分钟的复习安排 [记忆-1]，以及先默写、再核对的偏好 [记忆-2]。可以先按这套方式复习一组卡片，记录用时和回忆情况，再结合实际记录调整新卡数量。

下面整理成一份研究路径对照表，方便打开原始材料，逐项补充自己的阅读笔记。`,
  },
  {
    type: 'generative_ui', status: 'success', streaming: true,
    toolName: 'builtin-render_generative_ui',
    toolInput: { intent: RESEARCH_COMPARISON },
    content: JSON.stringify(RESEARCH_COMPARISON),
    toolOutput: { intent: RESEARCH_COMPARISON, isStreaming: false },
  },
  {
    type: 'tool_call', status: 'success', toolName: 'todo_init', dwellMs: 600,
    toolInput: { title: '间隔重复 · 阅读与实践', steps: ['阅读 HLR 的特征与预测目标', '整理 PNAS 论文的建模假设', '对照 FSRS 文档复习一组卡片'] },
    toolOutput: {
      success: true, todoListId: 'todo_demo_srs', title: '间隔重复 · 阅读与实践',
      progress: '0/3 completed', completedCount: 0, totalCount: 3, isAllDone: false,
      continue_execution: false, currentRunning: null,
      steps: [
        { id: 'todo_demo_1', description: '阅读 HLR 的特征与预测目标', status: 'pending', createdAt: 1788739200000 },
        { id: 'todo_demo_2', description: '整理 PNAS 论文的建模假设', status: 'pending', createdAt: 1788739200000 },
        { id: 'todo_demo_3', description: '对照 FSRS 文档复习一组卡片', status: 'pending', createdAt: 1788739200000 },
      ],
      message: '阅读清单已整理，可按自己的时间逐项开展。',
    },
  },
  {
    type: 'content', status: 'success', streaming: true,
    content: '研究路径对照表已经留在会话底部的「产物」中，原始文献链接随表附上。阅读清单按三个主题排列，方便你从感兴趣的部分开始，逐步补充自己的理解。',
  },
];

// ============================================================================
// 会话④：周度学习看板（材料记录 → 结构化产物 → 后续复习安排）
// ============================================================================

const DEMO_WEEKLY_REPORT_INTENT: GenerativeUIIntent = {
  version: '1.1',
  layout: { mode: 'grid', columns: 2 },
  meta: { title: '本周学习看板', description: '依据本次提供的材料记录整理' },
  blocks: [
    { type: 'stat-card', props: { title: '高数错题卡', value: ANKI_CARDS.length, subtitle: '三道错题，拆成五个回忆要点' } },
    { type: 'stat-card', props: { title: '章节挖空卡', value: MLSYS_CARDS.length, subtitle: '数据并行训练的关键概念' } },
    {
      type: 'table', span: 2,
      props: {
        title: '本周材料与复习重点',
        columns: [{ key: 'material', label: '材料' }, { key: 'focus', label: '复习重点' }, { key: 'output', label: '准备的内容' }],
        rows: [
          { material: '三道高数错题', focus: '展开阶数、积分换元、辅助函数', output: '五张问答卡' },
          { material: '数据并行训练章节', focus: '梯度聚合、同步等待、通信优化', output: '导图、三张挖空卡与自测题' },
        ],
        caption: '卡片数量来自本次材料记录；练习表现由实际作答逐步积累。',
      },
    },
    {
      type: 'steps', span: 2,
      props: {
        title: '下一轮学习安排',
        steps: [
          { label: '先回忆，再翻面核对', description: '从五张高数卡开始，写出关键步骤，对照背面的推导。', status: 'pending' },
          { label: '沿着导图复述章节', description: '解释数据分配、梯度聚合与同步等待的关系，再回到原文核对。', status: 'pending' },
          { label: '完成章节自测并记录问题', description: '保留需要继续查阅的页码，把新的问题带进下一次阅读。', status: 'pending' },
        ],
      },
    },
  ],
};

const WEEKLY_REPORT_REPLY: DemoBlocks = [
  {
    type: 'thinking', status: 'success', streaming: true,
    content: '根据这次提供的周度材料记录，分别整理高数与机器学习系统两组内容。卡片数量按记录汇总，复习步骤围绕主动回忆、原文核对与自测展开。',
  },
  {
    type: 'generative_ui', status: 'success', streaming: true, delay: 200,
    toolName: 'builtin-render_generative_ui',
    toolInput: { intent: DEMO_WEEKLY_REPORT_INTENT },
    content: JSON.stringify(DEMO_WEEKLY_REPORT_INTENT),
    toolOutput: { intent: DEMO_WEEKLY_REPORT_INTENT, isStreaming: false },
  },
  {
    type: 'content', status: 'success', streaming: true, delay: 300,
    content: '学习看板已整理好。展开会话底部的 **「产物」**，点击「本周学习看板」，即可查看两组卡片、材料清单与复习安排。切换到其他会话后，再回来可以继续查看这份记录。',
  },
];

// ============================================================================
// 导出
// ============================================================================

export const DEMO_QBANK_ID = 'exam_demo_parallel';
export const DEMO_QUESTIONS: GeneratedQuestionDraft[] = [
  {
    question_type: 'single_choice', difficulty: 'easy', tags: ['数据并行', '模型副本'],
    content: '采用数据并行训练时，各 worker 通常分别持有什么？',
    options: [{ key: 'A', content: '完整模型副本与一部分 mini-batch 数据' }, { key: 'B', content: '模型的一层与全部训练数据' }, { key: 'C', content: '梯度汇总结果与全部模型层的唯一副本' }],
    answer: 'A', explanation: '数据并行按数据切分工作，各 worker 在完整模型副本上计算自己分到的数据。',
  },
  {
    question_type: 'single_choice', difficulty: 'medium', tags: ['同步 SGD', '通信优化'],
    content: '评估梯度压缩方案时，哪组指标能更完整地反映训练效果？',
    options: [{ key: 'A', content: '通信耗时、训练吞吐量与收敛情况' }, { key: 'B', content: '压缩后的字节数' }, { key: 'C', content: 'worker 数量' }],
    answer: 'A', explanation: '压缩改变传输量与梯度表示，评估时需要把通信代价、计算效率和模型收敛放在一起。',
  },
];

const QBANK_REPLY: DemoBlocks = [
  { type: 'thinking', status: 'success', streaming: true, content: '根据给定材料提取数据切分、模型副本和梯度压缩三个知识点，在已有题目集中准备两道选择题草稿，供学习者逐题检查后收录。' },
  {
    type: 'tool_call', status: 'success', toolName: 'builtin-qbank_generate_questions', dwellMs: 1000,
    toolInput: { exam_id: DEMO_QBANK_ID, max_questions: 2, specs: [{ question_type: 'single_choice', count: 2 }], knowledge_points: ['数据并行', '梯度压缩'], topic_hint: '各 worker 持有完整模型副本，处理部分 mini-batch。评估梯度压缩时同时观察通信、吞吐量与收敛。', language: 'zh-CN' },
    toolOutput: { action: 'generate_questions', examId: DEMO_QBANK_ID, drafts: DEMO_QUESTIONS, rejectedCount: 0, rejectionReasons: [], skippedReferences: [], usedReferenceCount: 0 },
  },
  { type: 'content', status: 'success', streaming: true, content: `两道选择题草稿已经列出，每道题带有选项、参考答案和知识点标签。勾选希望保留的题目，再点击「加入所选」。\n\n收录完成后，打开[题目集:${DEMO_QBANK_ID}:数据并行训练]，在右侧选择「开始做题」，提交自己的答案并结合解析回顾知识点。题目集会保留本次作答的结果，方便继续练习。` },
];

export const DEMO_TRANSLATION_SOURCE = 'In synchronous data-parallel training, each worker holds a complete replica of the model and processes a subset of the mini-batch. Gradients are aggregated before the next update. Gradient compression reduces communication volume; its impact should be evaluated together with training throughput and convergence.';
const TRANSLATION_INTENT: GenerativeUIIntent = {
  version: '1.1', layout: { mode: 'stack' }, meta: { title: '数据并行训练 · 双语阅读笔记' },
  blocks: [
    { type: 'table', props: { title: '逐句对照阅读', columns: [{ key: 'en', label: '英文原文' }, { key: 'zh', label: '中文译文' }], rows: [
      { en: 'In synchronous data-parallel training, each worker holds a complete replica of the model and processes a subset of the mini-batch.', zh: '在同步数据并行训练中，每个工作节点持有完整的模型副本，并处理小批量数据中的一个子集。' },
      { en: 'Gradients are aggregated before the next update.', zh: '梯度在下一次更新前完成聚合。' },
      { en: 'Gradient compression reduces communication volume; its impact should be evaluated together with training throughput and convergence.', zh: '梯度压缩减少通信量；评估其影响时，应同时考察训练吞吐量与收敛情况。' },
    ] } },
    { type: 'table', props: { title: '本段术语', columns: [{ key: 'en', label: '术语' }, { key: 'zh', label: '译法与含义' }], rows: [
      { en: 'worker', zh: '工作节点：执行当前数据子集的计算' }, { en: 'model replica', zh: '模型副本：一个完整模型的实例' }, { en: 'convergence', zh: '收敛：训练过程中优化目标的变化情况' },
    ] } },
    { type: 'action-bar', props: { actions: [{ id: 'export-intent', label: '复制双语阅读笔记', riskLevel: 'low' }] } },
  ],
};
const TRANSLATION_REPLY: DemoBlocks = [
  { type: 'content', status: 'success', streaming: true, content: '这段材料介绍同步数据并行的计算分工与梯度聚合。我将 worker 统一译为「工作节点」，model replica 译为「模型副本」，逐句整理译文，并补充术语说明。' },
  { type: 'generative_ui', status: 'success', streaming: true, toolName: 'builtin-render_generative_ui', content: JSON.stringify(TRANSLATION_INTENT), toolInput: { intent: TRANSLATION_INTENT }, toolOutput: { intent: TRANSLATION_INTENT, isStreaming: false } },
  { type: 'content', status: 'success', streaming: true, content: '双语阅读笔记已放在会话底部的「产物」中。展开后可以逐句对照，也可以点击「复制为 Markdown」，粘贴到自己的笔记中继续整理。' },
];

const textReply = (content: string): DemoBlocks => [{ type: 'content', status: 'success', streaming: true, content }];

export const DEMO_SESSIONS: DemoSessionFixture[] = [
  makeFixture({
    id: 'demo-anki-cards',
    title: '高数错题 → Anki 卡片',
    description: '知识库检索 + 引用溯源，三道错题实时生成 5 张可交互卡片',
    minutesAgo: 3,
    autoPrompt: '这三道高数错题我拍了照片传上来了，帮我整理成 Anki 卡片，重点突出每道题的易错点',
    attachmentRefs: DEMO_IMAGE_ASSETS.map((img) => ({
      resourceId: img.resourceId,
      hash: `hash_${img.sourceId}`,
      typeId: 'image',
      displayName: img.name,
    })),
    reply: ANKI_REPLY,
    continuations: [{ id: 'integral', label: '继续推导积分换元', prompt: '请把第二道题的换元过程展开，说明上下限和微分怎样一起变化。', reply: textReply('令 u = cos x，则 du = −sin x dx。在 x ∈ [0, π] 上，sin x = √(1 − u²)。\n\n因此 sin²x dx = −√(1 − u²) du，上下限由 x = 0、π 变为 u = 1、−1。调整积分方向后，得到 ∫₋₁¹ √(1 − u²) du。它表示单位圆的上半圆面积，结果为 π/2。\n\n也可以用 sin²x = (1 − cos 2x)/2 交叉核对。') }],
  }),
  makeFixture({
    id: 'demo-pdf-deepread',
    title: '《机器学习系统》第 3 章精读',
    description: 'PDF 页码引用 + 内嵌思维导图 + 挖空卡片',
    minutesAgo: 18,
    autoPrompt: '请精读上传的《机器学习系统》第 3 章，标出原文页码，整理章节导图和挖空卡，再准备三道带参考思路的自测题',
    attachmentRefs: [
      {
        resourceId: DEMO_PDF_RESOURCE_ID,
        hash: `hash_${DEMO_PDF_SOURCE_ID}`,
        typeId: 'file',
        displayName: DEMO_PDF_NAME,
      },
    ],
    reply: PDF_REPLY,
    continuations: [{ id: 'compare', label: '比较两种梯度聚合方式', prompt: '请进一步比较参数服务器和 AllReduce，说明它们怎样汇合梯度。', reply: textReply('**参数服务器**：worker 将梯度发送给参数服务器，由服务器完成聚合与参数更新，再向 worker 分发更新后的参数。\n\n**AllReduce**：参与节点通过集合通信共同完成梯度归约，各节点获得相同的聚合结果，再更新各自的模型副本。\n\n两种方式都服务于数据并行训练。选择时可以结合网络拓扑、节点规模、参数分片方式与故障处理需求，比较通信负载和运行效率。教材第 45 页使用参数服务器解释基本流程。') }],
  }),
  makeFixture({
    id: 'demo-spaced-repetition',
    title: '间隔重复研究综述',
    description: '用户记忆 + 网络检索 + 学术搜索，综述落成待办清单',
    minutesAgo: 47,
    autoPrompt: '我每天有九十分钟复习，请结合学习偏好，查阅间隔重复的研究与开源实现，整理来源对照表和阅读清单',
    reply: RESEARCH_REPLY,
    continuations: [{ id: 'reading', label: '展开论文阅读顺序', prompt: '请把这份综述展开成一个具体的论文阅读顺序，说明每篇要记录什么。', reply: textReply('先阅读 [HLR 论文](https://aclanthology.org/P16-1174/)，记录模型输入、半衰期的含义与预测目标。\n\n接着阅读 [PNAS 2019](https://www.pnas.org/doi/10.1073/pnas.1815156116)，整理复习安排的建模假设、优化目标与实验设置。\n\n最后对照 [FSRS 项目文档](https://github.com/open-spaced-repetition/fsrs4anki)，查看记忆状态怎样更新、复习间隔怎样计算。每篇都保留原始链接，并用一段自己的话概括它解决的问题。') }],
  }),
  makeFixture({
    id: 'demo-weekly-report',
    title: '周度学习看板',
    description: '材料清单、卡片概览与复习安排，收进会话底部的学习看板',
    minutesAgo: 1,
    autoPrompt: '本周整理了三道高数错题、五张问答卡，也读了数据并行训练章节，准备了导图、三张挖空卡和自测题。请据此生成学习看板，列出材料与下一轮复习安排',
    reply: WEEKLY_REPORT_REPLY,
    continuations: [{ id: 'plan', label: '细化下一次复习安排', prompt: '请根据这份材料清单，把下一次复习安排成三个具体步骤。', reply: textReply('**先做高数主动回忆。** 看卡片正面写出关键步骤，再翻面核对展开阶数、变量替换和辅助函数。\n\n**再复述章节导图。** 沿着数据分配、梯度聚合、同步等待三个分支讲清训练流程，并记录需要回看的页码。\n\n**最后完成章节自测。** 独立回答三个问题，再对照参考思路，把新增疑问带到下一轮阅读。') }],
  }),
  makeFixture({ id: 'demo-qbank', title: '数据并行训练 · 知识点出题', minutesAgo: 5,
    autoPrompt: '请在「数据并行训练」题目集中准备两道单选题。材料：每个 worker 持有完整模型副本并处理部分 mini-batch；梯度压缩应同时评估通信、吞吐量与收敛。请生成带答案解析的草稿，供我勾选收录。', reply: QBANK_REPLY,
    continuations: [{ id: 'saved', label: '查看已收录题目与解析', prompt: '请列出我刚才收录的题目，并展示对应解析。', reply: [] }],
  }),
  makeFixture({ id: 'demo-bilingual', title: '数据并行训练 · 双语阅读', minutesAgo: 6,
    autoPrompt: `请把下面这段技术材料逐句译成中文，worker 统一译为工作节点，model replica 译为模型副本。生成可复制的双语对照表，并解释关键术语。\n\n${DEMO_TRANSLATION_SOURCE}`, reply: TRANSLATION_REPLY,
    continuations: [{ id: 'terms', label: '继续理解吞吐量与收敛', prompt: '请结合这段材料解释 throughput 和 convergence 的区别。', reply: textReply('**Throughput（吞吐量）**描述单位时间内处理的数据量，例如每秒处理多少训练样本。\n\n**Convergence（收敛）**描述优化过程是否逐渐达到目标，通常结合损失曲线、验证指标和所需训练步数观察。\n\n梯度压缩可能缩短通信时间。评估时应把每步用时与达到目标指标所需的步数一起记录，才能理解一次训练的整体成本。') }],
  }),
];

/** 演示用模型列表（get_model_profiles） */
export const DEMO_MODEL_PROFILES = [
  { id: 'demo-deepseek-v4', label: 'DeepSeek V4', model: 'deepseek-v4' },
  { id: 'demo-kimi-k3', label: 'Kimi K3', model: 'kimi-k3' },
];
