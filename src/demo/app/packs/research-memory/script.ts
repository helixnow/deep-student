/**
 * 第 03 章剧本：调研模式下的一次多步骤调研。
 *
 * 先读用户记忆（每天 90 分钟、先默写再核对），建任务清单，依次联网搜索、学术搜索、检索本地知识库，
 * 把调研报告写进笔记，最后清单全部勾完、正文带 [记忆-N] [搜索-N] [知识库-N] 徽章总结。
 * 记忆、网络与学术来源直接取对话演示会话③（间隔重复综述）的同一批块，两边口径一致。
 */
import type { DemoBlockDef, DemoBlocks } from '../../../fixtures';
import type { DemoPaneNote } from '../../data/chat/ChatWithSourcePane';
import { DEMO_SESSIONS } from '../../../fixtures';

const survey = DEMO_SESSIONS.find((s) => s.meta.id === 'demo-spaced-repetition')?.followUp ?? [];
const pick = (type: string): DemoBlockDef[] => survey.filter((b) => b.type === type);

export const RESEARCH_SESSION_ID = 'demo-research-mode';
export const RESEARCH_TITLE = '调研 · 间隔重复怎样安排复习';
export const RESEARCH_PROMPT =
  '用调研模式帮我调研间隔重复：记忆模型和复习调度各有哪些代表性研究，开源实现做到了什么程度，结合我的复习习惯给出建议，最后把报告存进笔记。';

const STEPS = [
  '回顾学习档案与复习偏好',
  '联网检索开源实现与文档',
  '检索学术论文：记忆模型与调度',
  '对照本地复习记录',
  '撰写调研报告并存入笔记',
];

const steps = (done: number) =>
  STEPS.map((description, i) => ({
    id: `todo_research_${i + 1}`,
    description,
    status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
    createdAt: 1788739200000,
  }));

const todoOutput = (done: number, message: string) => ({
  success: true,
  todoListId: 'todo_demo_research',
  title: '间隔重复调研',
  progress: `${done}/${STEPS.length} completed`,
  completedCount: done,
  totalCount: STEPS.length,
  isAllDone: done === STEPS.length,
  continue_execution: done < STEPS.length,
  currentRunning: done < STEPS.length ? `todo_research_${done + 1}` : null,
  steps: steps(done),
  message,
});

const REPORT = `# 调研报告 · 间隔重复：从记忆模型到复习安排

## 调研概述
围绕「怎样估计遗忘」与「何时安排复习」两个问题，查阅开源实现、学术论文与本人近一个月的复习记录。

## 主要发现
1. **记忆模型**：HLR（ACL 2016）用学习行为特征预测记忆半衰期，把回忆概率建模为随时间衰减的函数。
2. **复习调度**：PNAS 2019 把复习安排写成随机最优控制问题，在回忆率与复习量之间求平衡。
3. **开源实现**：FSRS 提供记忆状态更新、参数训练与调度代码，已有 Rust 实现。

## 详细分析
- 本人近四周平均每天复习 82 分钟，新卡偏多的日子到期卡积压明显。
- 「先默写、再核对」的习惯与主动回忆的研究结论一致，可保留。

## 结论与建议
- 每天 90 分钟按「到期卡 60 分钟 + 新卡 20 分钟 + 错题 10 分钟」分配；
- 新卡上限随到期卡数量浮动，连续两天超时则减半；
- 每两周用复习记录重新训练一次调度参数。

## 参考来源
- open-spaced-repetition/fsrs4anki、fsrs-rs（GitHub）
- Settles & Meeder, A Trainable Spaced Repetition Model for Language Learning, ACL 2016
- Tabibian et al., Enhancing Human Learning via Spaced Repetition Optimization, PNAS 2019`;

