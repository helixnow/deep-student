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
}): DemoSessionFixture {
  const updatedAt = new Date(Date.now() - opts.minutesAgo * 60_000);
  const createdAt = new Date(updatedAt.getTime() - 10 * 60_000);
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
    // 静态历史为空：第一问第一答由自动播放实时走完，观感从头开始
    messages: [],
    blocks: [],
    followUp: opts.reply,
    autoPrompt: opts.autoPrompt,
    attachmentRefs: opts.attachmentRefs,
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
      mmNode('n1-2', '参数服务器聚合梯度'),
      mmNode('n1-3', '更新值广播回各 worker'),
    ]),
    mmNode('n2', '同步的代价', [
      mmNode('n2-1', 'straggler 效应'),
      mmNode('n2-2', '加速比偏离线性'),
    ]),
    mmNode('n3', '破局方向', [
      mmNode('n3-1', '梯度压缩（量化 / 稀疏化）'),
      mmNode('n3-2', '流水线并行'),
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
    content: `这是 **Deep Student 演示环境** 的模拟回复。

当前页面运行的是与桌面版完全一致的前端界面与事件链路，但数据来自内置剧本，不会连接真实模型。

下载桌面客户端，即可用你的学习内容（教材、题库、笔记）与 AI 深度对话。`,
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
    front: '求 lim(x→0) (sin x − x) / x³ 时，直接把 sin x 换成 x 为什么错？',
    back: '等价无穷小替换只能用于乘除因子，不能用于相减的项。\n正确做法：泰勒展开 sin x = x − x³/6 + o(x³)，得极限 −1/6。',
    tags: ['高数', '极限', '等价无穷小'],
    images: [],
    template_id: 'tpl_demo_basic',
  },
  {
    id: 'chat-batch-demo-2',
    front: '∫₀^π sin²x dx 用换元 u = cos x 时最容易漏掉什么？',
    back: '换元必须同时换上下限：x = 0 → u = 1，x = π → u = −1；漏换会得到错误符号。',
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
    front: '拉格朗日中值定理的两个前提条件是什么？缺一会怎样？',
    back: '闭区间 [a, b] 上连续 + 开区间 (a, b) 内可导。缺连续性结论不成立，如 f(x) = 1/x 在 [−1, 1] 上。',
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
    content: `用户拍了三道高数错题照片。先识别照片里的题目，再去他的知识库看看错题本和教材里有没有相关记录，然后定制制卡策略。

三道题的核心错因：
1. 极限计算：等价无穷小误用于相减项
2. 定积分换元：换元后忘记换上下限
3. 中值定理证明：辅助函数构造方向错误

制卡策略：
- 每张卡只考一个易错点，正反面分离「错因识别」和「正确做法」
- 用问答卡而非挖空卡——这里练的是主动回忆
- 打上章节标签，FSRS 按知识点调度`,
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
            '……∫₀^π sin²x dx 换元 u = cos x 时又忘了换限，结果算出 0——这个月第二次犯，必须单独成卡……',
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
    content: `三张错题照片都识别出来了。检索到你的教材和错题笔记——错题 2 的「换元不换限」在你的错题本里**这个月已经出现过一次** [知识库-2]，这类错误必须单独成卡。

## 错因定位

**第 1 题**：把 $\\sin x$ 直接换成 $x$，是**等价无穷小的误用**——替换只对乘除因子成立，相减的项必须保留到足够阶 [知识库-1]。正确路径是泰勒展开：

$$\\sin x = x - \\frac{x^3}{6} + o(x^3) \\;\\Rightarrow\\; \\lim_{x \\to 0} \\frac{\\sin x - x}{x^3} = -\\frac{1}{6}$$

**第 2 题**：$u = \\cos x$ 换元本身可行，但**上下限没跟着换**：$x=0 \\to u=1$，$x=\\pi \\to u=-1$，漏换直接丢符号。这题其实还有更快的路子（区间再现，见卡片 3）。

**第 3 题**：辅助函数的构造方向反了。固定套路是**先把结论改写成 $F'(\\xi) = 0$** 再倒推 $F$ [知识库-3]。

已按「一张卡只考一个易错点」生成 **5 张卡片**（第 2 题拆出了两个独立坑点），正在逐张写入 ↓`,
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
      ankiConnect: { available: true, checkedAt: new Date().toISOString() },
      progress: { stage: 'completed', cardsGenerated: 5, completedRatio: 1 },
      options: { deck_name: '高等数学 · 错题本' },
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `已生成完毕，写入牌组 **「高等数学 · 错题本」**，FSRS 调度已开启：

- 5 张都是新卡，**今晚**安排首次学习
- 错题 2 拆出的两张卡标了「换元法」标签，明早复习队列会优先出现
- 上面那叠卡片可以直接**点击翻面预览**、**进入编辑改字**，然后「加入卡片库」或「同步到 Anki」

要不要我把「区间再现」再展开讲两种常见变形？`,
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
    text: '数据并行中，各 worker 的梯度由 {{c1::参数服务器（Parameter Server）}} 聚合后再广播回所有 worker。',
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
    text: '通信受限场景下，可用 {{c1::梯度压缩（量化 / 稀疏化）}} 或改用 {{c2::流水线并行}} 来降低同步开销。',
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
    content: `用户上传了《机器学习系统》PDF，问第 3 章「数据并行」。

先去知识库定位这一章的正文片段。注意两点：
1. 引用要标到具体页码，方便他回去翻书
2. 他要的是"知识框架"——除了文字梳理，直接给他一张可交互导图 + 一叠挖空卡更合适`,
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
    content: `第 3 章读完了。这一章的主线其实只有一句话：**计算可以无限切分，通信才是瓶颈**。

## 知识框架

**① 基本范式**：mini-batch 切到 $K$ 个 worker，各自在完整模型副本上算梯度，参数服务器聚合后再广播 [PDF@file_demo_mlsys:45]

**② 同步的代价**：同步 SGD 里所有人要等最慢的那个 worker（straggler 效应），worker 越多加速比越偏离线性 [PDF@file_demo_mlsys:47]

**③ 破局方向**：通信受限时做梯度压缩（量化 / 稀疏化），或者干脆换流水线并行的切分方式 [PDF@file_demo_mlsys:52]

整章的概念依赖我整理成了导图，可以直接缩放、拖动着看 ↓

[思维导图:mm_demo_mlsys_ch3:第 3 章 · 数据并行训练]

卡片也出好了——这章是概念密集型，用了**填空模板**直接挖空核心名词 ↓`,
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
      ankiConnect: { available: true, checkedAt: new Date().toISOString() },
      progress: { stage: 'completed', cardsGenerated: 3, completedRatio: 1 },
      options: { deck_name: '机器学习系统 · 第 3 章' },
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `3 张挖空卡已入牌组 **「机器学习系统 · 第 3 章」**。

建议的节奏：今晚先对着导图回忆一遍主线（卡壳的地方就是没读懂的地方），明早 FSRS 会把这 3 张卡排进队列。

需要的话，我可以把第 4 章「模型并行」也梳理出来，和这一章做一张对比表。`,
  },
];

