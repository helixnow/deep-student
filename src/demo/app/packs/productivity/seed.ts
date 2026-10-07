/**
 * 第 10 章「效率工具」的剧本数据：一位同时备战考研和期末的学生这一周的待办。
 * 日期全部相对「今天」生成（访客哪天打开都是同一副样子）。
 */
import type { TodoItem, TodoList } from '@/features/todo/types';

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** n 天前/后某时刻的 ISO 时间 */
export function isoAt(n: number, hh = 9, mm = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

/** 距离下一个周日的天数（今天是周日则为 0） */
function daysToSunday(): number {
  return (7 - new Date().getDay()) % 7;
}

export const INBOX_ID = 'tdl_inbox';
const KAOYAN = 'tdl_kaoyan';
const FINAL = 'tdl_final';
const ENGLISH = 'tdl_english';
const LIFE = 'tdl_life';

export function seedLists(): TodoList[] {
  const at = isoAt(-20);
  return [
    { id: INBOX_ID, title: '收件箱', sortOrder: 0, isDefault: true, isFavorite: false, createdAt: at, updatedAt: at },
    { id: KAOYAN, title: '考研冲刺', icon: 'graduation-cap', color: '#6366f1', sortOrder: 1, isDefault: false, isFavorite: true, createdAt: at, updatedAt: at },
    { id: FINAL, title: '期末复习', icon: 'book', color: '#f97316', sortOrder: 2, isDefault: false, isFavorite: true, createdAt: at, updatedAt: at },
    { id: ENGLISH, title: '英语', icon: 'lightbulb', color: '#0ea5e9', sortOrder: 3, isDefault: false, isFavorite: false, createdAt: at, updatedAt: at },
    { id: LIFE, title: '生活', icon: 'coffee', color: '#22c55e', sortOrder: 4, isDefault: false, isFavorite: false, createdAt: at, updatedAt: at },
  ];
}

/** 关联资料：一本教材、一篇笔记（dstu_get 用） */
export const DEMO_LINKED_NODES = [
  { id: 'tb_gaoshu_tongji', name: '高等数学（第七版）下册.pdf', type: 'textbook' },
  { id: 'note_duoyuan_weifen', name: '多元函数微分学 · 知识点梳理', type: 'note' },
  { id: 'note_tezhengzhi', name: '特征值与相似对角化 · 错题整理', type: 'note' },
] as const;

interface SeedItem {
  id: string;
  list: string;
  title: string;
  description?: string;
  priority?: TodoItem['priority'];
  due?: number;
  time?: string;
  reminder?: string;
  tags?: string[];
  parent?: string;
  done?: number; // 完成于 n 天前（0 = 今天）
  repeat?: Record<string, unknown>;
  attachments?: string[];
  est?: number;
  pomos?: number;
  deleted?: boolean;
}

function seedItemDefs(): SeedItem[] {
  const sunday = daysToSunday();
  return [
    // —— 今天 ——
    {
      id: 'todo_gaoshu_3_2', list: KAOYAN, title: '高数：多元函数微分 习题 3-2',
      description: '张宇 1000 题对应章节同步做；重点是隐函数求导和方向导数，做完对答案把错题拍进错题本。',
      priority: 'high', due: 0, time: '09:30', tags: ['高等数学', '考研'], est: 4, pomos: 2,
      attachments: ['/tb_gaoshu_tongji', '/note_duoyuan_weifen'],
    },
    { id: 'todo_gs_sub1', list: KAOYAN, parent: 'todo_gaoshu_3_2', title: '偏导数与全微分（1–8 题）', done: 0 },
    { id: 'todo_gs_sub2', list: KAOYAN, parent: 'todo_gaoshu_3_2', title: '复合函数求导链式法则（9–14 题）', done: 0 },
    { id: 'todo_gs_sub3', list: KAOYAN, parent: 'todo_gaoshu_3_2', title: '隐函数求导（15–20 题）' },
    { id: 'todo_gs_sub4', list: KAOYAN, parent: 'todo_gaoshu_3_2', title: '方向导数与梯度（21–26 题）' },
    {
      id: 'todo_orgchem_report', list: FINAL, title: '有机化学实验报告：乙酸乙酯的制备',
      description: '补充产率计算和误差分析；附上分液漏斗操作的注意事项。',
      priority: 'urgent', due: 0, time: '23:00', reminder: `${dayOffset(0)}T21:00`, tags: ['有机化学', '实验'], est: 2,
    },
    {
      id: 'todo_linalg_wrong', list: FINAL, title: '线代：特征值与相似对角化 错题回顾',
      priority: 'high', due: 0, tags: ['线性代数', '错题'], est: 2, pomos: 1,
      attachments: ['/note_tezhengzhi'],
    },
    {
      id: 'todo_words', list: ENGLISH, title: '背单词：新词 50 + 复习 120',
      priority: 'medium', due: 0, time: '08:00', tags: ['考研英语'], repeat: { freq: 'daily', interval: 1 }, est: 1,
    },
    {
      id: 'todo_reading', list: ENGLISH, title: '英语一阅读 2018 Text 2 精读',
      description: '生词整理进单词本，长难句拆两句。',
      priority: 'medium', due: 0, tags: ['考研英语'], est: 1, pomos: 1, done: 0,
    },
    { id: 'todo_express', list: LIFE, title: '去校门口快递站取包裹', priority: 'none', due: 0, done: 0 },
    // —— 已过期 ——
    {
      id: 'todo_prob_hw', list: FINAL, title: '交概率论作业：第二章 随机变量及其分布',
      description: '习题 2.3、2.7、2.11，周一课前交到学习委员处。',
      priority: 'high', due: -1, time: '18:00', tags: ['概率论', '作业'],
    },
    // —— 即将到期 ——
    {
      id: 'todo_politics', list: KAOYAN, title: '政治：马原第一章 精讲 + 选择题 40 道',
      priority: 'medium', due: 1, tags: ['考研政治'], est: 3,
    },
    {
      id: 'todo_mlsys_ppt', list: FINAL, title: '机器学习系统 课程项目中期汇报 PPT',
      description: '数据并行 vs 流水线并行的对比实验，第 4 页放吞吐曲线；组会前先给组员过一遍。',
      priority: 'high', due: 2, time: '14:00', tags: ['机器学习系统', '小组作业'], est: 3,
    },
    { id: 'todo_ppt_sub1', list: FINAL, parent: 'todo_mlsys_ppt', title: '跑完 4 卡对比实验，导出吞吐数据' },
    { id: 'todo_ppt_sub2', list: FINAL, parent: 'todo_mlsys_ppt', title: '画吞吐-批大小曲线' },
    { id: 'todo_ppt_sub3', list: FINAL, parent: 'todo_mlsys_ppt', title: '写讲稿，控制在 8 分钟' },
    { id: 'todo_library', list: LIFE, title: '图书馆续借《数学分析》', priority: 'low', due: 3 },
    {
      id: 'todo_linalg_mock', list: FINAL, title: '线代期末模拟卷（限时 120 分钟）',
      priority: 'high', due: 4, time: '19:00', tags: ['线性代数'], est: 4,
    },
    { id: 'todo_essay_tpl', list: ENGLISH, title: '整理大作文模板：图画作文三段式', priority: 'low', due: 5, tags: ['考研英语', '写作'] },
    {
      id: 'todo_weekly_review', list: KAOYAN, title: '本周学习复盘',
      description: '看一下周报：正确率最低的知识点下周加练。',
      priority: 'medium', due: sunday === 0 ? 7 : sunday, time: '20:00', tags: ['复盘'],
      repeat: { freq: 'weekly', interval: 1 },
    },
    // —— 无日期（收件箱） ——
    { id: 'todo_errbook', list: INBOX_ID, title: '整理高数错题本：极限与连续', priority: 'medium', tags: ['高等数学', '错题'] },
    { id: 'todo_print', list: INBOX_ID, title: '打印线代近三年期末真题', priority: 'low' },
    { id: 'todo_ask_ta', list: INBOX_ID, title: '问助教：期末是否考二次型的规范形', priority: 'none' },
    // —— 前几天完成的 ——
    { id: 'todo_done_ch2', list: KAOYAN, title: '高数：一元函数积分学 强化课', priority: 'high', due: -2, tags: ['高等数学', '考研'], done: 2, est: 3, pomos: 3 },
    { id: 'todo_done_quiz', list: FINAL, title: '有机化学随堂测：烯烃的加成反应', priority: 'medium', due: -1, tags: ['有机化学'], done: 1 },
    { id: 'todo_done_words', list: ENGLISH, title: '英语一阅读 2017 Text 4 精读', priority: 'medium', due: -1, tags: ['考研英语'], done: 1, est: 1, pomos: 1 },
    // —— 回收站 ——
    { id: 'todo_trash_old', list: INBOX_ID, title: '旧的暑期复习计划（已作废）', priority: 'none', deleted: true },
  ];
}

export function seedItems(): TodoItem[] {
  const defs = seedItemDefs();
  const order = new Map<string, number>();
  return defs.map((def) => {
    const key = `${def.list}:${def.parent ?? ''}`;
    const sortOrder = order.get(key) ?? 0;
    order.set(key, sortOrder + 1);
    const created = isoAt(-6, 8, 0);
    const updated = def.done !== undefined ? isoAt(-def.done, 10 + (sortOrder % 8), 15) : created;
    return {
      id: def.id,
      todoListId: def.list,
      title: def.title,
      ...(def.description ? { description: def.description } : {}),
      status: def.done !== undefined ? 'completed' : 'pending',
      priority: def.priority ?? 'none',
      ...(def.due !== undefined ? { dueDate: dayOffset(def.due) } : {}),
      ...(def.time ? { dueTime: def.time } : {}),
      ...(def.reminder ? { reminder: def.reminder } : {}),
      tagsJson: JSON.stringify(def.tags ?? []),
      sortOrder,
      ...(def.parent ? { parentId: def.parent } : {}),
      ...(def.done !== undefined ? { completedAt: updated } : {}),
      ...(def.repeat ? { repeatJson: JSON.stringify(def.repeat) } : {}),
      attachmentsJson: JSON.stringify(def.attachments ?? []),
      ...(def.est !== undefined ? { estimatedPomodoros: def.est } : {}),
      completedPomodoros: def.pomos ?? 0,
      createdAt: created,
      updatedAt: updated,
      ...(def.deleted ? { deletedAt: isoAt(-3, 22, 10) } : {}),
    };
  });
}

/** AI 拆解的预置结果（演示没有模型：只有这几条任务能拆） */
export const DEMO_BREAKDOWNS: Record<string, string[]> = {
  todo_orgchem_report: ['整理原始数据，算粗产率与精制产率', '写实验原理与反应方程式', '误差分析：酯化可逆、洗涤损失', '补分液漏斗操作要点与思考题'],
  todo_linalg_wrong: ['重做 3 道求特征值的计算错题', '复习可对角化的充要条件', '总结实对称矩阵正交对角化步骤', '把易错点记进错题本'],
  todo_politics: ['看马原第一章精讲视频（物质与意识）', '画本章思维导图', '做选择题 40 道并订正', '错题对应知识点回看讲义'],
  todo_linalg_mock: ['准备草稿纸和计时器', '限时完成模拟卷', '对答案并标出失分题型', '针对失分题型各补 2 道练习'],
  todo_errbook: ['筛出极限计算类错题', '按「等价无穷小 / 洛必达 / 夹逼」分类', '每类写一句易错提示', '挑 5 道做成闪卡'],
};

/** 番茄钟：近 days 天的逐日数据（确定性生成，今天 3 个） */
export function pomodoroDaily(days: number): { date: string; completedCount: number; focusSeconds: number; interruptedCount: number }[] {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const seed = (i * 37 + 11) % 9;
    const weekend = new Date(Date.now() - i * 86_400_000).getDay() % 6 === 0;
    let count = i === 0 ? 3 : Math.max(0, (weekend ? 3 : 5) + (seed % 5) - 2);
    if (i > 0 && seed === 7) count = 0;
    out.push({
      date: dayOffset(-i),
      completedCount: count,
      focusSeconds: count * 25 * 60 + (i === 0 ? 0 : (seed % 3) * 300),
      interruptedCount: i === 0 ? 1 : seed % 4 === 0 ? 1 : 0,
    });
  }
  return out;
}