export const RESEARCH_REPLY: DemoBlocks = [
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    content:
      '这是一次调研任务：先读学习档案确认可用时间和复习习惯，再拆成清单逐项执行。网络搜索找开源实现，学术搜索找记忆模型与调度的代表性论文，本地知识库对照实际复习记录，最后把结论写成固定结构的报告存进笔记。',
  },
  ...pick('memory'),
  {
    type: 'tool_call',
    status: 'success',
    toolName: 'builtin-todo_init',
    dwellMs: 500,
    toolInput: { title: '间隔重复调研', steps: STEPS },
    toolOutput: todoOutput(1, '已拆成 5 个步骤，按顺序执行。'),
  },
  ...pick('web_search'),
  ...pick('academic_search'),
  {
    type: 'rag',
    status: 'success',
    dwellMs: 700,
    toolName: 'unified_search',
    toolInput: { query: '复习时长 到期卡 新卡 记录' },
    toolOutput: {
      query: '复习时长 到期卡 新卡 记录',
      totalResults: 2,
      durationMs: 640,
      sources: [
        {
          title: '九月复习记录.md',
          url: '/笔记/九月复习记录.md',
          snippet: '……近四周平均每天复习 82 分钟；新卡超过 30 张的三天，第二天到期卡积压到 140 张以上……',
          score: 0.88,
          metadata: { sourceId: 'note_demo_review_log', resourceId: 'note_demo_review_log', resourceType: 'note' },
        },
        {
          title: '考研复习计划（下半年）.md',
          url: '/笔记/考研复习计划（下半年）.md',
          snippet: '……每天固定 90 分钟复习时段，高数错题与英语单词卡交替进行……',
          score: 0.81,
          metadata: { sourceId: 'note_demo_plan', resourceId: 'note_demo_plan', resourceType: 'note' },
        },
      ],
    },
  },
  {
    type: 'tool_call',
    status: 'success',
    toolName: 'builtin-note_create',
    dwellMs: 600,
    toolInput: { title: '调研报告 · 间隔重复：从记忆模型到复习安排', content: REPORT, folder_id: 'fld_demo_research' },
    toolOutput: { success: true, note_id: 'note_demo_srs_report', title: '调研报告 · 间隔重复：从记忆模型到复习安排', content: REPORT, wordCount: REPORT.length },
  },
  {
    type: 'tool_call',
    status: 'success',
    toolName: 'builtin-todo_update',
    dwellMs: 300,
    toolInput: { todoListId: 'todo_demo_research', completed: STEPS.map((_, i) => `todo_research_${i + 1}`) },
    toolOutput: todoOutput(STEPS.length, '所有任务已完成。'),
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    content: `调研完成，报告已存进笔记「调研报告 · 间隔重复：从记忆模型到复习安排」。要点如下：

**记忆模型**：HLR 用学习行为特征预测记忆半衰期，把「多久会忘」变成可以估计的量。[搜索-3]

**复习调度**：PNAS 2019 把复习安排写成随机最优控制问题，在回忆率和复习量之间找平衡。[搜索-4] FSRS 把这类思路做成了可训练的开源调度器。[搜索-1] [搜索-2]

**结合你的情况**：档案里每天留了 90 分钟 [记忆-1]，而近四周实际平均 82 分钟，新卡多的日子第二天会积压。[知识库-1] 建议按「到期卡 60 + 新卡 20 + 错题 10 分钟」分配，新卡上限随到期卡浮动；你习惯先默写再核对 [记忆-2]，这和主动回忆的研究结论一致，保留即可。`,
  },
];

