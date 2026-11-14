// 用法（在 video/ 下）：node scripts/capture/wb2.mjs <scenario> —— 工作台（OS）模式 + 注入演示数据，截真实界面作宣传片对照
// 截图与 DOM 取证写到 video/out/cap/（被 git 忽略）；需要 `npm run tauri dev` 的 vite :1422 在跑。
// 只拦截 vite 返回的模块文本，不改仓库文件。时钟固定从 2026-10-03 07:30（周六）起走。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scenario = process.argv[2] ?? 'desk';
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../out/cap');
const DPR = Number(process.env.DPR ?? 2);
const THEME = process.env.THEME ?? 'light';
const CLOCK = process.env.CLOCK ?? '2026-10-03T07:30:00';

const MOCK = String.raw`
function __vTodoDb() {
  if (globalThis.__vTodo) return globalThis.__vTodo;
  const now = '2026-10-02T21:00:00.000Z';
  const L = (id, title, color, sortOrder, isDefault = false) => ({ id, title, color, sortOrder, isDefault, isFavorite: false, createdAt: now, updatedAt: now });
  const I = (id, todoListId, title, o = {}) => ({ id, todoListId, title, status: 'pending', priority: 'none', tagsJson: '[]', attachmentsJson: '[]', sortOrder: 0, createdAt: now, updatedAt: now, ...o });
  globalThis.__vTodo = {
    lists: [
      L('l-inbox', '收件箱', undefined, 0, true),
      L('l-math', '高等数学', '#0ea5e9', 1),
      L('l-eng', '英语', '#22c55e', 2),
      L('l-res', '调研', '#f59e0b', 3),
    ],
    items: [
      I('i1', 'l-inbox', '复习到期卡片', { dueDate: '2026-10-03', dueTime: '07:30', priority: 'medium', sortOrder: 0 }),
      I('i2', 'l-math', '完成高数期中模拟卷', { dueDate: '2026-10-03', dueTime: '09:00', priority: 'high', estimatedPomodoros: 2, completedPomodoros: 0, sortOrder: 1 }),
      I('i3', 'l-eng', '雅思大作文二稿', { dueDate: '2026-10-03', dueTime: '14:00', priority: 'medium', sortOrder: 2 }),
      I('i4', 'l-res', '调研：大模型怎样辅助数学证明', { dueDate: '2026-10-03', dueTime: '20:00', priority: 'low', sortOrder: 3 }),
      I('i5', 'l-inbox', '复习这批新卡 12 张', { status: 'completed', completedAt: '2026-10-02T13:30:00.000Z', dueDate: '2026-10-02', sortOrder: 4 }),
      I('i6', 'l-math', '读懂拉格朗日中值定理', { status: 'completed', completedAt: '2026-10-02T12:10:00.000Z', dueDate: '2026-10-02', sortOrder: 5 }),
    ],
  };
  return globalThis.__vTodo;
}
function __vMock(cmd, args) {
  const db = __vTodoDb();
  const today = '2026-10-03';
  const pending = () => db.items.filter((i) => i.status === 'pending');
  const withStats = (xs) => xs.map((i) => ({ ...i, subtaskCount: 0, completedSubtaskCount: 0 }));
  const inc = (xs) => (args && args.includeCompleted ? xs : xs.filter((i) => i.status === 'pending'));
  switch (cmd) {
    case 'fsrs_get_stats': return { due: 12, due_count: 12, total: 386, new: 0, learning: 2, review: 384 };
    case 'todo_list_lists': return db.lists;
    case 'todo_ensure_inbox': return db.lists[0];
    case 'todo_get_list': return db.lists.find((l) => l.id === args.listId) ?? null;
    case 'todo_get_item': return db.items.find((i) => i.id === args.itemId) ?? null;
    case 'todo_list_items': return inc(db.items.filter((i) => i.todoListId === args.listId));
    case 'todo_list_items_with_stats': return withStats(inc(db.items.filter((i) => i.todoListId === args.listId)));
    case 'todo_list_today': return inc(db.items.filter((i) => i.dueDate === today));
    case 'todo_list_overdue': return inc(db.items.filter((i) => i.dueDate && i.dueDate < today && i.status === 'pending'));
    case 'todo_list_upcoming': return inc(db.items.filter((i) => i.dueDate && i.dueDate > today));
    case 'todo_list_all_pending': return pending();
    case 'todo_list_completed': return db.items.filter((i) => i.status === 'completed' && (!args.listId || i.todoListId === args.listId));
    case 'todo_list_reminders': return [];
    case 'todo_search': return db.items.filter((i) => i.title.includes(String(args.query ?? '')));
    case 'todo_counts_snapshot': return {
      todayCount: pending().filter((i) => i.dueDate && i.dueDate <= today).length,
      upcomingCount: 0,
      inboxCount: pending().filter((i) => i.todoListId === 'l-inbox').length,
      allPendingCount: pending().length,
      perList: db.lists.map((l) => ({ listId: l.id, pendingCount: pending().filter((i) => i.todoListId === l.id).length })),
    };
    case 'todo_get_active_summary': {
      const t = pending().filter((i) => i.dueDate === today);
      return { todayItems: t.map((i) => ({ id: i.id, title: i.title, priority: i.priority, dueDate: i.dueDate, dueTime: i.dueTime, listTitle: db.lists.find((l) => l.id === i.todoListId).title })), overdueItems: [], upcomingHighPriority: [], stats: { totalPending: pending().length, todayDue: t.length, overdueCount: 0, todayCompleted: 0 } };
    }
    case 'todo_toggle_item': {
      const it = db.items.find((i) => i.id === args.itemId);
      if (it) { it.status = it.status === 'pending' ? 'completed' : 'pending'; it.completedAt = it.status === 'completed' ? new Date().toISOString() : undefined; it.updatedAt = new Date().toISOString(); }
      return it;
    }
    case 'todo_update_item': {
      const it = db.items.find((i) => i.id === args.input.id);
      if (it) Object.assign(it, args.input, { updatedAt: new Date().toISOString() });
      return it;
    }
    case 'todo_trash_counts': return { deletedItems: 0, deletedLists: 0 };
    case 'todo_list_all_tags': return [];
    case 'todo_list_deleted_items': case 'todo_list_deleted_lists': return [];
    case 'todo_stats_overview': return { totalPending: pending().length, totalCompleted: 2, completedToday: 0, overdueCount: 0, completionTrend: [], byList: [], byPriority: [], byTag: [] };
    case 'pomodoro_stats_overview': return { today: { completedCount: 0, totalFocusSeconds: 0, interruptedCount: 0, completedFocusSeconds: 0 }, streak: { currentStreakDays: 3, longestStreakDays: 9 }, daily: [], weekly: [] };
    case 'pomodoro_todo_focus_summary': return { todoItemId: args.todoItemId, todoTitle: null, totalFocusSeconds: 0, completedCount: 0, interruptedCount: 0, firstFocusAt: null, lastFocusAt: null, daily: [] };
    default: return null;
  }
}
`;

// 题目集：给演示题库塞一份 18 题的「高数期中模拟卷」（OCR 导入），资源列表里放几份历史题目集
const QB_SEED = String.raw`
;(() => {
  const now = '2026-10-03T07:20:00.000Z';
  const S = (content, opts, answer, tags, difficulty = 'medium', explanation) => ({ type: 'single_choice', content, options: opts.map((c, i) => ({ key: 'ABCD'[i], content: c })), answer, tags, difficulty, explanation });
  const F = (content, answer, tags, difficulty = 'medium') => ({ type: 'fill_blank', content, answer, tags, difficulty });
  const C = (type, content, answer, tags, difficulty = 'hard') => ({ type, content, answer, tags, difficulty });
  const seed = [
    S('函数 f(x) = x³ − 3x 的极大值点为（　　）', ['x = −1', 'x = 1', 'x = 0', 'x = √3'], 'A', ['导数与极值'], 'easy'),
    S('当 x → 0 时，与 x 等价的无穷小是（　　）', ['sin 2x', 'ln(1 + x)', '1 − cos x', 'x²'], 'B', ['等价无穷小'], 'easy'),
    S('设 y = ln(1 + x²)，则 dy 等于（　　）', ['2x/(1 + x²) dx', '1/(1 + x²) dx', '2x dx', 'x/(1 + x²) dx'], 'A', ['微分'], 'easy'),
    S('曲线 y = eˣ 在点 (0, 1) 处的切线方程为（　　）', ['y = x + 1', 'y = x', 'y = ex', 'y = 2x + 1'], 'A', ['导数的几何意义'], 'easy'),
    S('下列反常积分收敛的是（　　）', ['∫₁^∞ 1/x dx', '∫₁^∞ 1/x² dx', '∫₁^∞ 1/√x dx', '∫₀¹ 1/x dx'], 'B', ['反常积分']),
    S('设 f(x) 在 x₀ 处可导，则极限 lim(h→0) [f(x₀ + 2h) − f(x₀)] / h 等于（　　）', ['f′(x₀)', '2f′(x₀)', '½ f′(x₀)', '0'], 'B', ['导数定义']),
    S('设 f(x) 在 [a, b] 上连续，在 (a, b) 内可导，且 f(a) = f(b)。下列结论一定成立的是（　　）', ['存在 ξ ∈ [a, b]，使 f′(ξ) = 0', '存在 ξ ∈ (a, b)，使 f(ξ) = 0', '存在 ξ ∈ (a, b)，使 f′(ξ) = 0', '对任意 x ∈ (a, b)，都有 f′(x) = 0'], 'C', ['罗尔定理', '中值定理'], 'medium', '罗尔定理：f 在 [a, b] 上连续、(a, b) 内可导且 f(a) = f(b)，则至少存在一点 ξ ∈ (a, b)，使 f′(ξ) = 0。'),
    S('函数 y = x·e⁻ˣ 的单调递增区间是（　　）', ['(−∞, 1)', '(1, +∞)', '(−∞, 0)', '(0, +∞)'], 'A', ['单调性']),
    S('f(x) = x² 在 [0, 2] 上满足拉格朗日中值定理的 ξ =（　　）', ['1/2', '1', '3/2', '2'], 'B', ['拉格朗日中值定理', '中值定理']),
    S('lim(x→0) (eˣ − 1 − x) / x² =（　　）', ['0', '1/2', '1', '∞'], 'B', ['洛必达法则']),
    F('∫₀¹ x·eˣ dx = ____', '1', ['分部积分']),
    F('lim(x→∞) (1 + 2/x)ˣ = ____', 'e²', ['重要极限'], 'easy'),
    F('曲线 y = x³ − 3x² 的拐点为 ____', '(1, −2)', ['凹凸性与拐点']),
    F('曲线 y = x² 与 y = x 所围图形的面积为 ____', '1/6', ['定积分应用']),
    F('eˣ 的二阶麦克劳林多项式为 ____', '1 + x + x²/2', ['泰勒公式']),
    C('short_answer', '证明：当 x > 0 时，ln(1 + x) < x。', '令 f(t) = ln(1 + t)，在 [0, x] 上用拉格朗日中值定理。', ['拉格朗日中值定理', '不等式证明']),
    C('calculation', '求函数 f(x) = x³ − 6x² + 9x + 1 在 [0, 4] 上的最大值与最小值。', '最大值 5，最小值 1', ['导数与极值']),
    C('short_answer', '设 f(x) 在 [0, 1] 上连续，在 (0, 1) 内可导，f(0) = f(1) = 0，f(1/2) = 1。证明：存在 ξ ∈ (0, 1)，使 f′(ξ) = 1。', '构造 F(x) = f(x) − x，先用零点定理再用罗尔定理。', ['罗尔定理', '中值定理'], 'very_hard'),
  ];
  seed.forEach((q, i) => {
    const id = 'q_v_' + (i + 1);
    questions.set(id, { id, exam_id: DEMO_QBANK_ID, question_label: String(i + 1), content: q.content, options: q.options, answer: q.answer, explanation: q.explanation, question_type: q.type, difficulty: q.difficulty, tags: q.tags, status: 'new', attempt_count: 0, correct_count: 0, is_favorite: false, images: [], source_type: 'ocr', created_at: now, updated_at: now });
  });
  // 识别导入的模拟：把同一套 18 题写进新建的题目集
  globalThis.__vSeed = seed;
  globalThis.__vImportInto = (examId) => seed.forEach((q, i) => {
    const id = examId + '_q' + (i + 1);
    questions.set(id, { id, exam_id: examId, question_label: String(i + 1), content: q.content, options: q.options, answer: q.answer, explanation: q.explanation, question_type: q.type, difficulty: q.difficulty, tags: q.tags, status: 'new', attempt_count: 0, correct_count: 0, is_favorite: false, images: [], source_type: 'ocr', created_at: now, updated_at: now });
  });
})();
`;