/** 定时任务（chat_v2_automation_*，后端 snake_case 序列化） */
export function seedAutomations() {
  const nextAt = (offsetDays: number, hh: number, mm: number) => isoAt(offsetDays, hh, mm);
  const now = new Date();
  const morningPassed = now.getHours() * 60 + now.getMinutes() > 7 * 60 + 30;
  const eveningPassed = now.getHours() * 60 + now.getMinutes() > 21 * 60 + 30;
  return [
    {
      id: 'auto_morning', version: 3, name: '晨间复习提醒',
      schedule: { kind: 'daily', time: '07:30' },
      prompt: '今天有到期的闪卡和错题，先花 20 分钟复习再开始新内容。',
      enabled: true, action_type: 'notify', heartbeat: false, catch_up_policy: 'skip',
      max_retries: 0, retry_backoff_seconds: 60, timeout_seconds: 600,
      created_at: isoAt(-21, 22, 0), last_run_at: isoAt(morningPassed ? 0 : -1, 7, 30),
      next_trigger_at: nextAt(morningPassed ? 1 : 0, 7, 30),
    },
    {
      id: 'auto_daily_mistakes', version: 2, name: '每日错题汇总',
      schedule: { kind: 'daily', time: '21:30' },
      prompt: '汇总我今天新增的错题，按知识点分组，并给出明天的复习建议。',
      agent_prompt: '汇总我今天新增的错题，按知识点分组，并给出明天的复习建议。',
      enabled: true, action_type: 'agent_turn', heartbeat: false, session_mode: 'isolated',
      model_id: 'demo-deepseek-v4', catch_up_policy: 'run_once',
      max_retries: 2, retry_backoff_seconds: 60, timeout_seconds: 600,
      created_at: isoAt(-14, 20, 0), last_run_at: isoAt(eveningPassed ? 0 : -1, 21, 30),
      next_trigger_at: nextAt(eveningPassed ? 1 : 0, 21, 30),
    },
    {
      id: 'auto_weekly_report', version: 1, name: '每周学习报告',
      schedule: { kind: 'weekly', time: '20:00', weekday: 0, weekdays: [0] },
      prompt: '生成本周学习报告：学习天数、做题正确率、番茄专注时长和薄弱知识点。',
      agent_prompt: '生成本周学习报告：学习天数、做题正确率、番茄专注时长和薄弱知识点。',
      enabled: true, action_type: 'agent_turn', heartbeat: false, session_mode: 'isolated',
      catch_up_policy: 'run_once', max_retries: 2, retry_backoff_seconds: 60, timeout_seconds: 900,
      created_at: isoAt(-30, 19, 0), last_run_at: isoAt(-((new Date().getDay() || 7)), 20, 0),
      next_trigger_at: nextAt(daysToSunday() || 7, 20, 0),
    },
    {
      id: 'auto_sit_break', version: 1, name: '久坐休息提醒',
      schedule: { kind: 'interval', time: '', interval_minutes: 90 },
      prompt: '已经连续学习 90 分钟了，起来活动 5 分钟、喝口水。',
      enabled: false, action_type: 'notify', heartbeat: false, catch_up_policy: 'skip',
      max_retries: 0, retry_backoff_seconds: 60, timeout_seconds: 600,
      created_at: isoAt(-9, 15, 0),
    },
  ];
}