// ============================================================================
// 剧本 ③：间隔重复研究综述（记忆 + 网络检索 + 学术搜索 + 待办面板）
// ============================================================================

const RESEARCH_REPLY: DemoBlocks = [
  {
    type: 'memory',
    status: 'success',
    dwellMs: 500,
    toolOutput: {
      query: '用户学习目标 复习偏好',
      totalResults: 2,
      durationMs: 318,
      sources: [
        {
          title: '学习档案',
          snippet: '用户正在备考研究生（12 月底考试），每天可用于复习的时间约 90 分钟。',
          score: 0.95,
          metadata: { note_id: 'note_demo_profile' },
        },
        {
          title: '复习偏好 · 2026-08-14',
          snippet: '用户反馈：看着卡片认答案总觉得会了，合上书写不出来——更适合"生成式回忆"式的复习。',
          score: 0.88,
          metadata: { note_id: 'note_demo_preference' },
        },
      ],
    },
  },
  {
    type: 'web_search',
    status: 'success',
    dwellMs: 850,
    toolName: 'web_search',
    toolInput: { query: 'FSRS spaced repetition algorithm latest progress 2026' },
    toolOutput: {
      query: 'FSRS spaced repetition algorithm latest progress 2026',
      searchEngine: 'Google',
      totalResults: 3,
      durationMs: 1204,
      sources: [
        {
          title: 'open-spaced-repetition/fsrs4anki: 现代间隔重复调度器',
          url: 'https://github.com/open-spaced-repetition/fsrs4anki',
          snippet:
            'FSRS 是基于三组件记忆模型的现代间隔重复调度器，最新版本引入同卡组卡片间的个性化难度衰减建模……',
          score: 0.94,
        },
        {
          title: 'open-spaced-repetition/fsrs-rs: Rust 实现的 FSRS 调度核心',
          url: 'https://github.com/open-spaced-repetition/fsrs-rs',
          snippet:
            'Rust 重写的 FSRS 调度核心，万级卡组的调度计算可在毫秒级完成，被 Anki 25 系及多个第三方客户端内置……',
          score: 0.89,
        },
        {
          title: 'Spaced repetition - Wikipedia',
          url: 'https://en.wikipedia.org/wiki/Spaced_repetition',
          snippet:
            'Spaced repetition is an evidence-based learning technique… 间隔效应自 Ebbinghaus 遗忘曲线以来被反复验证……',
          score: 0.81,
        },
      ],
    },
  },
  {
    type: 'academic_search',
    status: 'success',
    dwellMs: 950,
    toolName: 'arxiv_search',
    toolInput: { query: 'spaced repetition scheduling optimization memory model', limit: 3 },
    toolOutput: {
      query: 'spaced repetition scheduling optimization memory model',
      source: 'openalex',
      total_results: 3,
      sources: [
        {
          title: 'Enhancing Human Learning via Spaced Repetition Optimization (PNAS, 2019)',
          url: 'https://www.pnas.org/doi/10.1073/pnas.1815156116',
          snippet:
            'Tabibian et al. 把复习调度形式化为随机最优控制问题，证明存在最优调度策略并给出高效求解框架。',
          score: 0.96,
          metadata: { source_type: 'academic' },
        },
        {
          title: 'A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition (KDD, 2022)',
          url: 'https://dl.acm.org/doi/10.1145/3534678.3539091',
          snippet:
            'Ye et al. 提出随机最短路径算法求解复习调度，即 FSRS 调度器的算法内核，在真实背诵数据上显著优于 SM-2。',
          score: 0.93,
          metadata: { source_type: 'academic' },
        },
        {
          title: 'A Trainable Spaced Repetition Model for Language Learning (ACL, 2016)',
          url: 'https://aclanthology.org/P16-1174/',
          snippet:
            'Settles & Meeder 提出半衰期回归（HLR），用特征化记忆模型预测回忆概率，是 Duolingo 复习系统的起点。',
          score: 0.87,
          metadata: { source_type: 'academic' },
        },
      ],
    },
  },
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    delay: 200,
    content: `三个来源齐了：
- 记忆：他在备考研究生，每天 90 分钟，偏好生成式回忆
- 网络：FSRS 最新迭代 + Rust 调度核心
- 学术：PNAS 2019（最优控制框架）→ KDD 2022（FSRS 内核）→ ACL 2016（HLR 起点）

组织方式：先讲算法进展，再串理论谱系，最后落到他的备考场景给可执行建议，并排成待办。`,
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 250,
    content: `## 间隔重复 · 值得关注的进展

**算法侧**：FSRS 调度器持续迭代，最新版本引入了**同卡组卡片间的个性化难度衰减建模**——同一门课里你总错的那类卡会被识别出来，新卡前几次复习的安排明显更稳 [搜索-1]。配套的 fsrs-rs 用 Rust 重写了调度核心，万级卡组也能毫秒级出排期 [搜索-2]。

**理论谱系**（学术搜索帮你把源头串起来了）：

1. **HLR 半衰期回归**（Settles & Meeder, ACL 2016）——第一个可训练的记忆模型，Duolingo 复习系统的起点
2. **随机最优控制框架**（Tabibian et al., PNAS 2019）——首次证明复习调度存在最优策略
3. **随机最短路径算法**（Ye et al., KDD 2022）——FSRS 的算法内核，真实数据上显著优于 SM-2

间隔效应本身是心理学最稳健的现象之一，自艾宾浩斯以来被反复验证 [搜索-3]。

## 落到你的备考上

记得你偏好**默写式回忆** [记忆-2]，结合上面的结论给两条可执行的：

1. **错题卡按「最小可回忆单元」拆细**——一张卡塞多个考点会干扰调度器的难度估计，这也是你错题本里「换元不换限」反复错的原因之一
2. 每天 90 分钟预算下 [记忆-1]，**70% 给到期复习、30% 开新卡**，避免新卡挤占到期的遗忘临界点

我把这周的处理动作排成了待办清单 ↓`,
  },
  {
    type: 'tool_call',
    status: 'success',
    delay: 350,
    dwellMs: 600,
    toolName: 'todo_init',
    toolInput: {
      title: '间隔重复复习体系 · 本周行动',
      steps: [
        '把高数错题本按「最小可回忆单元」拆卡（一卡一考点）',
        '合并重复牌组，统一到「考研复习」主牌组',
        '把每日复习节奏调整为 70% 到期卡 + 30% 新卡',
        '为「换元法」「中值定理」两个薄弱标签做专项默写',
        '周日晚上回顾本周 FSRS 留存曲线，微调新卡上限',
      ],
    },
    toolOutput: {
      success: true,
      todoListId: 'todo_demo_srs',
      title: '间隔重复复习体系 · 本周行动',
      progress: '1/5 completed',
      completedCount: 1,
      totalCount: 5,
      isAllDone: false,
      continue_execution: true,
      currentRunning: {
        id: 'todo_demo_2',
        description: '合并重复牌组，统一到「考研复习」主牌组',
        status: 'running',
        createdAt: 1756800000000,
        updatedAt: 1756800060000,
      },
      nextStep: {
        id: 'todo_demo_3',
        description: '把每日复习节奏调整为 70% 到期卡 + 30% 新卡',
        status: 'pending',
        createdAt: 1756800000000,
      },
      steps: [
        {
          id: 'todo_demo_1',
          description: '把高数错题本按「最小可回忆单元」拆卡（一卡一考点）',
          status: 'completed',
          result: '已在「高数错题 → Anki 卡片」会话中示范拆分（3 道错题 → 5 张单点卡）',
          createdAt: 1756800000000,
          updatedAt: 1756800050000,
        },
        {
          id: 'todo_demo_2',
          description: '合并重复牌组，统一到「考研复习」主牌组',
          status: 'running',
          createdAt: 1756800000000,
          updatedAt: 1756800060000,
        },
        {
          id: 'todo_demo_3',
          description: '把每日复习节奏调整为 70% 到期卡 + 30% 新卡',
          status: 'pending',
          createdAt: 1756800000000,
        },
        {
          id: 'todo_demo_4',
          description: '为「换元法」「中值定理」两个薄弱标签做专项默写',
          status: 'pending',
          createdAt: 1756800000000,
        },
        {
          id: 'todo_demo_5',
          description: '周日晚上回顾本周 FSRS 留存曲线，微调新卡上限',
          status: 'pending',
          createdAt: 1756800000000,
        },
      ],
      message: '还剩 4 项，我会继续执行。',
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    delay: 300,
    content: `清单建好了，第 1 项其实在上面两个会话里已经帮你做完了。后续几项我会持续推进，完成后提醒你。

想调整优先级，或者把某一步展开细讲，直接说。`,
  },
];