const PRE = String.raw`
var __VSKIP = Symbol('skip');
function __vExamDb() {
  if (globalThis.__vExam) return globalThis.__vExam;
  const N = (id, name, updated) => ({ id, path: '/' + id, name, type: 'exam', sourceId: id, createdAt: Date.parse(updated), updatedAt: Date.parse(updated), metadata: {} });
  globalThis.__vExam = {
    seq: 0,
    nodes: [
      N('exam_v_la', '线性代数期中 2025', '2026-09-28T10:00:00Z'),
      N('exam_v_chem', '离子方程式专题', '2026-09-24T10:00:00Z'),
      N('exam_v_eng', '英语完形填空 ×5', '2026-09-19T10:00:00Z'),
    ],
  };
  if (!globalThis.__vNoPaper) globalThis.__vExam.nodes.unshift(N(DEMO_QBANK_ID, '高数期中模拟卷', '2026-10-03T07:20:00Z'));
  return globalThis.__vExam;
}
// 作文批改：一篇草稿（只写了原文，没批改过）+ 一篇已批改（1 轮，批改结果按后端 MARKER/SECTION/SCORE 指令的 wire 格式）
var __V_ESSAY_TEXT = 'Some people believe that university education should be free for everyone, while others argue that students should pay for it. In my opinion, the government have to cover most of the cost, but not all of it.\n\nOn the one hand, free education gives every talented students the same chance. Many families cannot afford high tuition fees, and a lot of capable young people give up their studies for this reason.\n\nOn the other hand, completely free universities put heavy pressure on public budgets. If students pay a small part of the fee, they may also value their learning more, which make the system fairer for taxpayers.\n\nIn conclusion, a shared model, where the state pays the majority and students contribute a modest amount, is the most balanced solution.';
var __V_ESSAY_RESULT = 'Some people believe that university education should be free for everyone, while others argue that students <good>should pay</good> for it. In my opinion, <replace old="the government have to" new="the government should" reason="主语 the government 是单数，且表达观点用 should 更自然；have to 语气过强"/> cover most of the cost, but not all of it.\n\nOn the one hand, free education gives <err type="agreement" explanation="every 后接单数名词：every talented student；也可改成 all talented students">every talented students</err> the same chance. Many families cannot afford high tuition fees, and <replace old="a lot of" new="a considerable number of" reason="a lot of 偏口语，学术写作用 a considerable number of 更正式"/> capable young people give up their studies for this reason.\n\nOn the other hand, <note text="completely free 语气绝对，改成 entirely tuition-free 更准确">completely free</note> universities put heavy pressure on public budgets. If students pay a small part of the fee, they may also <good>value their learning more</good>, which <err type="agreement" explanation="which 指代前面整句话，作单数主语，谓语用 makes">make</err> the system fairer for taxpayers.\n\nIn conclusion, a shared model, where the state pays the majority and students contribute a modest amount, is the most balanced solution.\n\n<section-polish>\n<polish-item>\n<original>Many families cannot afford high tuition fees, and a lot of capable young people give up their studies for this reason.</original>\n<polished>Many families cannot afford high tuition fees, which forces a considerable number of capable young people to abandon their studies.</polished>\n</polish-item>\n<polish-item>\n<original>If students pay a small part of the fee, they may also value their learning more</original>\n<polished>Requiring students to contribute a modest share of the fee may also lead them to value their education more highly</polished>\n</polish-item>\n<polish-item>\n<original>In conclusion, a shared model, where the state pays the majority and students contribute a modest amount, is the most balanced solution.</original>\n<polished>In conclusion, a cost-sharing model, in which the state covers the majority and students contribute a modest amount, offers the most balanced solution.</polished>\n</polish-item>\n</section-polish>\n\n<score total="6.5" max="9">\n<dim name="Task Response" score="6.5" max="9">立场明确（政府承担大部分、学生分担小部分），两方面都有展开，但第二段论据停留在一般性陈述，缺少具体例子支撑。</dim>\n<dim name="Coherence & Cohesion" score="7" max="9">四段结构清晰，On the one hand / On the other hand / In conclusion 衔接自然；段内句间推进还可以更紧。</dim>\n<dim name="Lexical Resource" score="6" max="9">基本词汇使用准确，但 a lot of、completely free 等表达偏口语，学术搭配偏少。</dim>\n<dim name="Grammatical Range & Accuracy" score="6.5" max="9">有定语从句和条件句，句式有变化；主谓一致错误出现 3 处（the government have、every talented students、which make）。</dim>\n</score>';
var __V_IELTS = { id: 'ielts', name: '雅思大作文', description: 'IELTS Writing Task 2', system_prompt: '', score_dimensions: [
  { name: 'Task Response', max_score: 9, description: 'Position, ideas, relevance, development' },
  { name: 'Coherence & Cohesion', max_score: 9, description: 'Organisation, paragraphing, cohesive devices' },
  { name: 'Lexical Resource', max_score: 9, description: 'Vocabulary range, accuracy, collocation' },
  { name: 'Grammatical Range & Accuracy', max_score: 9, description: 'Sentence variety, grammar control, punctuation' },
], total_max_score: 9, is_builtin: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
function __vEssayDb() {
  if (globalThis.__vEssay) return globalThis.__vEssay;
  const at = '2026-10-03T06:10:00Z';
  const N = (id, name, updated, meta) => ({ id, path: '/' + id, name, type: 'essay', sourceId: id, createdAt: Date.parse(updated), updatedAt: Date.parse(updated), metadata: meta });
  const S = (id, title, rounds) => ({ id, title, essay_type: 'argumentative', grade_level: 'ielts', custom_prompt: null, created_at: at, updated_at: at, is_favorite: false, total_rounds: rounds });
  globalThis.__vEssay = {
    seq: 0,
    nodes: [
      N('essay_v_draft', '雅思大作文：远程办公的利弊', '2026-10-01T13:10:00Z', { essayType: 'argumentative', gradeLevel: 'ielts', totalRounds: 0, latestInputPreview: __V_ESSAY_TEXT.slice(0, 60) }),
      N('essay_v_done', '雅思大作文：城市该不该限车', '2026-09-28T21:00:00Z', { essayType: 'argumentative', gradeLevel: 'ielts', totalRounds: 1, latestScore: 6.5, latestInputPreview: __V_ESSAY_TEXT.slice(0, 60) }),
    ],
    sessions: { essay_v_draft: S('essay_v_draft', '雅思大作文：远程办公的利弊', 0), essay_v_done: S('essay_v_done', '雅思大作文：城市该不该限车', 1) },
    rounds: {
      essay_v_draft: [],
      essay_v_done: [{ id: 'round_v_1', session_id: 'essay_v_done', round_number: 1, input_text: __V_ESSAY_TEXT, grading_result: __V_ESSAY_RESULT, overall_score: 6.5, dimension_scores_json: null, created_at: at }],
    },
    drafts: { essay_v_draft: __V_ESSAY_TEXT },
  };
  return globalThis.__vEssay;
}
function __vEssayPre(cmd, args) {
  const db = __vEssayDb();
  const sid = args?.sessionId ?? args?.session_id;
  switch (cmd) {
    case 'essay_grading_get_models': return [{ id: 'cfg_v_default', name: 'DeepSeek V4', model: 'deepseek-v4', is_default: true }];
    case 'essay_grading_get_modes': return [__V_IELTS];
    case 'essay_grading_get_mode': return args?.modeId === 'ielts' ? __V_IELTS : null;
    case 'essay_grading_get_session': return db.sessions[sid] ?? null;
    case 'essay_grading_get_rounds': return db.rounds[sid] ?? [];
    case 'essay_grading_get_round': return (db.rounds[sid] ?? []).find((r) => r.round_number === args?.roundNumber) ?? null;
    case 'essay_grading_get_latest_round_number': return (db.rounds[sid] ?? []).length;
    case 'essay_grading_update_session': return null;
    case 'essay_grading_list_sessions': return [];
    case 'essay_grading_stream': {
      const r = args.request;
      const name = 'essay_grading_stream_' + r.stream_session_id;
      const k = Number(globalThis.__vEssaySpeed || 1);
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms * k));
      return (async () => {
        await emit(name, { type: 'progress', stage: 'preparing', char_count: 0 });
        await sleep(600);
        await emit(name, { type: 'progress', stage: 'annotating', char_count: 0 });
        let n = 0;
        for (let i = 0; i < __V_ESSAY_RESULT.length; i += 24) {
          const chunk = __V_ESSAY_RESULT.slice(i, i + 24);
          n += chunk.length;
          if (i === __V_ESSAY_RESULT.indexOf('<section-polish>') - (__V_ESSAY_RESULT.indexOf('<section-polish>') % 24)) await emit(name, { type: 'progress', stage: 'polishing', char_count: n });
          if (i === __V_ESSAY_RESULT.indexOf('<score') - (__V_ESSAY_RESULT.indexOf('<score') % 24)) await emit(name, { type: 'progress', stage: 'scoring', char_count: n });
          await emit(name, { type: 'data', chunk, char_count: n });
          await sleep(45);
        }
        const round = { id: 'round_v_new', session_id: r.session_id, round_number: r.round_number, input_text: r.input_text, grading_result: __V_ESSAY_RESULT, overall_score: 6.5, dimension_scores_json: null, created_at: new Date().toISOString() };
        (db.rounds[r.session_id] = db.rounds[r.session_id] || []).push(round);
        await emit(name, { type: 'complete', grading_result: __V_ESSAY_RESULT, round_id: round.id, overall_score: 6.5, parsed_score: null });
        return { grading_result: __V_ESSAY_RESULT, round_id: round.id, overall_score: 6.5, dimension_scores_json: null };
      })();
    }
  }
  return __VSKIP;
}
// 翻译：「新建翻译」建空记录（dstu_create type=translation）→ 粘贴原文 → 翻译（translate_text_stream：增量 data + complete）
var __V_TR_SOURCE = 'The testing effect refers to the finding that retrieving information from memory produces better long-term retention than restudying the same material for an equal amount of time.\n\nCrucially, the benefit grows when retrieval is effortful and spaced out over days rather than massed into a single session, which is why low-stakes quizzes outperform rereading.\n\nFeedback after each attempt matters as well: learners who see the correct answer immediately correct their misconceptions instead of rehearsing their errors.\n\nTaken together, these results suggest that study tools should schedule retrieval, not exposure — a principle that modern spaced-repetition algorithms such as FSRS make explicit.';
var __V_TR_TARGET = '测试效应指的是：与花同样时间重读材料相比，从记忆中主动提取信息能带来更好的长期保持。\n\n关键在于，当提取需要付出努力、并且分散在数天之内而非集中在一次学习中时，收益会进一步增大——这也是低风险小测优于反复重读的原因。\n\n每次作答后的反馈同样重要：立即看到正确答案的学习者会纠正误解，而不是一再强化自己的错误。\n\n综合来看，这些结果表明，学习工具应当安排「提取」，而不是安排「接触」——FSRS 等现代间隔重复算法正是把这一原则写进了调度之中。';
function __vTrDb() {
  if (globalThis.__vTr) return globalThis.__vTr;
  globalThis.__vTr = { seq: 0, nodes: [], bodies: {} };
  return globalThis.__vTr;
}
function __vTrPre(cmd, args) {
  const db = __vTrDb();
  const id = String(args?.path ?? '').replace(/^\//, '');
  const node = db.nodes.find((x) => x.id === id);
  switch (cmd) {
    case 'dstu_list':
      if (args?.options?.typeFilter === 'translation') return [...db.nodes];
      break;
    case 'dstu_create':
      if (args?.options?.type === 'translation') {
        const nid = 'tr_v_' + (++db.seq);
        const now = Date.now();
        const m = args.options.metadata || {};
        const n = { id: nid, path: '/' + nid, name: args.options.name || '新翻译', type: 'translation', sourceId: nid, createdAt: now, updatedAt: now, metadata: { ...m } };
        db.nodes.unshift(n);
        db.bodies[nid] = JSON.stringify({ source: m.sourceText || '', translated: m.translatedText || '', meta: null });
        return n;
      }
      break;
    case 'dstu_get':
      if (node) return node;
      break;
    case 'dstu_get_content':
      if (node) return db.bodies[id] ?? '';
      break;
    case 'dstu_update':
      if (node) {
        db.bodies[id] = args.content;
        node.updatedAt = Date.now();
        return node;
      }
      break;
    case 'dstu_set_metadata':
      if (node) {
        Object.assign(node.metadata, args.metadata || {});
        return null;
      }
      break;
    case 'translate_text_stream': {
      const r = args.request;
      const name = 'translation_stream_' + r.session_id;
      const k = Number(globalThis.__vTrSpeed || 1);
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms * k));
      return (async () => {
        let n = 0;
        await sleep(500);
        for (let i = 0; i < __V_TR_TARGET.length; i += 6) {
          const chunk = __V_TR_TARGET.slice(i, i + 6);
          n += chunk.length;
          await emit(name, { type: 'data', chunk, char_count: n });
          await sleep(40);
        }
        await emit(name, { type: 'complete', translated_text: __V_TR_TARGET, id: null });
        return null;
      })();
    }
  }
  return __VSKIP;
}
// 09 懂你：记忆根目录已设置 + 6 条记忆（分类取 category_manager.rs 种子分类）、画像、MCP 服务器配置、三家模型配置
function __vYouPre(cmd, args) {
  const at = (h) => new Date(Date.parse('2026-10-03T21:00:00') - h * 3600e3).toISOString();
  const M = (id, title, folderPath, hits, h, o = {}) => ({ id, title, folderPath, updatedAt: at(h), hits, isImportant: false, isStale: false, memoryType: 'fact', memoryPurpose: 'internalized', ...o });
  const mems = [
    M('mem_v_mvt', '中值定理易错点', '经历/学科状态', 3, 0.2),
    M('mem_v_pref', '几何直观优先', '偏好', 6, 1.5),
    M('mem_v_essay', '雅思写作失分点', '经历/学科状态', 2, 6),
    M('mem_v_exam', '高数期末', '经历/时间节点', 1, 20),
    M('mem_v_review', '复习时段', '偏好', 4, 26),
    M('mem_v_bg', '专业与年级', '偏好/个人背景', 2, 30),
  ];
  const content = {
    mem_v_mvt: 'ξ 的取值范围常写成闭区间 [a, b]，应为开区间 (a, b)。',
    mem_v_pref: '讲概念时先看几何直观，再看严格证明。',
    mem_v_essay: '雅思大作文主谓一致仍是主要失分点。',
    mem_v_exam: '高数期末考试在 1 月 12 日，目标 90 分以上。',
    mem_v_review: '习惯晚上 9 点以后复习闪卡。',
    mem_v_bg: '大一，数学与应用数学专业。',
  };
  switch (cmd) {
    case 'memory_get_config': return { memoryRootFolderId: 'fld_v_mem', memoryRootFolderTitle: '记忆', autoCreateSubfolders: true, defaultCategory: '偏好', privacyMode: false, autoExtractFrequency: 'balanced' };
    case 'memory_list': return (args?.offset ?? 0) > 0 ? [] : mems;
    case 'memory_read': { const m = mems.find((x) => x.id === args?.noteId); return m ? { noteId: m.id, title: m.title, content: content[m.id], folderPath: m.folderPath, updatedAt: m.updatedAt } : null; }
    case 'memory_get_profile': return [
      { category: '偏好', content: '先看几何直观再看严格证明；习惯晚上 9 点以后复习闪卡。' },
      { category: '经历/学科状态', content: '中值定理里 ξ 的取值范围容易写成闭区间；雅思大作文主谓一致仍是主要失分点。' },
      { category: '经历/时间节点', content: '高数期末 1 月 12 日，目标 90 分以上。' },
      { category: '偏好/个人背景', content: '大一，数学与应用数学专业。' },
    ];
    case 'memory_get_audit_logs': return [];
    case 'memory_get_tree': return null;
    case 'memory_get_tags': return [];
    case 'memory_get_related': return [];
    case 'get_api_configurations': return [
      ['demo-config-deepseek', '演示模型服务', 'deepseek', 'DeepSeek', 'deepseek-v4', 'https://api.deepseek.com'],
      ['demo-config-glm', '智谱', 'zhipu', '智谱 AI', 'glm-5', 'https://open.bigmodel.cn/api/paas/v4'],
      ['demo-config-kimi', 'Moonshot', 'moonshot', 'Moonshot AI', 'kimi-k3', 'https://api.moonshot.cn/v1'],
    ].map(([id, name, vendorId, vendorName, model, baseUrl]) => ({ id, name, vendorId, vendorName, providerType: 'openai', apiKey: 'demo-key-not-real', baseUrl, model, isMultimodal: false, isReasoning: true, isEmbedding: false, isReranker: false, enabled: true, modelAdapter: 'openai' }));
    case 'get_setting':
      if (args?.key === 'mcp.tools.list') return JSON.stringify(globalThis.__vMcpCfg.map(([id, name, namespace]) => ({ id, name, ...(namespace ? { namespace: namespace + ':' } : {}), transportType: 'stdio' })));
      return __VSKIP;
    default: return __VSKIP;
  }
}
// 按导入标准 mcpServers JSON 的默认形态：id = 键名、不设命名空间（McpToolsSection 新建 / 导入的 namespace 缺省为空）
globalThis.__vMcpCfg = [
  ['arxiv', 'arxiv', '', ['search_papers', 'download_paper', 'list_papers', 'read_paper']],
  ['zotero', 'zotero', '', ['zotero_search_items', 'zotero_get_item_fulltext', 'zotero_get_annotations']],
  ['filesystem', 'filesystem', '', ['read_file', 'write_file', 'list_directory', 'search_files', 'get_file_info']],
];
// 夜里复习（FC=1）：对话「复习这批」→ 闪卡 batch 会话。enqueue 按请求顺序回 state，
// 新卡首评按产品调度器（rs-fsrs 1.2 默认参数、学习步）：重来 1m / 困难 5m / 良好 10m / 简单 15d，
// 首评后稳定性 = w0..w3（0.4072 / 1.1829 / 3.1262 / 15.4722 天）
const __vFcFirst = { 1: [60e3, 0, 1, 0.4072], 2: [300e3, 0, 1, 1.1829], 3: [600e3, 0, 1, 3.1262], 4: [15 * 86400e3, 15, 2, 15.4722] };
// 记忆曲线「最近复习」里排在本次三张之后的两张老卡（昨晚复习过的错题本）
const __vFcOld = [
  { id: 'st_old_lhopital', front: '洛必达法则使用前要先确认什么？', state: 2, stability: 24.23, difficulty: 5.27, ago: 0.93, dueIn: 23, reps: 5, lapses: 1, rating: 3 },
  { id: 'st_old_taylor', front: 'eˣ 在 x = 0 处的三阶麦克劳林展开是什么？', state: 2, stability: 47.79, difficulty: 5.18, ago: 0.95, dueIn: 47, reps: 4, lapses: 0, rating: 3 },
];
function __vFcPre(cmd, args) {
  const now = Date.now();
  const card = (id) => (globalThis.__vFcCards || []).find((c) => c.id === id);
  const rated = (globalThis.__vFcRated ||= []);
  const memory = () => [
    ...rated.slice().reverse().map((r) => {
      const [ms, , state, stability] = __vFcFirst[r.rating];
      return { cardStateId: r.id, ankiCardId: r.id.replace(/^st_/, ''), deckId: 'deck_default', front: card(r.id.replace(/^st_/, ''))?.front ?? '', extraFields: {}, state, stability, difficulty: 5, lastReviewMs: r.at, dueMs: r.at + ms, reps: 1, lapses: 0, lastRating: r.rating };
    }),
    ...__vFcOld.map((c) => ({ cardStateId: c.id, ankiCardId: c.id.slice(3), deckId: 'deck_default', front: c.front, extraFields: {}, state: c.state, stability: c.stability, difficulty: c.difficulty, lastReviewMs: now - c.ago * 86400e3, dueMs: now + c.dueIn * 86400e3, reps: c.reps, lapses: c.lapses, lastRating: c.rating })),
  ];
  switch (cmd) {
    case 'fsrs_enqueue_cards':
      return { states: (args?.ankiCardIds ?? []).map((id) => ({ id: 'st_' + id, ankiCardId: id, front: card(id)?.front ?? '', back: card(id)?.back ?? '', templateId: 'tpl_demo_basic', state: 0, lastReviewMs: null, suspended: false, tags: [], images: [] })) };
    case 'fsrs_get_scheduler_config': return { learnAheadMinutes: 20, dailyNewLimit: 20, dailyReviewLimit: 200 };
    case 'fsrs_preview_intervals': return { previews: [1, 2, 3, 4].map((rating) => ({ rating, dueMs: now + __vFcFirst[rating][0], scheduledDays: __vFcFirst[rating][1], intervalMs: __vFcFirst[rating][0] })) };
    case 'fsrs_rate': {
      const [ms, days, state] = __vFcFirst[args?.rating] ?? __vFcFirst[3];
      rated.push({ id: args?.cardStateId, rating: args?.rating ?? 3, at: now });
      return { logId: 'log_' + now + '_' + Math.random().toString(36).slice(2, 6), dueMs: now + ms, scheduledDays: days, cardState: { state, lastReviewMs: now, suspended: false } };
    }
    case 'fsrs_undo_last_review': rated.pop(); return { ok: true };
    // 386 张老卡（平均可提取率 0.931）+ 本次评过的新卡；近 30 天真实保留率按复习记录的 8% 重来率
    case 'fsrs_get_memory_overview': {
      const recent = memory().slice(0, Math.min(20, Math.max(1, args?.recentLimit ?? 5)));
      const fresh = rated.map((r) => (1 + (19 / 81) * Math.max(0, now - r.at) / 86400e3 / __vFcFirst[r.rating][3]) ** -0.5);
      return { generatedAtMs: now, desiredRetention: 0.9, curve: { decay: -0.5, factor: 19 / 81 }, recent, memorizedCount: 386 + rated.length, averageRetrievability: (386 * 0.931 + fresh.reduce((a, b) => a + b, 0)) / (386 + rated.length), trueRetention: { windowDays: 30, reviews: 1162, passed: 1066 } };
    }
    case 'fsrs_get_card_memory_history': {
      const m = memory().find((c) => c.cardStateId === args?.cardStateId);
      if (!m) throw new Error('fsrs card state not found');
      return { generatedAtMs: now, desiredRetention: 0.9, curve: { decay: -0.5, factor: 19 / 81 }, card: m, reviews: [{ logId: 'log_' + m.cardStateId, reviewMs: m.lastReviewMs, rating: m.lastRating, stateBefore: 0, stateAfter: m.state, stabilityAfter: m.stability, difficultyAfter: m.difficulty, dueAfterMs: m.dueMs }] };
    }
    // 复习完三张之后（良好 / 简单 / 重来）：386 张老卡 + 12 张新卡，新 9、学习中 2+2、复习中 384+1
    case 'fsrs_get_stats': return { total: 398, due: 9, newCount: 9, learning: 4, review: 385, relearning: 0, suspended: 0, reviewsToday: 3, backlog: 0, backlogReview: 0, backlogNew: 0, learningWaiting: 2 };
    case 'fsrs_get_due': return (globalThis.__vFcCards || []).slice(3).map((c) => ({ id: 'st_' + c.id, ankiCardId: c.id, front: c.front, back: c.back, templateId: 'tpl_demo_basic', state: 0, lastReviewMs: null, suspended: false, tags: [], images: [] }));
    case 'fsrs_get_review_statistics': {
      // 一年复习记录（确定性）：越近越密，最近 46 天不断档；评分分布 8 / 14 / 61 / 17%
      const end = Date.parse('2026-10-03T12:00:00');
      const dailyReviews = [];
      for (let i = 364; i >= 0; i--) {
        const r = Math.abs((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1);
        const recent = i < 46;
        const base = 0.15 + 0.6 * ((364 - i) / 364) ** 1.6 + (recent ? 0.35 : 0);
        if (!recent && r > base + 0.15) continue;
        dailyReviews.push({ date: new Date(end - i * 86400e3).toISOString().slice(0, 10), total: i === 0 ? 3 : Math.round(8 + r * 30 + base * 25) });
      }
      return { dailyReviews, ratingDistribution: { again: 337, hard: 589, good: 2568, easy: 716, total: 4210 } };
    }
    default: return __VSKIP;
  }
}
function __vPre(cmd, args) {
  if (globalThis.__vLogIpc) console.log('[ipc] ' + cmd + ' ' + JSON.stringify(args ?? {}).slice(0, 140));
  if (globalThis.__vYou) { const r = __vYouPre(cmd, args); if (r !== __VSKIP) return r; }
  if (globalThis.__vFcCards) { const r = __vFcPre(cmd, args); if (r !== __VSKIP) return r; }
  // 演示 mock 缺省返回 null，AgentTaskPanel 有产物后会读 entries.length / downloads.length（真后端返回空页 / 空数组）
  if (cmd === 'chat_v2_list_runtime_directory') return { rootId: args?.rootId ?? 'workspace', relativePath: args?.relativePath ?? '', entries: [], nextCursor: null, truncated: false, scanned: 0 };
  if (cmd === 'browser_list_task_downloads') return [];
  // 笔记窗的 InsightsSection 读 insights.length，演示 mock 缺省 null 会让整扇笔记窗崩掉（真后端返回空数组）
  if (cmd === 'insight_list') return [];
  // 笔记窗：调研笔记的元数据与正文、文件树、按类型列表（演示 mock 缺省 null：文件树报「nodes is not iterable」、正文停在空态）
  if (cmd === 'dstu_folder_get_tree' || cmd === 'dstu_folder_list') return [];
  if (cmd === 'notes_list_tags') return [];
  // 编辑器宿主：注册 / 心跳拿不到参与者状态会把编辑器判失效（「笔记已更新，正在刷新正文」）；审阅 / 草稿持久化读空表
  if (cmd === 'notes_editor_register' || cmd === 'notes_editor_heartbeat') return { participant_id: args?.participantId ?? 'p_v_note', expires_at: Date.now() + 3600e3, active_lease: null };
  if (cmd === 'notes_state_list') return [];
  // 接受 AI 建议要先拿编辑租约（单窗口：立即 ready、无人等待）
  if (cmd === 'notes_editor_begin') {
    globalThis.__vLease = { token: 'lease_v_' + Date.now(), operation_id: args?.operationId, owner_id: args?.participantId, phase: 'ready', expires_at: Math.floor(Date.now() / 1000) + 600, notes: (args?.noteIds ?? []).map((id) => ({ note_id: id, updated_at: new Date().toISOString() })), waiting_for: [] };
    return globalThis.__vLease;
  }
  if (cmd === 'notes_editor_lease_status' || cmd === 'notes_editor_finish') return globalThis.__vLease ? { ...globalThis.__vLease, notes: globalThis.__vLease.notes.map((n) => ({ ...n, updated_at: new Date().toISOString() })) } : null;
  if (cmd === 'notes_editor_freeze_ack' || cmd === 'notes_editor_release' || cmd === 'notes_editor_refresh_ack' || cmd === 'notes_editor_unregister') return null;
  if (cmd === 'notes_state_put' || cmd === 'notes_state_delete') {
    const r = args?.request ?? {};
    return { note_id: r.note_id, type: r.type, key: r.key, revision: (r.expected_revision ?? 0) + 1, value: r.value ?? null, deleted: cmd === 'notes_state_delete' };
  }
  if (cmd === 'notes_get_format') return { note_id: args?.noteId, content_format: 'markdown-legacy', format_version: 1, serializer_version: 'markdown-v1', required_capabilities: [] };
  if (cmd === 'dstu_list' && (args?.options?.typeFilter === 'note' || args?.options?.typeFilter === 'mindmap')) {
    const N = (id, type, name, at) => ({ id, path: '/' + id, name, type, sourceId: id, resourceId: 'res_' + id, createdAt: Date.parse(at), updatedAt: Date.parse(at), metadata: {} });
    const all = [
      N('note_v_research', 'note', '大模型辅助数学证明：现状与方法', '2026-10-03T20:05:30'),
      N('note_demo_mvt', 'note', '中值定理证明套路', '2026-10-02T21:30:00'),
      N('note_v_err', 'note', '高数错题本（8 月）', '2026-08-28T19:20:00'),
      N('mm_v_mvt', 'mindmap', '微分中值定理', '2026-10-02T21:40:00'),
    ];
    return all.filter((n) => n.type === args.options.typeFilter);
  }
  if (cmd === 'notes_update' && args?.note?.id === 'note_v_research') {
    globalThis.__vNoteBody = args.note.content_md;
    const at = new Date().toISOString();
    return { id: 'note_v_research', title: '大模型辅助数学证明：现状与方法', content_md: args.note.content_md, tags: [], created_at: '2026-10-03T12:05:30.000Z', updated_at: at, is_favorite: false };
  }
  if (cmd === 'dstu_update' && args?.path === '/note_v_research') {
    globalThis.__vNoteBody = args.content;
    const at = Date.parse('2026-10-03T20:05:30');
    return { id: 'note_v_research', path: '/note_v_research', name: '大模型辅助数学证明：现状与方法', type: 'note', sourceId: 'note_v_research', resourceId: 'res_note_v_research', createdAt: at, updatedAt: Date.now(), metadata: {} };
  }
  if ((cmd === 'dstu_get' || cmd === 'dstu_get_content') && args?.path === '/note_v_research') {
    if (cmd === 'dstu_get_content') return globalThis.__vNoteBody ?? globalThis.__vNoteMd ?? '';
    const at = Date.parse('2026-10-03T20:05:30');
    return { id: 'note_v_research', path: '/note_v_research', name: '大模型辅助数学证明：现状与方法', type: 'note', sourceId: 'note_v_research', resourceId: 'res_note_v_research', createdAt: at, updatedAt: at, metadata: {} };
  }
  // 资源库「全部文件」根目录：与知识库索引里的 9 份资料一致（演示 mock 缺省返回空文件夹）
  if (cmd === 'dstu_list' && args?.path === '/' && !args?.options?.typeFilter && !args?.options?.isFavorite) {
    const now = Date.parse('2026-10-03T20:06:00');
    const N = (id, type, name, at, o = {}) => ({ id, path: '/' + id, name, type, sourceId: id, resourceId: 'res_' + id, createdAt: Date.parse(at), updatedAt: Date.parse(at), metadata: {}, ...o });
    return [
      N('file_v_paper', 'file', 'Process-Supervised Language Models for Formal Theorem Proving.pdf', '2026-10-03T20:06:00', { size: 2488320, metadata: { mimeType: 'application/pdf' } }),
      N('note_v_research', 'note', '大模型辅助数学证明：现状与方法', '2026-10-03T20:05:30'),
      N('tr_v_1', 'translation', '测试效应', '2026-10-03T15:46:00'),
      N('essay_v_new1', 'essay', '雅思大作文：大学教育该不该免费', '2026-10-03T14:12:00'),
      N('exam_v_new_1', 'exam', '高数期中模拟卷', '2026-10-03T09:05:00'),
      N('mm_v_mvt', 'mindmap', '微分中值定理', '2026-10-02T21:40:00'),
      N('note_demo_mvt', 'note', '中值定理证明套路', '2026-10-02T21:30:00'),
      N('tb_v_calc', 'textbook', '高等数学（第七版）上册.pdf', '2026-10-02T20:10:00', { size: 48234496 }),
      N('note_v_err', 'note', '高数错题本（8 月）', '2026-08-28T19:20:00'),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  // 知识库索引（IndexStatusView）：资源级状态，与片中出现过的资料一致；__vPaperIndexing 时论文仍在索引中
  if (cmd === 'vfs_get_all_index_status') {
    const now = Date.parse('2026-10-03T12:05:00Z');
    const R = (id, type, name, chunks, o = {}) => ({ resourceId: 'res_' + id, sourceId: id, resourceType: type, name, hasOcr: false, ocrCount: 0, textIndexState: 'indexed', textIndexedAt: now - 3600e3, textChunkCount: chunks, nativeTextChunkCount: chunks, ocrTextChunkCount: 0, textEmbeddingDim: 1024, textIndexSource: 'native', mmIndexState: 'disabled', mmIndexedPages: 0, embeddingDim: 1024, modality: 'text', updatedAt: now - 3600e3, isStale: false, ...o });
    const paperState = globalThis.__vPaperIndexing ? { textIndexState: 'indexing', textChunkCount: 0, nativeTextChunkCount: 0, textIndexedAt: undefined } : { textIndexedAt: now, updatedAt: now };
    const resources = [
      R('file_v_paper', 'file', 'Process-Supervised Language Models for Formal Theorem Proving.pdf', 38, { hasOcr: true, ocrCount: 14, ...paperState }),
      R('note_v_research', 'note', '大模型辅助数学证明：现状与方法', 6, { textIndexedAt: now - 300e3, updatedAt: now - 300e3 }),
      R('tr_v_1', 'translation', '测试效应', 4),
      R('essay_v_new1', 'essay', '雅思大作文：大学教育该不该免费', 4),
      R('exam_v_new_1', 'exam', '高数期中模拟卷', 18),
      R('note_demo_mvt', 'note', '中值定理证明套路', 5),
      R('tb_v_calc', 'textbook', '高等数学（第七版）上册.pdf', 412, { hasOcr: true, ocrCount: 380 }),
      R('note_v_err', 'note', '高数错题本（8 月）', 9),
      R('mm_v_mvt', 'mindmap', '微分中值定理', 7),
    ];
    const total = resources.length;
    const indexing = globalThis.__vPaperIndexing ? 1 : 0;
    return { totalResources: total, indexedCount: total - indexing, pendingCount: 0, indexingCount: indexing, failedCount: 0, disabledCount: 0, staleCount: 0, mmTotalResources: 0, mmIndexedCount: 0, mmPendingCount: 0, mmIndexingCount: 0, mmFailedCount: 0, mmDisabledCount: 0, resources };
  }
  if (cmd === 'vfs_list_dimensions') return [{ dimension: 1024, modality: 'text', modelConfigId: 'emb_v', modelName: 'bge-m3', recordCount: 503, lanceTableName: 'vfs_text_1024', createdAt: Date.parse('2026-06-01T00:00:00Z'), lastUsedAt: Date.parse('2026-10-03T12:05:00Z') }];
  { const r = __vTrPre(cmd, args); if (r !== __VSKIP) return r; }
  const db = __vExamDb();
  if (cmd.startsWith('essay_grading_')) return __vEssayPre(cmd, args);
  if (cmd === 'get_setting' && String(args?.key ?? '').startsWith('essay_grading.session_mode.essay_v_')) return 'ielts';
  switch (cmd) {
    case 'dstu_list':
      if (args?.options?.typeFilter === 'exam') return [...db.nodes].sort((a, b) => b.updatedAt - a.updatedAt);
      if (args?.options?.typeFilter === 'essay') return [...__vEssayDb().nodes].sort((a, b) => b.updatedAt - a.updatedAt);
      return __VSKIP;
    case 'dstu_create': {
      if (args?.options?.type === 'essay') {
        const edb = __vEssayDb();
        const eid = 'essay_v_new' + (++edb.seq);
        const enode = { id: eid, path: '/' + eid, name: args.options.name || '新作文', type: 'essay', sourceId: eid, createdAt: Date.now(), updatedAt: Date.now(), metadata: { ...(args.options.metadata || {}) } };
        edb.nodes.unshift(enode);
        const at2 = new Date().toISOString();
        edb.sessions[eid] = { id: eid, title: enode.name, essay_type: '', grade_level: '', custom_prompt: null, created_at: at2, updated_at: at2, is_favorite: false, total_rounds: 0 };
        edb.rounds[eid] = [];
        return enode;
      }
      if (args?.options?.type !== 'exam') return __VSKIP;
      const id = 'exam_v_new_' + (++db.seq);
      const node = { id, path: '/' + id, name: args.options.name || '未命名题目集', type: 'exam', sourceId: id, createdAt: Date.now(), updatedAt: Date.now(), metadata: {} };
      db.nodes.unshift(node);
      return node;
    }
    case 'dstu_get': {
      const id = String(args?.path ?? '').replace(/^\//, '');
      return db.nodes.find((n) => n.id === id) ?? __vEssayDb().nodes.find((n) => n.id === id) ?? __VSKIP;
    }
    case 'get_exam_sheet_session_detail': {
      const id = args?.request?.session_id;
      if (id === DEMO_QBANK_ID) return __VSKIP;
      const node = db.nodes.find((n) => n.id === id);
      if (!node) return __VSKIP;
      const at = new Date(node.updatedAt).toISOString();
      return { detail: { summary: { id, exam_name: node.name, mistake_id: id, status: 'completed', created_at: at, updated_at: at, metadata: { page_count: 0, card_count: 0 } }, preview: { session_id: id, exam_name: node.name, pages: [] } } };
    }
    case 'qbank_start_timed_practice': {
      const r = args.request;
      const ids = getDemoQuestions().filter((q) => q.exam_id === r.exam_id).map((q) => q.id).slice(0, r.question_count);
      return { id: 'timed_v_1', exam_id: r.exam_id, duration_minutes: r.duration_minutes, question_count: ids.length, question_ids: ids, started_at: new Date().toISOString(), answered_count: 0, correct_count: 0, is_timeout: false, is_submitted: false, paused_seconds: 0, is_paused: false };
    }
    case 'qbank_get_stats':
    case 'qbank_refresh_stats': {
      if (args?.examId === DEMO_QBANK_ID) return __VSKIP;
      const n = getDemoQuestions().filter((q) => q.exam_id === args?.examId).length;
      return { exam_id: args?.examId, total_count: n, new_count: n, in_progress_count: 0, mastered_count: 0, review_count: 0, total_attempts: 0, total_correct: 0, correct_rate: 0, updated_at: new Date().toISOString() };
    }
    case 'import_question_bank_stream': {
      // 按 Visual-First 管线（question_import_service.rs）的事件顺序回放：渲染 → 逐页 VLM → 跨页合并 → 配图 → 结构化 → 逐题入库
      const r = args.request;
      const sid = r.session_id;
      const seed = globalThis.__vSeed || [];
      const k = Number(globalThis.__vImportSpeed || 1);
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms * k));
      const ev = (p) => emit('question_import_progress', { import_id: r.import_id, session_id: sid, ...p });
      return (async () => {
        await ev({ type: 'Preprocessing', stage: 'rasterizing', message: '正在渲染文档页面...', percent: 2 });
        await sleep(400);
        await ev({ type: 'RenderingPages', current: 0, total: 1 });
        await sleep(600);
        await ev({ type: 'RenderingPages', current: 4, total: 4 });
        await ev({ type: 'SessionCreated', name: r.name, total_chunks: 4 });
        for (let i = 0; i < 4; i++) {
          await sleep(900);
          await ev({ type: 'OcrImageCompleted', image_index: i, total_images: 4 });
        }
        await sleep(300);
        await ev({ type: 'OcrPhaseCompleted', total_images: 4, total_chars: 3260 });
        await ev({ type: 'Preprocessing', stage: 'merging', message: '正在跨页合并题目...', percent: 42 });
        await sleep(400);
        await ev({ type: 'ExtractingFigures', current: 0, total: seed.length });
        await sleep(300);
        await ev({ type: 'ExtractingFigures', current: seed.length, total: seed.length });
        await ev({ type: 'StructuringQuestion', current: 0, total: seed.length });
        await sleep(900);
        globalThis.__vImportInto?.(sid);
        for (let i = 0; i < seed.length; i++) {
          await sleep(120);
          const q = seed[i];
          await ev({ type: 'QuestionParsed', question: { content: q.content, question_type: q.type, answer: q.answer, options: q.options }, question_index: i, total_parsed: i + 1 });
        }
        await ev({ type: 'Completed', name: r.name, total_questions: seed.length, partial: false, failed_count: 0 });
        const at = new Date().toISOString();
        const cards = seed.map((q, i) => ({ card_id: sid + '_c' + (i + 1), question_label: String(i + 1), ocr_text: q.content, question_type: q.type, answer: q.answer, bbox: { x: 0, y: 0, width: 1, height: 1 }, resolved_bbox: { x: 0, y: 0, width: 1, height: 1 }, tags: q.tags }));
        const node = db.nodes.find((n) => n.id === sid);
        return {
          summary: { id: sid, exam_name: node?.name ?? r.name, mistake_id: sid, status: 'completed', created_at: at, updated_at: at, metadata: { page_count: 4, card_count: cards.length } },
          preview: { temp_id: sid, session_id: sid, exam_name: r.name, pages: [0, 1, 2, 3].map((p) => ({ page_index: p, cards: p === 0 ? cards : [], original_image_path: '', ocr_completed: true, parse_completed: true })) },
        };
      })();
    }
    default:
      return __VSKIP;
  }
}
`;