export function seedAutomationRuns() {
  const run = (id: string, automationId: string, daysAgo: number, hh: number, mm: number, status: string, summary?: string, sessionId?: string) => ({
    id, automation_id: automationId, status, trigger_type: 'schedule',
    scheduled_for: isoAt(-daysAgo, hh, mm), fired_at: isoAt(-daysAgo, hh, mm),
    attempt: 1, max_attempts: 3,
    started_at: isoAt(-daysAgo, hh, mm), finished_at: isoAt(-daysAgo, hh, mm + 1),
    duration_ms: status === 'success' && sessionId ? 48_000 + daysAgo * 3100 : 120,
    delivered: sessionId ? ['notification', 'session'] : ['notification', 'todo'],
    ...(summary ? { summary } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  return [
    run('run_m1', 'auto_daily_mistakes', 1, 21, 30, 'success', '新增错题 6 道：隐函数求导 3 道、特征值计算 2 道、条件概率 1 道。建议明早先重做隐函数那 3 道。', 'sess_auto_m1'),
    run('run_r1', 'auto_morning', 1, 7, 30, 'success', '已发送提醒，并生成待办「复习到期闪卡」。'),
    run('run_m2', 'auto_daily_mistakes', 2, 21, 30, 'success', '新增错题 4 道，集中在定积分换元（3 道）。', 'sess_auto_m2'),
    run('run_r2', 'auto_morning', 2, 7, 30, 'success', '已发送提醒，并生成待办「复习到期闪卡」。'),
    run('run_w1', 'auto_weekly_report', (new Date().getDay() || 7), 20, 0, 'success', '本周学习 6 天，做题 182 道，正确率 78%（↑4%）；番茄 31 个。薄弱点：隐函数求导、相似对角化。', 'sess_auto_w1'),
  ];
}