// ============================================================================
// 导出
// ============================================================================

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
  }),
  makeFixture({
    id: 'demo-pdf-deepread',
    title: '《机器学习系统》第 3 章精读',
    description: 'PDF 页码引用 + 内嵌思维导图 + 挖空卡片',
    minutesAgo: 18,
    autoPrompt: '我上传的《机器学习系统》第 3 章讲的是数据并行训练，帮我梳理这章的知识框架，再出几张卡片',
    attachmentRefs: [
      {
        resourceId: DEMO_PDF_RESOURCE_ID,
        hash: `hash_${DEMO_PDF_SOURCE_ID}`,
        typeId: 'file',
        displayName: DEMO_PDF_NAME,
      },
    ],
    reply: PDF_REPLY,
  }),
  makeFixture({
    id: 'demo-spaced-repetition',
    title: '间隔重复研究综述',
    description: '用户记忆 + 网络检索 + 学术搜索，综述落成待办清单',
    minutesAgo: 47,
    autoPrompt: '帮我查一下间隔重复（spaced repetition）领域最近有什么值得关注的进展',
    reply: RESEARCH_REPLY,
  }),
];

/** 演示用模型列表（get_model_profiles） */
export const DEMO_MODEL_PROFILES = [
  { id: 'demo-deepseek-v4', label: 'DeepSeek V4', model: 'deepseek-v4' },
  { id: 'demo-kimi-k3', label: 'Kimi K3', model: 'kimi-k3' },
];