// 08 调研：按 research-mode 技能（builtin/index.ts researchModeSkill）的真实工具顺序回放——
// load_skills → ask_user（输入栏接管）→ todo_init / todo_update → web_search / rag → note_create；
// 续问走 academic-search：load_skills → arxiv_search → paper_save（NDJSON 进度 chunk）。
// 输出结构对齐后端：todo_executor.rs / canvas_executor.rs / academic_search_executor.rs / paper_save_executor.rs
const RESEARCH_FIXTURE = String.raw`
;(() => {
  const T0 = 1790960000000;
  const STEPS = ['明确调研范围与检索关键词', '检索形式化证明方向的最新进展', '检索过程监督与自我验证方法', '检索本地资料中的相关笔记与教材', '交叉核对信息并整理观点', '撰写调研报告并存为笔记'];
  const TITLE = '大模型辅助数学证明调研';
  const snap = (st) => STEPS.map((d, i) => ({ id: 'step_' + (i + 1), description: d, status: st[i] || 'pending', createdAt: T0 }));
  const todoOut = (st, extra) => {
    const steps = snap(st);
    const done = steps.filter((s) => s.status === 'completed').length;
    return { result: { success: true, todoListId: 'todo_v_research', title: TITLE, completedCount: done, totalCount: steps.length, isAllDone: done === steps.length, steps, ...extra }, durationMs: 3 };
  };
  const upd = (n, status, st) => {
    const done = st.filter((s) => s === 'completed').length;
    const all = done === STEPS.length;
    return { type: 'tool_call', status: 'success', toolName: 'builtin-todo_update', dwellMs: 160, toolInput: { stepId: 'step_' + n, status }, toolOutput: todoOut(st, { stepId: 'step_' + n, newStatus: status, progress: done + '/' + STEPS.length, message: all ? '🎉 所有任务已完成！' : '已更新步骤状态，进度: ' + done + '/' + STEPS.length }) };
  };
  const C = 'completed', R = 'running';
  const NOTE_MD = '## 📋 调研概述\n- **调研时间**：2026 年 10 月\n- **调研范围**：大模型在数学证明中的三种用法——形式化证明、过程监督与自我验证、检索增强\n\n## 🔍 主要发现\n1. 形式化证明成为主流路线：模型负责搜索证明路径，Lean 等证明助手逐步验证，结论可机器检查 [搜索-1][搜索-2]\n2. 过程监督比只看最终答案更可靠：对推理链逐步打分，竞赛题准确率与可解释性同时提升 [搜索-3]\n3. 检索增强适合本科分析学：先检索可用的定理与引理，再组织证明 [知识库-1]\n\n## 📊 详细分析\n### 形式化证明\n把定理翻译成 Lean / Isabelle 代码，证明助手负责验证每一步，模型只需提出下一步策略……\n\n### 过程监督与自我验证\n奖励模型对每一步推理打分，配合自我验证在生成后回查……\n\n## 💡 结论与建议\n- 学习中值定理一类证明时，可以先让模型给出证明骨架，再逐步核对每一步的条件\n- 形式化工具适合检查自己的证明是否遗漏条件\n\n## 📚 参考来源\n- Lean Mathlib 文档\n- 2026 年 arXiv 相关论文 3 篇\n- 本地笔记《中值定理证明套路》';
  globalThis.__vNoteMd = NOTE_MD;
  const PAPER = 'Process-Supervised Language Models for Formal Theorem Proving';
  const research = [
    { type: 'thinking', status: 'success', streaming: true, content: '用户要调研大模型怎样辅助数学证明，并整理成笔记。按调研模式，先加载检索、任务清单、笔记和提问这几组工具，再确认调研深度。' },
    { type: 'content', status: 'success', streaming: true, content: '好的，我先加载调研要用的工具，再和你确认这次调研的深度。' },
    { type: 'tool_call', status: 'success', toolName: 'load_skills', dwellMs: 260, toolInput: { skills: ['knowledge-retrieval', 'todo-tools', 'canvas-note', 'ask-user'] }, toolOutput: { result: { status: 'success', skill_ids: ['knowledge-retrieval', 'todo-tools', 'canvas-note', 'ask-user'], loaded_skill_ids: ['knowledge-retrieval', 'todo-tools', 'canvas-note', 'ask-user'] }, durationMs: 5 } },
    { type: 'tool_call', status: 'success', toolName: 'builtin-ask_user', dwellMs: Number(globalThis.__vAskDwell || 4200),
      toolInput: { question: '这次调研希望做到多深？', options: [{ label: '中等深度：结构化报告，覆盖主要方法与代表工作 (Recommended)', reason: '兼顾全面与篇幅，适合整理成一篇学习笔记' }, { label: '快速概览：要点式总结' }, { label: '深度调研：逐项对比，附完整引用来源' }], context: '了解你的偏好后，我会据此决定检索范围和报告结构。' },
      toolOutput: { result: { question: '这次调研希望做到多深？', selected: ['中等深度：结构化报告，覆盖主要方法与代表工作'], selected_indices: [0], source: 'user_click' }, durationMs: 4200 } },
    { type: 'thinking', status: 'success', streaming: true, content: '用户选了中等深度。拆成 6 个任务：先定关键词，再分别检索形式化证明和过程监督，查本地笔记，最后整理成报告。' },
    { type: 'tool_call', status: 'success', toolName: 'builtin-todo_init', dwellMs: 160, toolInput: { title: TITLE, steps: STEPS.map((d) => ({ description: d })) }, toolOutput: todoOut([], { totalSteps: STEPS.length, message: '已创建任务列表「' + TITLE + '」，共 6 个步骤' }) },
    upd(1, R, [R]),
    upd(1, C, [C]),
    upd(2, R, [C, R]),
    { type: 'web_search', status: 'success', dwellMs: 900, toolName: 'web_search', toolInput: { query: 'LLM formal theorem proving Lean 2026' }, toolOutput: { sources: [
      { title: 'Lean 4 与 Mathlib：形式化数学的现状', url: 'https://leanprover-community.github.io/', snippet: '证明助手逐步检查每一步推理，模型负责提出证明策略。' },
      { title: 'Formal theorem proving with LLMs — survey 2026', url: 'https://arxiv.org/abs/2603.04117', snippet: '综述大模型在 Lean / Isabelle 上的证明搜索方法。' },
    ] } },
    { type: 'web_search', status: 'success', dwellMs: 760, toolName: 'web_search', toolInput: { query: 'process supervision step-level reward math reasoning' }, toolOutput: { sources: [
      { title: 'Process supervision for math reasoning', url: 'https://arxiv.org/abs/2605.11862', snippet: '对推理链逐步打分，提高竞赛题准确率。' },
    ] } },
    upd(2, C, [C, C]),
    upd(3, R, [C, C, R]),
    { type: 'web_search', status: 'success', dwellMs: 820, toolName: 'web_search', toolInput: { query: 'self-verification chain-of-thought competition mathematics' }, toolOutput: { sources: [
      { title: 'Self-verifying chain-of-thought', url: 'https://arxiv.org/abs/2607.02290', snippet: '生成后回查每一步，减少看似合理的错误推理。' },
    ] } },
    upd(3, C, [C, C, C]),
    upd(4, R, [C, C, C, R]),
    { type: 'rag', status: 'success', dwellMs: 600, toolName: 'builtin-unified_search', toolInput: { query: '中值定理 证明 思路' }, toolOutput: { sources: [
      { title: '中值定理证明套路.md', snippet: '构造辅助函数，再用罗尔定理。', metadata: { note_id: 'note_demo_mvt' } },
      { title: '高等数学（第七版）上册.pdf', snippet: '第三章 微分中值定理与导数的应用', metadata: { page: 128 } },
    ] } },
    upd(4, C, [C, C, C, C]),
    upd(5, R, [C, C, C, C, R]),
    { type: 'thinking', status: 'success', streaming: true, content: '三条路线的证据都齐了，按调研概述、主要发现、详细分析、结论与建议、参考来源组织报告。' },
    upd(5, C, [C, C, C, C, C]),
    upd(6, R, [C, C, C, C, C, R]),
    { type: 'tool_call', status: 'success', toolName: 'builtin-note_create', dwellMs: 380, toolInput: { title: '大模型辅助数学证明：现状与方法', content: NOTE_MD }, toolOutput: { result: { noteId: 'note_v_research', title: '大模型辅助数学证明：现状与方法', wordCount: NOTE_MD.length, folderId: null, success: true }, durationMs: 9 } },
    upd(6, C, [C, C, C, C, C, C]),
    { type: 'content', status: 'success', streaming: true, content: '调研完成，报告已保存为笔记「大模型辅助数学证明：现状与方法」。\n\n**主要发现**\n1. **形式化证明**：模型提出证明策略，Lean 等证明助手逐步验证，结论可以机器检查 [搜索-1] [搜索-2]\n2. **过程监督**：对推理链逐步打分，比只看最终答案更可靠 [搜索-3]\n3. **检索增强**：先找到可用的定理和引理再组织证明，和你笔记里的中值定理套路一致 [知识库-1]\n\n点上方「创建笔记」右侧的按钮可以直接打开报告。' },
  ];
  const progress = (s, pct, dl) => JSON.stringify({ papers: [{ i: 0, t: PAPER, s, pct, ...(dl != null ? { dl, total: 2488320 } : {}), src: 'arXiv' }] }) + '\n';
  const paper = [
    { type: 'thinking', status: 'success', streaming: true, content: '要找 2026 年的论文并下载一篇，先加载学术搜索工具，在 arXiv 上按相关性检索。' },
    { type: 'tool_call', status: 'success', toolName: 'load_skills', dwellMs: 240, toolInput: { skills: ['academic-search'] }, toolOutput: { result: { status: 'success', skill_ids: ['academic-search'], loaded_skill_ids: ['knowledge-retrieval', 'todo-tools', 'canvas-note', 'ask-user', 'academic-search'] }, durationMs: 4 } },
    { type: 'tool_call', status: 'success', toolName: 'builtin-arxiv_search', dwellMs: 1100, toolInput: { query: 'large language model theorem proving mathematical reasoning', date_from: '2026-01-01', max_results: 5, sort_by: 'relevance' }, toolOutput: { result: { source: 'arxiv', total_results: 3, papers: [
      { id: '2603.04117', title: PAPER, authors: ['L. Chen', 'A. Gupta', 'M. Rossi'], abstract: 'We train step-level reward models over Lean proof states ...', categories: ['cs.LG', 'cs.LO'], published: '2026-03-08', pdfUrl: 'https://arxiv.org/pdf/2603.04117', arxivUrl: 'https://arxiv.org/abs/2603.04117' },
      { id: '2605.11862', title: 'Self-Verifying Chain-of-Thought for Competition Mathematics', authors: ['R. Okafor', 'Y. Sato'], abstract: '...', categories: ['cs.CL'], published: '2026-05-21', pdfUrl: 'https://arxiv.org/pdf/2605.11862', arxivUrl: 'https://arxiv.org/abs/2605.11862' },
      { id: '2607.02290', title: 'Lean-Augmented Retrieval for Undergraduate Analysis Proofs', authors: ['M. Li', 'K. Novak'], abstract: '...', categories: ['cs.AI', 'math.HO'], published: '2026-07-04', pdfUrl: 'https://arxiv.org/pdf/2607.02290', arxivUrl: 'https://arxiv.org/abs/2607.02290' },
    ] }, durationMs: 2025 } },
    { type: 'content', status: 'success', streaming: true, content: '在 arXiv 上找到 3 篇 2026 年的相关论文：\n\n1. **' + PAPER + '**（2026-03）\n   - L. Chen, A. Gupta, M. Rossi · cs.LG, cs.LO\n2. **Self-Verifying Chain-of-Thought for Competition Mathematics**（2026-05）\n   - R. Okafor, Y. Sato · cs.CL\n3. **Lean-Augmented Retrieval for Undergraduate Analysis Proofs**（2026-07）\n   - M. Li, K. Novak · cs.AI, math.HO\n\n第 1 篇和你的调研主题最相关，我把它下载到资料库。' },
    { type: 'tool_call', status: 'success', toolName: 'builtin-paper_save', dwellMs: 260, toolInput: { papers: [{ title: PAPER, arxiv_id: '2603.04117' }] },
      chunks: [progress('resolving', 0), progress('downloading', 18, 447898), progress('downloading', 46, 1144627), progress('downloading', 77, 1916006), progress('downloading', 100, 2488320), progress('deduplicating', 100), progress('storing', 100), progress('processing', 100), progress('indexing', 100), progress('done', 100)],
      toolOutput: { result: { total: 1, success_count: 1, failed_count: 0, results: [{ success: true, title: PAPER, file_id: 'file_v_paper' }] }, durationMs: 4800 } },
    { type: 'content', status: 'success', streaming: true, content: '已下载并保存到学习资源：《' + PAPER + '》。文本提取和索引已经完成，之后在对话里就能检索到它。' },
  ];
  DEMO_SESSIONS.unshift(makeFixture({
    id: 'demo-v-research', title: '大模型辅助数学证明', minutesAgo: 1,
    autoPrompt: globalThis.__vResearchPrompt || '/research-mode 调研：大模型现在怎样辅助数学证明？整理成一篇笔记',
    reply: research,
    continuations: [{ id: 'paper', label: '找论文', prompt: '再找几篇 2026 年 LLM 数学证明的论文，下载最相关的一篇', reply: paper }],
  }));
})();
`;