/** 访客追问 */
export const RESEARCH_FOLLOW_UPS: Array<{ keywords: string[]; reply: DemoBlocks }> = [
  {
    keywords: ['记住', '记一下', 'remember'],
    reply: (content) => {
      const fact = content.replace(/^\s*(请)?(帮我)?(记住|记一下|remember)[:：,，\s]*/i, '').trim() || content.trim();
      return [
        {
          type: 'tool_call',
          status: 'success',
          toolName: 'builtin-memory_write_smart',
          dwellMs: 500,
          toolInput: { content: fact, category: 'preference' },
          toolOutput: { success: true, action: 'create', note_id: 'note_demo_memory_new', title: fact.slice(0, 24) },
        },
        {
          type: 'content',
          status: 'success',
          streaming: true,
          content: `好的，已记下：「${fact}」。之后的对话会自动检索到这条记忆，相关的回答上方会出现「用户记忆」块。\n\n在桌面版里，所有记忆都以笔记形式存放在资源库的「AI 记忆」中，可以查看、编辑、删除或导出；不想被记住的内容，也可以在「设置 → 记忆」里关掉自动提取。`,
        },
      ];
    },
  },
  {
    keywords: ['记忆', '偏好', '画像'],
    reply: [
      {
        type: 'memory',
        status: 'success',
        dwellMs: 400,
        toolOutput: { sources: [
          { title: '学习档案', snippet: '每天计划安排 90 分钟复习。', metadata: { note_id: 'note_demo_profile' } },
          { title: '复习偏好', snippet: '喜欢先合上材料写出答案，再核对原文和推导过程。', metadata: { note_id: 'note_demo_preference' } },
        ] },
      },
      {
        type: 'content',
        status: 'success',
        streaming: true,
        content: '目前关于你的记忆有两条：每天安排 90 分钟复习 [记忆-1]，以及习惯先默写、再核对原文 [记忆-2]。点上面「记忆搜索」展开，可以打开对应的记忆条目。\n\n想补充新的信息，直接说「记住：……」即可。',
      },
    ],
  },
  {
    keywords: ['fsrs', 'sm-2', 'sm2', '算法', '区别'],
    reply: [
      {
        type: 'content',
        status: 'success',
        streaming: true,
        content: '**SM-2** 用一个「难度系数」乘上上一次间隔得到下一次间隔，规则简单、参数固定。\n\n**FSRS** 为每张卡维护「稳定性、难度、可提取性」三个记忆状态，用复习记录训练参数，再按目标回忆率反推下一次复习时间。[搜索-1]\n\n直观差别：SM-2 对所有人用同一套规则，FSRS 会根据你自己的遗忘曲线调整，所以同样的目标回忆率下通常能少复习一些。',
      },
    ],
  },
];

export const RESEARCH_FALLBACK: DemoBlocks = [
  {
    type: 'content',
    status: 'success',
    streaming: true,
    content:
      '这段演示里的调研结果来自预设材料：可以展开上面的搜索块核对来源、看任务清单的进度，或者试试「记住：我每天复习 90 分钟」，看 AI 怎样写入记忆。\n\n在 Deep Student 桌面版里配置搜索引擎和模型后，输入 `/research-mode` 加上你的主题，就能让 AI 真正联网完成调研。',
  },
];

/** 右侧窗格能打开的笔记：调研报告、两条用户记忆、知识库里的复习记录与计划、追问时写入的记忆 */
export const RESEARCH_NOTES: Record<string, DemoPaneNote> = {
  note_demo_srs_report: { title: '调研报告 · 间隔重复：从记忆模型到复习安排', folder: '笔记 / 调研', content: REPORT },
  note_demo_profile: {
    title: '学习档案',
    folder: 'AI 记忆 / 通用',
    content: '- 考研备考中，目标院校计算机专业\n- 每天计划安排 **90 分钟**复习，固定在晚上\n- 薄弱科目：高等数学（积分换元、中值定理）',
  },
  note_demo_preference: {
    title: '复习偏好',
    folder: 'AI 记忆 / 偏好',
    content: '- 喜欢先合上材料写出答案，再核对原文和推导过程\n- 卡片背面要保留推导要点，不只写结论',
  },
  note_demo_review_log: {
    title: '九月复习记录',
    folder: '笔记 / 学习记录',
    content: '| 周次 | 日均复习 | 新卡 | 到期卡峰值 |\n|---|---|---|---|\n| 第 1 周 | 78 分钟 | 22 | 96 |\n| 第 2 周 | 85 分钟 | 31 | 142 |\n| 第 3 周 | 80 分钟 | 18 | 88 |\n| 第 4 周 | 84 分钟 | 33 | 151 |\n\n新卡超过 30 张的那几天，第二天到期卡明显积压。',
  },
  note_demo_plan: {
    title: '考研复习计划（下半年）',
    folder: '笔记 / 计划',
    content: '- 每天固定 90 分钟复习时段\n- 高数错题与英语单词卡交替进行\n- 每周日晚回顾一周的错题本',
  },
};