// 09 懂你（YOU=1）：记忆检索的回答、MCP 外部工具调用、三个模型并排（多变体静态历史，后端 multi_variant.rs 用模型名作 variant.modelId）
const YOU_FIXTURE = String.raw`
;(() => {
  const T = Date.parse('2026-10-03T21:12:00');
  const memReply = [
    { type: 'memory', status: 'success', dwellMs: 700, toolOutput: { sources: [
      { title: '几何直观优先', snippet: '讲概念时先看几何直观，再看严格证明。', metadata: { note_id: 'mem_v_pref' } },
      { title: '中值定理易错点', snippet: 'ξ 的取值范围常写成闭区间 [a, b]，应为开区间 (a, b)。', metadata: { note_id: 'mem_v_mvt' } },
    ] } },
    { type: 'content', status: 'success', streaming: true, content: '按你的习惯，先看几何直观 [记忆-1]：连接 A、B 两点得到一条弦，曲线上一定有一点的切线和这条弦平行——那一点就是 ξ。\n\n再看严格表述：f 在 [a, b] 上连续、在 (a, b) 内可导，则存在 ξ ∈ (a, b)，使 f′(ξ) = (f(b) − f(a)) / (b − a)。注意 ξ 落在开区间里，这正是你之前容易写错的地方 [记忆-2]。' },
  ];
  DEMO_SESSIONS.unshift(makeFixture({ id: 'demo-v-mem', title: '拉格朗日中值定理', minutesAgo: 1, autoPrompt: globalThis.__vMemPrompt || '拉格朗日中值定理到底在说什么？', reply: memReply }));
  const mcpReply = [
    // 后端对内置与外部 MCP 工具一律发 tool_call 事件（前端没有 mcp_tool 事件处理器，块类型由 toolCall 处理器建成 mcp_tool）；
    // 外部工具内部名 = mcp_ + 工具名（canonical_tools prepare_external_tool），参数注入 _serverId
    { type: 'tool_call', status: 'success', toolName: 'mcp_zotero_search_items', dwellMs: 900, toolInput: { _serverId: 'zotero', query: '中值定理' }, toolOutput: { content: [{ type: 'text', text: '找到 2 条：中值定理证明套路（笔记）；Rolle and Lagrange revisited（论文）' }] } },
    { type: 'content', status: 'success', streaming: true, content: '在你的 Zotero 文献库里找到 2 条和中值定理相关的条目：笔记《中值定理证明套路》和论文 *Rolle and Lagrange revisited*。' },
  ];
  DEMO_SESSIONS.unshift(makeFixture({ id: 'demo-v-mcp', title: 'Zotero 文献', minutesAgo: 1, autoPrompt: '在我的 Zotero 文献库里找找讲中值定理的资料', reply: mcpReply }));
  const Q = '用一句话讲清拉格朗日中值定理的几何意义';
  const A = [
    ['deepseek-v4', '可以把它看成罗尔定理的「倾斜版」：把弦拉平就是罗尔定理。光滑曲线上总有一点的切线平行于连接两端点的弦，而且这一点只保证存在、落在开区间 (a, b) 内。'],
    ['glm-5', '几何上看，拉格朗日中值定理说的是：光滑曲线上，总有一点的切线平行于连接两端点的弦。它把「平均变化率」和某一点的「瞬时变化率」联系了起来。'],
    ['kimi-k3', '把 (f(b) − f(a)) / (b − a) 看成弦的斜率，定理断言存在 ξ ∈ (a, b)，使 f′(ξ) 恰好等于这个斜率——平均速度总会在某一时刻被瞬时速度精确达到。'],
  ];
  const sid = 'demo-v-models';
  const fx = makeFixture({ id: sid, title: '中值定理的几何意义', minutesAgo: 0, autoPrompt: Q, reply: [] });
  fx.messages = [
    { id: 'msg_v_mu', sessionId: sid, role: 'user', blockIds: ['blk_v_mu'], timestamp: T },
    { id: 'msg_v_ma', sessionId: sid, role: 'assistant', blockIds: A.map((_, i) => 'blk_v_m' + i), timestamp: T + 1000, activeVariantId: 'var_v_0',
      variants: A.map(([m], i) => ({ id: 'var_v_' + i, modelId: m, blockIds: ['blk_v_m' + i], status: 'success', createdAt: T + 1000 + i })) },
  ];
  fx.blocks = [
    { id: 'blk_v_mu', messageId: 'msg_v_mu', type: 'content', status: 'success', content: Q },
    ...A.map(([, text], i) => ({ id: 'blk_v_m' + i, messageId: 'msg_v_ma', variantId: 'var_v_' + i, type: 'content', status: 'success', content: text, startedAt: T + 1000, endedAt: T + 3000 + i * 300 })),
  ];
  fx.autoPrompt = undefined;
  DEMO_SESSIONS.unshift(fx);
})();
`;

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
});
// VW / VH：改视口（第一幕经典窗口是 1760 宽，开着 PDF 面板时聊天栏才是片中的 720）
const page = await browser.newPage({ viewport: { width: Number(process.env.VW ?? 1920), height: Number(process.env.VH ?? 1080) }, deviceScaleFactor: DPR, colorScheme: THEME === 'dark' ? 'dark' : 'light' });
page.on('pageerror', (e) => console.log('[pageerror]', process.env.STACK ? String(e.stack).slice(0, 900) : e.message.slice(0, 200)));
if (process.env.STACK) page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 900)); });
if (process.env.LOG_IPC) {
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[ipc]')) console.log(t); });
  await page.addInitScript(() => { globalThis.__vLogIpc = true; });
}
await page.clock.install({ time: new Date(CLOCK) });
await page.clock.resume();
await page.route('**/src/demo/main.tsx*', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  // CLASSIC=1：保留演示壳默认的经典布局（第一幕取证）
  // 4d29f3aeb 起写成 `desktop ? 'true' : 'false'`（?desktop=1 学习桌面），两种写法都改成常开
  if (!process.env.CLASSIC) {
    body = body
      .replace(/localStorage\.setItem\(WORKBENCH_KEY,\s*["']false["']\)/, 'localStorage.setItem(WORKBENCH_KEY, "true")')
      .replace(/localStorage\.setItem\(WORKBENCH_KEY,\s*desktop\s*\?\s*["']true["']\s*:\s*["']false["']\)/, 'localStorage.setItem(WORKBENCH_KEY, "true")');
  }
  // 不自动播放剧本、不自动跳到剧本会话（否则一开机就弹出对话窗口）
  if (!process.env.AUTOPLAY) {
    body = body
      .replace(/installDemoAutoPlay\(\{\s*waitForActivation:[^}]*\}\)/, 'installDemoAutoPlay({ waitForActivation: true })')
      .replace(/\{\s*waitForActivation:\s*window\.parent !== window\s*\}/, '{ waitForActivation: true }');
    if (!process.env.NAV) {
      body = body
        .replace(/let navigated = false;/, 'let navigated = true;')
        .replace(/if \(initialScene\) requestChatSessionNavigation\(initialScene\);/, 'let navigated = true; void navigated;');
    }
  }
  // 取证脚本手动触发自动播放（activate / continueScene），控制截图时机
  body = body.replace(/(const autoPlay = installDemoAutoPlay\([^;]*\);)/, '$1 window.__vAutoPlay = autoPlay;');
  console.log('[patch main]', /WORKBENCH_KEY, "true"/.test(body) || !!process.env.CLASSIC, body.includes('waitForActivation: true'), body.includes('let navigated = true;') || !!process.env.NAV, body.includes('window.__vAutoPlay'));
  await route.fulfill({ response: res, body });
});
await page.route('**/src/demo/mockIpc.ts*', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  if (!process.env.CLASSIC) {
    body = body
      .replace(/(["']desktop\.workbenchMode["']\s*:\s*)["']false["']/, '$1"true"')
      .replace(/(["']desktop\.workbenchMode["']\s*:\s*)desktop\s*\?\s*["']true["']\s*:\s*["']false["']/, '$1"true"');
  }
  body = body.replace("case 'todo_list_today':", "case '__v_todo_list_today':").replace("case 'todo_list_reminders':", "case '__v_todo_list_reminders':");
  body = body.replace(/default:\s*\n(\s*)if \(cmd\.startsWith\('qbank_'\)\)/, "default:\n$1if (cmd.startsWith('todo_') || cmd.startsWith('pomodoro_') || cmd === 'fsrs_get_stats') return __vMock(cmd, args);\n$1if (cmd.startsWith('qbank_'))");
  body = body.replace(/(const args = [^;]+;\s*)switch\s*\(cmd\)\s*\{/, '$1{ const __r = __vPre(cmd, args); if (__r !== __VSKIP) return __r; }\nswitch (cmd) {');
  body += `\n${MOCK}\n${PRE}\n`;
  console.log('[patch mockIpc]', body.includes('__vMock(cmd, args)'), body.includes('__vPre(cmd, args); if'));
  await route.fulfill({ response: res, body });
});
// REAL_CSS=1：让 demo.css 的隐藏规则失效（演示壳藏掉的 + 菜单 / 语音 / 课题 / 新建对话 / 消息操作在生产里都可见）
if (process.env.REAL_CSS) {
  await page.route('**/src/demo/demo.css*', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replaceAll('display: none !important', '--v-demo-hidden: 1');
    console.log('[patch demo.css]', !body.includes('display: none !important'));
    await route.fulfill({ response: res, body });
  });
}
await page.route('**/src/demo/questionBank.ts*', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  body = body.replaceAll('数据并行训练', '高数期中模拟卷');
  if (!process.env.NO_SEED) body += `\n${QB_SEED}\n`;
  console.log('[patch questionBank]', body.includes("'q_v_'"));
  await route.fulfill({ response: res, body });
});
if (process.env.RESEARCH || process.env.YOU) {
  await page.route('**/src/demo/fixtures.ts*', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    if (process.env.RESEARCH) body += `\n${RESEARCH_FIXTURE}\n`;
    if (process.env.YOU) body += `\n${YOU_FIXTURE}\n`;
    console.log('[patch fixtures]', body.includes('demo-v-research'), body.includes('demo-v-models'));
    await route.fulfill({ response: res, body });
  });
}
if (process.env.YOU) {
  await page.addInitScript(() => { globalThis.__vYou = true; });
  if (process.env.MEM_PROMPT) await page.addInitScript((q) => { globalThis.__vMemPrompt = q; }, process.env.MEM_PROMPT);
  // MCP：前端 SDK 的在线工具与连接状态（DialogControlContext 读 McpService.listTools / status）
  await page.route('**/src/mcp/mcpService.ts*', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body += `
;(() => {
  const cfg = () => globalThis.__vMcpCfg || [];
  McpService.listTools = async () => cfg().flatMap(([, , ns, tools]) => tools.map((t) => ({ name: (ns ? ns + ':' : '') + t, description: t })));
  McpService.status = async () => ({ available: true, connected: true, toolsCount: cfg().reduce((n, c) => n + c[3].length, 0), servers: cfg().map(([id, , ns]) => ({ id, namespace: ns, connected: true })) });
})();
`;
    console.log('[patch mcpService]', body.includes('McpService.listTools = async'));
    await route.fulfill({ response: res, body });
  });
}
if (process.env.RESEARCH) {
  if (process.env.ASK_DWELL) await page.addInitScript((k) => { globalThis.__vAskDwell = k; }, Number(process.env.ASK_DWELL));
  if (process.env.RQ) await page.addInitScript((q) => { globalThis.__vResearchPrompt = q; }, process.env.RQ);
}
if (process.env.NO_PAPER) await page.addInitScript(() => { globalThis.__vNoPaper = true; });
// FC=1：片中那批卡（顺序 = 卡片块顺序 = batch 复习顺序），id 用已落库形态（chat-batch- 前缀会被拒）
const FC_CARDS = [
  ['拉格朗日中值定理的两个条件？', 'f(x) 在 [a, b] 上连续，在 (a, b) 内可导'],
  ['证明中如何构造辅助函数 φ(x)？', 'φ(x) = f(x) − 弦 AB 的直线方程'],
  ['ξ 取在闭区间还是开区间？', '开区间 (a, b)，不含端点'],
  ['罗尔定理的结论是什么？', '存在 ξ ∈ (a, b)，使 f′(ξ) = 0'],
  ['拉格朗日中值定理的几何意义？', '曲线上存在一点，切线平行于弦 AB'],
  ['柯西中值定理与它是什么关系？', '取 g(x) = x 即退化为拉格朗日中值定理'],
].map(([front, back], i) => ({ id: `card_v_${String(i + 1).padStart(2, '0')}`, front, back }));
if (process.env.FC) await page.addInitScript((cards) => { globalThis.__vFcCards = cards; }, FC_CARDS);
if (process.env.TR_SPEED) await page.addInitScript((k) => { globalThis.__vTrSpeed = k; }, Number(process.env.TR_SPEED));
const qs = [THEME === 'dark' ? 'theme=dark' : '', process.env.SCENE ? `scene=${process.env.SCENE}` : ''].filter(Boolean).join('&');
await page.goto(`http://localhost:1422/demo.html${qs ? `?${qs}` : ''}`, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(5000);

const shot = async (name, clip) => {
  await page.screenshot({ path: `${dir}/${name}.png`, ...(clip ? { clip } : {}) });
  console.log(`${dir}/${name}.png`);
};
const tryDo = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log('[step failed]', label, String(e).slice(0, 200));
  }
};
// 关掉首次使用的引导卡（老用户桌面不会出现）
await tryDo('dismiss tour', async () => {
  const b = page.getByText('不再显示', { exact: true });
  if (await b.count()) await b.first().click({ timeout: 3000 });
});
await page.mouse.move(960, 600);
await page.waitForTimeout(800);

// Dock 项里不一定有 <button>（现版整项可点），点项本身
const dock = (id) => page.locator(`[data-testid="wb-dock-item-${id}"]`).first();
const shortcut = (name) => page.locator(`.wb-desk-icon[aria-label="${name}"]`).first();

if (scenario === 'probe') {
  // 关键元素的真实几何（CSS px），给片中转写用
  const rects = await page.evaluate(() => {
    const out = [];
    const add = (label, el) => {
      if (!el) return out.push(`${label}: (none)`);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push(`${label}: x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)} font=${cs.fontSize}/${cs.fontWeight} color=${cs.color} bg=${cs.backgroundColor} radius=${cs.borderRadius} transform=${cs.transform}`);
    };
    add('dock', document.querySelector('[data-testid="wb-dock"]'));
    document.querySelectorAll('[data-testid^="wb-dock-item-"]').forEach((w) => {
      const id = w.getAttribute('data-testid');
      add(id, w);
      add(`${id} icon`, w.querySelector('.wb-dock-item-icon'));
      add(`${id} icon>first`, w.querySelector('.wb-dock-item-icon > *'));
    });
    add('agent entry', document.querySelector('[data-testid="wb-dock"] > :last-child'));
    document.querySelectorAll('[data-testid="wb-dock-separator"], [data-testid="wb-dock-apps-separator"]').forEach((s, i) => add(`sep${i}`, s));
    add('menubar', document.querySelector('[data-testid="wb-menubar"]'));
    document.querySelectorAll('[data-testid="wb-menubar"] .wb-menubar-item').forEach((m, i) => add(`mb${i} ${m.getAttribute('data-testid') ?? ''} "${m.textContent?.trim()}"`, m));
    add('brand mark', document.querySelector('.wb-menubar-brand-mark'));
    document.querySelectorAll('.wb-desk-icon').forEach((d) => {
      add(`desk ${d.getAttribute('aria-label')}`, d);
      add(`desk ${d.getAttribute('aria-label')} art`, d.querySelector('.wb-desk-icon__art > *'));
      add(`desk ${d.getAttribute('aria-label')} label`, d.querySelector('.wb-desk-icon__label'));
    });
    add('agenda', document.querySelector('[data-testid="wb-agenda-widget"]'));
    add('briefing', document.querySelector('[data-testid="wb-ai-briefing-widget"]'));
    document.querySelectorAll('[data-testid="wb-ai-briefing-widget"] *').forEach((el, i) => {
      if (i < 60 && el.children.length === 0 && el.textContent?.trim()) add(`brief leaf "${el.textContent.trim().slice(0, 20)}"`, el);
    });
    document.querySelectorAll('[data-testid="wb-agenda-widget"] *').forEach((el, i) => {
      if (el.children.length === 0 && el.textContent?.trim() && i < 400 && !/^\d+$/.test(el.textContent.trim())) add(`agenda leaf "${el.textContent.trim().slice(0, 20)}"`, el);
    });
    return out.join('\n');
  });
  console.log(rects);
} else if (scenario === 'probe-todo') {
  await tryDo('open todo', () => dock('todo').click({ timeout: 5000 }));
  await page.waitForTimeout(2500);
  const win = page.locator('[data-wb-window-id]').first();
  await tryDo('today view', () => win.getByText('今日', { exact: true }).first().click({ timeout: 5000 }));
  await page.waitForTimeout(1500);
  const row = win.locator('.group', { hasText: '完成高数期中模拟卷' }).last();
  await tryDo('hover row', () => row.hover({ timeout: 5000 }));
  await page.waitForTimeout(600);
  console.log(await page.evaluate(() => {
    const out = [];
    const root = document.querySelector('[data-wb-window-id]');
    const r0 = root.getBoundingClientRect();
    out.push(`window: x=${r0.x} y=${r0.y} w=${r0.width} h=${r0.height}`);
    root.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const cs = getComputedStyle(el);
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
      const isIcon = el.tagName.toLowerCase() === 'svg';
      const hasBox = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px' || cs.boxShadow !== 'none';
      if (!own && !isIcon && !hasBox) return;
      if (isIcon && el.closest('svg') !== el) return;
      out.push(`${el.tagName.toLowerCase()}${own ? ` "${own.slice(0, 24)}"` : ''} x=${(r.x - r0.x).toFixed(1)} y=${(r.y - r0.y).toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)} f=${cs.fontSize}/${cs.fontWeight} c=${cs.color} bg=${cs.backgroundColor} bd=${cs.borderTopWidth} ${cs.borderTopColor} rad=${cs.borderRadius}${cs.boxShadow !== 'none' ? ' sh' : ''}`);
    });
    return out.join('\n');
  }));
} else if (scenario === 'classic') {
  // CLASSIC=1 [NAV=1 SCENE=demo-xxx] PFX=… N1=… STEP_MS=… PROBE_AT=… PRE_ACT=… ACTIVATE=1：经典壳整页截图 + 整页 DOM 探针
  const PFX = process.env.PFX ?? 'cl';
  const probeAt = new Set((process.env.PROBE_AT ?? '').split(',').filter(Boolean));
  const fs = await import('node:fs');
  const pageProbe = async (label) => {
    const txt = await page.evaluate(() => {
      const out = ['page 1920x1080'];
      document.body.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > 1080 || r.right < 0 || r.left > 1920) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
        const isIcon = el.tagName.toLowerCase() === 'svg';
        const hasBox = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px' || cs.borderLeftWidth !== '0px' || cs.boxShadow !== 'none';
        if (!own && !isIcon && !hasBox) return;
        if (isIcon && el.closest('svg') !== el) return;
        out.push(`${el.tagName.toLowerCase()}${own ? ` "${own.slice(0, 40)}"` : ''} x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)} f=${cs.fontSize}/${cs.fontWeight}/${cs.lineHeight} c=${cs.color} bg=${cs.backgroundColor} bd=${cs.borderTopWidth}/${cs.borderLeftWidth} ${cs.borderTopColor} rad=${cs.borderRadius}`);
      });
      return out.join('\n');
    });
    fs.writeFileSync(`${dir}/probe-${label}.txt`, txt);
    console.log('[probe]', label, txt.split('\n').length);
  };
  const pAct = async (spec) => {
    for (const a of (spec ?? '').split('|').filter(Boolean)) {
      const [kind, ...rest] = a.split(':');
      const arg = rest.join(':');
      if (kind === 'text') await tryDo(a, () => page.getByText(arg, { exact: true }).last().click({ timeout: 4000 }));
      if (kind === 'aria') await tryDo(a, () => page.locator(`[aria-label="${arg}"]`).last().click({ timeout: 4000 }));
      if (kind === 'css') await tryDo(a, () => page.locator(arg).last().click({ timeout: 4000 }));
      if (kind === 'hover') await tryDo(a, () => page.getByText(arg, { exact: false }).last().hover({ timeout: 4000 }));
      if (kind === 'type') await page.keyboard.type(arg, { delay: 30 });
      if (kind === 'press') await page.keyboard.press(arg);
      if (kind === 'wait') await page.waitForTimeout(Number(arg));
      if (kind === 'shot') await shot(arg);
      if (kind === 'probe') await pageProbe(arg);
      // drag:x1,y1,x2,y2 —— 鼠标拖选（PDF 文字层划选）
      if (kind === 'drag') {
        const [x1, y1, x2, y2] = arg.split(',').map(Number);
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        await page.mouse.move(x2, y2, { steps: 12 });
        await page.mouse.up();
      }
      if (kind === 'click') {
        const [x, y] = arg.split(',').map(Number);
        await page.mouse.click(x, y);
      }
      // file:a.jpg,b.jpg —— 往页面上第一个文件框塞附件（out/cap 下的相对路径）
      if (kind === 'file') await tryDo(a, () => page.locator('input[type=file]').first().setInputFiles(arg.split(',').map((f) => path.resolve(dir, f)), { timeout: 5000 }));
      if (kind === 'eval') console.log('[eval]', await page.evaluate(arg));
    }
  };
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 1500));
  await shot(`${PFX}-00`);
  if (probeAt.has('0')) await pageProbe(`${PFX}-0`);
  await pAct(process.env.PRE_ACT);
  if (process.env.ACTIVATE) await page.evaluate(() => window.__vAutoPlay?.activate());
  for (let i = 1; i <= Number(process.env.N1 ?? 0); i++) {
    await page.waitForTimeout(Number(process.env.STEP_MS ?? 800));
    await shot(`${PFX}-${String(i).padStart(2, '0')}`);
    if (probeAt.has(String(i))) await pageProbe(`${PFX}-${i}`);
  }
  await pAct(process.env.POST_ACT);
} else if (scenario === 'desk') {
  await shot('d2-desk');
  await shot('d2-menubar', { x: 0, y: 0, width: 1920, height: 44 });
  await shot('d2-widgets', { x: 1540, y: 40, width: 380, height: 640 });
  await shot('d2-icons', { x: 0, y: 40, width: 260, height: 600 });
  await shot('d2-dock', { x: 700, y: 990, width: 520, height: 90 });
} else if (scenario === 'todo') {
  await tryDo('open todo', () => dock('todo').click({ timeout: 5000 }));
  await page.waitForTimeout(2500);
  await shot('d2-todo');
  const win = page.locator('[data-wb-window-id]').first();
  await tryDo('today view', () => win.getByText('今日', { exact: true }).first().click({ timeout: 5000 }));
  await page.waitForTimeout(1500);
  await shot('d2-todo-today');
  const row = win.locator('.group', { hasText: '完成高数期中模拟卷' }).last();
  await tryDo('hover row', () => row.hover({ timeout: 5000 }));
  await page.waitForTimeout(600);
  await shot('d2-todo-hover');
  await tryDo('start focus', () => row.getByRole('button', { name: '开始专注' }).first().click({ timeout: 5000 }));
  await page.waitForTimeout(2500);
  console.log(await page.evaluate(() => [...document.querySelectorAll('[data-wb-window-id]')].map((el) => {
    const r = el.getBoundingClientRect();
    return `${el.getAttribute('data-wb-window-id')} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} vis=${getComputedStyle(el).visibility} op=${getComputedStyle(el).opacity} z=${getComputedStyle(el).zIndex}`;
  }).join('\n')));
  await shot('d2-pomo');
  await shot('d2-pomo-menubar', { x: 0, y: 0, width: 1920, height: 44 });
  await shot('d2-pomo-dock', { x: 600, y: 990, width: 720, height: 90 });
  // 最小化待办窗口，看后面那个番茄钟窗口
  await tryDo('minimize todo', () => win.getByRole('button', { name: '最小化' }).first().click({ timeout: 5000 }));
  await page.waitForTimeout(1500);
  await shot('d2-pomo-win');
} else if (scenario === 'apps') {
  for (const name of ['题目集', '作文批改', '翻译']) {
    await tryDo(`open ${name}`, () => shortcut(name).dblclick({ timeout: 5000 }));
    await page.waitForTimeout(3000);
    await shot(`d2-app-${name}`);
  }
  await shot('d2-apps-dock', { x: 560, y: 990, width: 800, height: 90 });
} else if (scenario === 'appx') {
  // 经「全部应用」面板打开（桌面快捷方式被空桌面引导卡挡住，见优化建议 1）
  const name = process.env.APP ?? '题目集';
  if (process.env.FC_START) {
    // 模拟对话里点「复习这批」：与 ankiCardsBlock.handleReviewBatch 同一次 activate（未开窗走 fallbackLaunch）；等工作台外壳挂载（enabled）后再发
    await tryDo('wait dock', () => page.locator('[data-testid="wb-dock-apps-button"]').waitFor({ timeout: 15000 }));
    await page.waitForTimeout(1500);
    console.log('[fc start]', await page.evaluate(async (cards) => {
      try {
        // 必须 import 应用实际加载的那个 URL（带 ?v= / ?t=），否则拿到的是另一份模块实例（enabled=false）
        const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/features/workbench/core/workbenchBus.ts')) ?? '/src/features/workbench/core/workbenchBus.ts';
        const { workbenchBus } = await import(url);
        // 演示壳把 AgentBridge 换成了空桩，总线没人打开；生产里工作台挂载时由 AgentBridge setEnabled(true)
        workbenchBus.setEnabled(true);
        const payload = { screen: 'session', mode: 'batch', cardIds: cards.map((c) => c.id), cards: cards.map((c) => ({ id: c.id, ankiCardId: c.id, front: c.front, back: c.back })) };
        const r = await workbenchBus.activateDetailed({ typeId: 'flashcards', instanceKey: '', action: 'startReview', payload, fallbackLaunch: { typeId: 'flashcards', reason: 'api', payload } });
        return JSON.stringify(r ?? null).slice(0, 200);
      } catch (e) {
        return 'ERR ' + String(e?.stack ?? e).slice(0, 500);
      }
    }, FC_CARDS));
  } else if (process.env.DOCK) {
    // DOCK=<应用 id>：直接点 Dock 图标（files = 资源库）
    await tryDo(`dock ${process.env.DOCK}`, () => dock(process.env.DOCK).click({ timeout: 5000 }));
  } else {
    await tryDo('open apps panel', () => page.locator('[data-testid="wb-dock-apps-button"]').click({ timeout: 5000 }));
    await page.waitForTimeout(1200);
    await tryDo(`open ${name}`, () => page.locator('[role="dialog"], .wb-apps-panel').getByText(name, { exact: true }).first().click({ timeout: 5000 }));
  }
  await page.waitForTimeout(3500);
  await shot(`d3-${name}-0`);
  const steps = (process.env.STEPS ?? '').split('|').filter(Boolean);
  for (let i = 0; i < steps.length; i++) {
    const [kind, arg] = steps[i].split(':');
    const win = page.locator('[data-wb-window-id]').last();
    if (kind === 'text') await tryDo(`click ${arg}`, () => win.getByText(arg, { exact: false }).first().click({ timeout: 5000 }));
    if (kind === 'role') await tryDo(`click ${arg}`, () => win.getByRole('button', { name: arg }).first().click({ timeout: 5000 }));
    if (kind === 'wait') await page.waitForTimeout(Number(arg));
    if (kind === 'probe') {
      const txt = await win.evaluate((root) => {
        const out = [];
        const r0 = root.getBoundingClientRect();
        out.push(`window: x=${r0.x} y=${r0.y} w=${r0.width} h=${r0.height}`);
        root.querySelectorAll('*').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || r.bottom < r0.y || r.top > r0.bottom) return;
          const cs = getComputedStyle(el);
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
          const isIcon = el.tagName.toLowerCase() === 'svg';
          const hasBox = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px' || cs.borderLeftWidth !== '0px' || cs.boxShadow !== 'none';
          if (!own && !isIcon && !hasBox) return;
          if (isIcon && el.closest('svg') !== el) return;
          out.push(`${el.tagName.toLowerCase()}${own ? ` "${own.slice(0, 40)}"` : ''} x=${(r.x - r0.x).toFixed(1)} y=${(r.y - r0.y).toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)} f=${cs.fontSize}/${cs.fontWeight}/${cs.lineHeight} c=${cs.color} bg=${cs.backgroundColor} bd=${cs.borderTopWidth}/${cs.borderLeftWidth} ${cs.borderTopColor} rad=${cs.borderRadius}${cs.boxShadow !== 'none' ? ' sh=' + cs.boxShadow.slice(0, 60) : ''}`);
        });
        return out.join('\n');
      });
      (await import('node:fs')).writeFileSync(`${dir}/probe-${arg}.txt`, txt);
      console.log('[probe]', arg, txt.split('\n')[0]);
      continue;
    }
    await page.waitForTimeout(1500);
    await shot(`d3-${name}-${i + 1}`);
  }
  if (process.env.DUMPWIN) console.log(await page.evaluate(() => [...document.querySelectorAll('[data-wb-window-id]')].map((w) => w.innerText.slice(0, 2500)).join('\n=====\n')));
} else if (scenario === 'exam') {
  // 题目集真实界面：窗口拉到片中尺寸（W×H），逐步截图 + 打印窗口文本
  const W = Number(process.env.W ?? 1240);
  const H = Number(process.env.H ?? 780);
  await tryDo('open apps panel', () => page.locator('[data-testid="wb-dock-apps-button"]').click({ timeout: 5000 }));
  await page.waitForTimeout(1200);
  const APPNAME = process.env.APP ?? '题目集';
  await tryDo(`open ${APPNAME}`, () => page.locator('[role="dialog"], .wb-apps-panel').getByText(APPNAME, { exact: true }).first().click({ timeout: 5000 }));
  await page.waitForTimeout(3000);
  const win = page.locator('[data-wb-window-id]').last();
  // demo.css 按 aria-label 隐藏消息操作「更多」，误伤了题目集 Tab 栏的「更多」菜单（生产构建里可见）
  await page.addStyleTag({ content: "[role=toolbar] button[aria-label='更多'] { display: inline-flex !important; }" });
  // 窗口圆角把角上的命中区裁掉了，分两次拖右边、下边
  const dragEdge = async (dir, dx, dy) => {
    const b = await win.boundingBox();
    const x0 = dir === 'e' ? b.x + b.width - 2 : b.x + b.width / 2;
    const y0 = dir === 's' ? b.y + b.height - 2 : b.y + b.height / 2;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute('data-wb-resize') ?? 'miss', [x0, y0]);
    console.log(`[resize] ${dir} hit=${hit}`);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + dx, y0 + dy, { steps: 12 });
    await page.mouse.up();
  };
  await tryDo('resize', async () => {
    const b = await win.boundingBox();
    if (W !== Math.round(b.width)) await dragEdge('e', W - b.width, 0);
    if (H !== Math.round(b.height)) await dragEdge('s', 0, H - b.height);
  });
  await page.waitForTimeout(900);
  const winShot = async (name) => {
    const b = await win.boundingBox();
    await shot(name, { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(b.width, 1920 - b.x), height: Math.min(b.height, 1080 - b.y) });
    console.log(`[win] ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`);
  };
  const dumpText = async (label) => console.log(`----- ${label}\n` + (await win.innerText()).slice(0, 1800));
  const steps = (process.env.STEPS ?? '').split('|').filter(Boolean);
  const PFX = process.env.PFX ?? 'e';
  await winShot(`${PFX}-0`);
  for (let i = 0; i < steps.length; i++) {
    const [kind, ...rest] = steps[i].split(':');
    const arg = rest.join(':');
    if (kind === 'text') await tryDo(`click text ${arg}`, () => win.getByText(arg, { exact: true }).first().click({ timeout: 5000 }));
    if (kind === 'textp') await tryDo(`click text~ ${arg}`, () => win.getByText(arg, { exact: false }).first().click({ timeout: 5000 }));
    if (kind === 'role') await tryDo(`click button ${arg}`, () => win.getByRole('button', { name: arg }).first().click({ timeout: 5000 }));
    if (kind === 'opt') await tryDo(`click option ${arg}`, () => win.getByRole('option', { name: new RegExp(arg) }).first().click({ timeout: 5000 }));
    if (kind === 'menu') await tryDo(`click menuitem ${arg}`, () => page.getByRole('menuitem', { name: new RegExp(arg) }).first().click({ timeout: 5000 }));
    if (kind === 'css') await tryDo(`click css ${arg}`, () => win.locator(arg).first().click({ timeout: 5000 }));
    if (kind === 'hover') await tryDo(`hover ${arg}`, () => win.getByText(arg, { exact: false }).first().hover({ timeout: 5000 }));
    if (kind === 'file') await tryDo(`file ${arg}`, () => win.locator('input[type=file]').first().setInputFiles(arg, { timeout: 5000 }));
    if (kind === 'key') await tryDo(`key ${arg}`, () => page.keyboard.press(arg));
    if (kind === 'wheel') await tryDo(`wheel ${arg}`, async () => {
      const b = await win.boundingBox();
      await page.mouse.move(b.x + b.width * 0.45, b.y + b.height * 0.62);
      await page.mouse.wheel(0, Number(arg));
    });
    if (kind === 'paste') await tryDo('paste text', async () => {
      await win.locator('textarea:visible').last().evaluate((el) => el.focus());
      await page.keyboard.insertText(process.env.FILL_TEXT ?? '');
    });
    if (kind === 'fill') await tryDo('fill textarea', () => win.locator('textarea').first().fill(arg === 'ESSAY' ? process.env.FILL_TEXT ?? '' : arg.replaceAll('\\n', '\n'), { timeout: 5000 }));
    if (kind === 'wait') await page.waitForTimeout(Number(arg));
    await page.waitForTimeout(1200);
    await winShot(`${PFX}-${i + 1}`);
    if (process.env.DUMPWIN) await dumpText(`after ${steps[i]}`);
  }
  if (process.env.EVAL) console.log('[eval]', await page.evaluate(process.env.EVAL));
  if (process.env.PROBE) {
    console.log(await page.evaluate(() => {
      const out = [];
      const root = [...document.querySelectorAll('[data-wb-window-id]')].pop();
      const r0 = root.getBoundingClientRect();
      out.push(`window: x=${r0.x} y=${r0.y} w=${r0.width} h=${r0.height}`);
      root.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        const cs = getComputedStyle(el);
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
        const isIcon = el.tagName.toLowerCase() === 'svg';
        const hasBox = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px' || cs.boxShadow !== 'none';
        if (!own && !isIcon && !hasBox) return;
        if (isIcon && el.closest('svg') !== el) return;
        out.push(`${el.tagName.toLowerCase()}${own ? ` "${own.slice(0, 30)}"` : ''} x=${(r.x - r0.x).toFixed(1)} y=${(r.y - r0.y).toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)} f=${cs.fontSize}/${cs.fontWeight} c=${cs.color} bg=${cs.backgroundColor} bd=${cs.borderTopWidth} ${cs.borderTopColor} rad=${cs.borderRadius}${cs.boxShadow !== 'none' ? ' sh' : ''}`);
      });
      return out.join('\n');
    }));
  }
} else if (scenario === 'research') {
  // 08 笔记段：对话里让 AI 把「主要发现」改精炼 → builtin-note_replace → 笔记窗审阅；取证时直接派发同一个 canvas:ai-edit-request
  // 编辑器序列化时可能把 [ 转义成 \[，搜索用正则兼容
  const NOTE_EDIT = {
    noteId: 'note_v_research',
    operation: 'replace',
    isRegex: true,
    search: String.raw`1\. 形式化证明成为主流路线[\s\S]*?知识库-1\\?\]`,
    replace: '1. 形式化证明：模型提出思路，Lean 逐步验证，结论可机器检查 [搜索-1][搜索-2]\n2. 过程监督：给推理链逐步打分，比只看最终答案更可靠 [搜索-3]\n3. 检索增强：先找可用的定理与引理，再组织证明 [知识库-1]',
  };
  // RESEARCH=1 NAV=1 SCENE=demo-v-research：4s 兜底导航打开对话窗口（默认 1080×720）→ 手动 activate 打字发送 → 定时截窗口
  const fs = await import('node:fs');
  const PFX = process.env.PFX ?? 'ra';
  const STEP = Number(process.env.STEP_MS ?? 700);
  const N1 = Number(process.env.N1 ?? 30);
  const N2 = Number(process.env.N2 ?? 0);
  const probeAt = new Set((process.env.PROBE_AT ?? '').split(',').filter(Boolean));
  for (let i = 0; i < 12 && !(await page.locator('[data-wb-window-id]').count()); i++) await page.waitForTimeout(250);
  // 6c3d9fbd4 起剧本导航改走握手（未就绪时只挂起意图），工作台不再自动开对话窗口 → 点 Dock 打开，ChatV2Page 就绪后消费挂起的会话
  if (!(await page.locator('[data-wb-window-id]').count())) await tryDo('dock chat', () => dock('chat').click({ timeout: 5000 }));
  for (let i = 0; i < 60 && !(await page.locator('[data-wb-window-id]').count()); i++) await page.waitForTimeout(250);
  const chatId = await page.locator('[data-wb-window-id]').last().getAttribute('data-wb-window-id');
  const win = page.locator(`[data-wb-window-id="${chatId}"]`);
  const newest = () => page.locator('[data-wb-window-id]').last();
  await page.waitForTimeout(1800);
  const winShot = async (name, target = win) => {
    const b = await target.boundingBox();
    if (!b) return console.log('[win] none');
    await shot(name, { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(b.width, 1920 - b.x), height: Math.min(b.height, 1080 - b.y) });
  };
  // portals：给了选择器就改探页面级浮层（菜单 / 弹层），坐标仍相对窗口
  const probe = async (label, target = win, portals = '') => {
    const tid = await target.getAttribute('data-wb-window-id');
    const txt = await page.evaluate(([id, sel]) => {
      const out = [];
      const root = document.querySelector(`[data-wb-window-id="${id}"]`);
      const r0 = root.getBoundingClientRect();
      out.push(`window ${root.getAttribute('data-wb-window-id')}: x=${r0.x} y=${r0.y} w=${r0.width} h=${r0.height}${sel ? ` portals=${document.querySelectorAll(sel).length}` : ''}`);
      const els = sel ? [...document.querySelectorAll(sel)].flatMap((p) => [p, ...p.querySelectorAll('*')]) : [...root.querySelectorAll('*')];
      els.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || (!sel && (r.bottom < r0.y || r.top > r0.bottom))) return;
        const cs = getComputedStyle(el);
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
        const isIcon = el.tagName.toLowerCase() === 'svg';
        const hasBox = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px' || cs.borderLeftWidth !== '0px' || cs.boxShadow !== 'none';
        if (!own && !isIcon && !hasBox) return;
        if (isIcon && el.closest('svg') !== el) return;
        out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter((c) => /^(activity|todo|ask|chat|input|composer|message|note|paper|wb-)/.test(c)).slice(0, 2).join('.') : ''}${own ? ` "${own.slice(0, 34)}"` : ''} x=${(r.x - r0.x).toFixed(1)} y=${(r.y - r0.y).toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)} f=${cs.fontSize}/${cs.fontWeight}/${cs.lineHeight} c=${cs.color} bg=${cs.backgroundColor} bd=${cs.borderTopWidth}/${cs.borderLeftWidth} ${cs.borderTopColor} rad=${cs.borderRadius}${cs.boxShadow !== 'none' ? ' sh=' + cs.boxShadow.slice(0, 60) : ''}`);
      });
      return out.join('\n');
    }, [tid, portals]);
    fs.writeFileSync(`${dir}/probe-${label}.txt`, txt);
    console.log('[probe]', label, txt.split('\n')[0]);
  };
  // 动作序列：title:<title 属性> | aria:<aria-label> | text:<文本> | css:<选择器> | wait:<ms> | shot:<名> | probe:<名> | eval:<js>
  const act = async (spec) => {
    for (const a of (spec ?? '').split('|').filter(Boolean)) {
      const [kind, ...rest] = a.split(':');
      const arg = rest.join(':');
      if (kind === 'title') await tryDo(a, () => win.locator(`[title="${arg}"]`).last().click({ timeout: 4000 }));
      if (kind === 'aria') await tryDo(a, () => win.locator(`[aria-label="${arg}"]`).last().click({ timeout: 4000 }));
      if (kind === 'text') await tryDo(a, () => win.getByText(arg, { exact: true }).last().click({ timeout: 4000 }));
      if (kind === 'textf') await tryDo(a, () => win.getByText(arg, { exact: true }).first().click({ timeout: 4000 }));
      if (kind === 'css') await tryDo(a, () => win.locator(arg).last().click({ timeout: 4000 }));
      if (kind === 'hover') await tryDo(a, () => win.getByText(arg, { exact: false }).last().hover({ timeout: 4000 }));
      if (kind === 'wheel') await tryDo(a, async () => { const b = await win.boundingBox(); await page.mouse.move(b.x + b.width * 0.6, b.y + 200); await page.mouse.wheel(0, Number(arg)); });
      if (kind === 'type') await page.keyboard.type(arg, { delay: 30 });
      if (kind === 'press') await page.keyboard.press(arg);
      if (kind === 'focus') await tryDo(a, () => win.locator(arg).last().click({ timeout: 4000 }));
      if (kind === 'wait') await page.waitForTimeout(Number(arg));
      if (kind === 'shot') await winShot(arg);
      if (kind === 'probe') await probe(arg);
      // 菜单 / 子菜单 / 弹层渲染在页面级浮层里，窗口内的 text: / probe: 够不着
      if (kind === 'ptext') await tryDo(a, () => page.getByText(arg, { exact: true }).last().click({ timeout: 4000 }));
      if (kind === 'pprobe') await probe(arg, win, '[role="menu"], [data-radix-popper-content-wrapper], [role="dialog"]');
      // 从对话里另开的窗口（笔记窗等）：最后挂载的那扇
      if (kind === 'wshot') await winShot(arg, newest());
      if (kind === 'wwheel') await tryDo(a, async () => { const b = await newest().boundingBox(); await page.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.6); await page.mouse.wheel(0, Number(arg)); });
      if (kind === 'wprobe') await probe(arg, newest());
      if (kind === 'wtext') await tryDo(a, () => newest().getByText(arg, { exact: true }).last().click({ timeout: 4000 }));
      if (kind === 'waria') await tryDo(a, () => newest().locator(`[aria-label="${arg}"]`).last().click({ timeout: 4000 }));
      if (kind === 'full') await shot(arg);
      if (kind === 'aiedit') console.log('[aiedit]', await page.evaluate((d) => { window.dispatchEvent(new CustomEvent('canvas:ai-edit-request', { detail: { ...d, requestId: 'v-edit-' + Date.now() } })); return 'sent'; }, NOTE_EDIT));
      // 产品真实链路（AI 当面改）：演示壳把 AgentBridge 换成了空桩 → 手动 start 应用里那份 stageManager，
      // 发与后端 canvas_executor 同形的 apply_ops（note_replace，label 同 build_note_agent_op）；笔记窗 clean →
      // noteDriver 直写 + agentFlashChange + notes:agent-applied。不 await，边跑边截图
      if (kind === 'agentedit') console.log('[agentedit]', await page.evaluate(async (d) => {
        try {
          const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/features/workbench/agent/stageManager.ts')) ?? '/src/features/workbench/agent/stageManager.ts';
          const { stageManager } = await import(url);
          stageManager.start();
          await new Promise((r) => setTimeout(r, 300));
          window.__vAgentT0 = performance.now();
          window.__vAgentEdit = stageManager.handleBridgeRequest({
            correlationId: 'v-corr-' + Date.now(),
            command: 'apply_ops',
            args: { target: { typeId: 'note', resourceId: d.noteId }, ops: [{ kind: 'note_replace', anchor: { position: 'end' }, payload: { search: d.search, replace: d.replace, isRegex: true }, destructive: true, label: `替换笔记内容（模式长度 ${[...d.search].length}）` }], destructive: true },
            timeoutMs: 60000,
            runId: 'v-run-' + Date.now(),
            sessionId: 'sess_v_research',
          }).then((r) => { window.__vAgentEditResult = { ...r, ms: Math.round(performance.now() - window.__vAgentT0) }; return r; });
          return 'sent ' + url;
        } catch (e) {
          return 'ERR ' + String(e?.stack ?? e).slice(0, 400);
        }
      }, NOTE_EDIT));
      if (kind === 'agentresult') console.log('[agentresult]', await page.evaluate(() => JSON.stringify(window.__vAgentEditResult ?? null).slice(0, 800)));
      // wburst:<前缀>,<张数>,<间隔ms>：连拍最后挂载的窗口，记下距 agentedit 发出的毫秒数
      if (kind === 'wburst') {
        const [pfx, n, ms] = arg.split(',');
        for (let i = 0; i < Number(n); i++) {
          const dt = await page.evaluate(() => Math.round(performance.now() - (window.__vAgentT0 ?? 0)));
          await winShot(`${pfx}-${String(i).padStart(2, '0')}`, newest());
          console.log(`[burst] ${pfx}-${String(i).padStart(2, '0')} t+${dt}ms`);
          await page.waitForTimeout(Number(ms));
        }
      }
      if (kind === 'eval') console.log('[eval]', await page.evaluate(arg));
    }
  };
  const b0 = await win.boundingBox();
  console.log(`[win] ${b0 && `${Math.round(b0.x)},${Math.round(b0.y)} ${Math.round(b0.width)}x${Math.round(b0.height)}`}`);
  await winShot(`${PFX}-00`);
  if (probeAt.has('0')) await probe(`${PFX}-0`);
  await act(process.env.PRE_ACT);
  await page.evaluate(() => window.__vAutoPlay?.activate());
  for (let i = 1; i <= N1; i++) {
    await page.waitForTimeout(STEP);
    await winShot(`${PFX}-${String(i).padStart(2, '0')}`);
    if (probeAt.has(String(i))) await probe(`${PFX}-${i}`);
    await act(process.env['AT' + i]);
  }
  await act(process.env.ACT1);
  if (N2) {
    await page.evaluate(() => window.__vAutoPlay?.continueScene('demo-v-research', 'paper'));
    for (let i = 1; i <= N2; i++) {
      await page.waitForTimeout(STEP);
      await winShot(`${PFX}p-${String(i).padStart(2, '0')}`);
      if (probeAt.has(`p${i}`)) await probe(`${PFX}p-${i}`);
      await act(process.env['ATP' + i]);
    }
  }
  await act(process.env.ACT2);
  if (process.env.EVAL) console.log('[eval]', await page.evaluate(process.env.EVAL));
} else if (scenario === 'dashboard') {
  await tryDo('open apps panel', () => page.locator('[data-testid="wb-dock-apps-button"]').click({ timeout: 5000 }));
  await page.waitForTimeout(1200);
  await tryDo('open ai dashboard', () => page.getByText('AI 仪表盘', { exact: true }).first().click({ timeout: 5000 }));
  await page.waitForTimeout(2500);
  await shot('d2-dashboard');
}
if (process.env.DUMP) console.log(await page.evaluate(() => document.body.innerText.slice(0, 3000)));
await browser.close();
