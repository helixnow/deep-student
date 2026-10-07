/**
 * 制卡任务演示的种子数据：六个制卡任务（已完成 / 进行中 / 已暂停 / 有失败分段）与它们生成的卡片，
 * 外加三套补充模板（单词卡、公式卡、选择题卡），和两套通用演示模板一起组成模板库。
 */
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

export interface DemoDocSeed {
  documentId: string;
  documentName: string;
  sourceSessionId: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  pausedTasks: number;
  /** 多少小时前开始 / 最后更新 */
  createdHoursAgo: number;
  updatedHoursAgo: number;
  cards: AnkiCard[];
  /** 进行中任务里还没「生成」出来的卡，演示时随轮询逐张出现 */
  pending?: AnkiCard[];
  failures?: Array<{ segment: number; message: string }>;
}

const qa = (front: string, back: string, tags: string[]): AnkiCard => ({
  front, back, tags, images: [], template_id: 'tpl_demo_basic',
  fields: { Front: front, Back: back }, extra_fields: { front, back },
});

const cloze = (text: string, tags: string[]): AnkiCard => ({
  front: text, back: text, text, tags, images: [], template_id: 'tpl_demo_cloze',
  fields: { Text: text }, extra_fields: { text },
});

const word = (w: string, phonetic: string, meaning: string, example: string): AnkiCard => ({
  front: w, back: meaning, tags: ['考研英语', 'Unit10'], images: [], template_id: 'tpl_demo_vocab',
  fields: { Word: w, Phonetic: phonetic, Meaning: meaning, Example: example },
  extra_fields: { word: w, phonetic, meaning, example },
});

const formula = (name: string, f: string, note: string, tags: string[]): AnkiCard => ({
  front: name, back: f, tags, images: [], template_id: 'tpl_demo_formula',
  fields: { Name: name, Formula: f, Note: note }, extra_fields: { name, formula: f, note },
});

const MLSYS = ['机器学习系统', '分布式训练'];
const CALC = ['高等数学', '极限与导数'];
const CHEM = ['有机化学', '反应机理'];
const LINALG = ['线性代数', '特征值'];

const VOCAB_ALL = [
  word('abundant', '/əˈbʌndənt/', 'adj. 丰富的，充裕的', 'The region is abundant in natural resources.'),
  word('contemplate', '/ˈkɒntəmpleɪt/', 'v. 沉思；打算', 'She contemplated studying abroad.'),
  word('deteriorate', '/dɪˈtɪəriəreɪt/', 'v. 恶化，变坏', 'His health deteriorated rapidly.'),
  word('elaborate', '/ɪˈlæbərət/', 'adj. 详尽的 v. 详细说明', 'Could you elaborate on that point?'),
  word('feasible', '/ˈfiːzəbl/', 'adj. 可行的', 'The plan is technically feasible.'),
  word('inevitable', '/ɪnˈevɪtəbl/', 'adj. 不可避免的', 'Change is inevitable.'),
  word('legitimate', '/lɪˈdʒɪtɪmət/', 'adj. 合法的；正当的', 'a legitimate reason for absence'),
  word('notorious', '/nəʊˈtɔːriəs/', 'adj. 臭名昭著的', 'The road is notorious for accidents.'),
  word('prevail', '/prɪˈveɪl/', 'v. 盛行；战胜', 'Common sense will prevail.'),
  word('reconcile', '/ˈrekənsaɪl/', 'v. 使和解；调和', 'reconcile work and family life'),
  word('scrutiny', '/ˈskruːtəni/', 'n. 仔细审查', 'The proposal came under close scrutiny.'),
  word('substantial', '/səbˈstænʃl/', 'adj. 大量的；实质的', 'a substantial increase in salary'),
  word('tentative', '/ˈtentətɪv/', 'adj. 试探性的，暂定的', 'a tentative agreement'),
  word('undermine', '/ˌʌndəˈmaɪn/', 'v. 逐渐削弱', 'Criticism undermined her confidence.'),
];

export const DEMO_DOCS: DemoDocSeed[] = [
  {
    documentId: 'doc_demo_vocab_u10',
    documentName: '考研英语::Unit10 核心词汇',
    sourceSessionId: 'demo-session-anki-vocab',
    totalTasks: 6, completedTasks: 3, failedTasks: 0, activeTasks: 3, pausedTasks: 0,
    createdHoursAgo: 0.2, updatedHoursAgo: 0,
    cards: VOCAB_ALL.slice(0, 7),
    pending: VOCAB_ALL.slice(7),
  },
  {
    documentId: 'doc_demo_mlsys_ch7',
    documentName: '机器学习系统::第 7 章 分布式训练',
    sourceSessionId: 'demo-session-anki-mlsys',
    totalTasks: 5, completedTasks: 5, failedTasks: 0, activeTasks: 0, pausedTasks: 0,
    createdHoursAgo: 3, updatedHoursAgo: 2.6,
    cards: [
      qa('数据并行训练中，每一步结束前各卡之间同步的是什么？', '梯度。各卡持有完整模型副本、处理不同数据分片，反向传播后用 AllReduce 聚合梯度，再各自更新参数。', MLSYS),
      qa('Ring AllReduce 的通信量与卡数 N 有什么关系？', '每张卡发送和接收的数据量约为 2(N−1)/N × 模型大小，几乎不随卡数增长——这是它适合大规模数据并行的原因。', MLSYS),
      qa('ZeRO 的三个阶段分别切分了什么？', 'Stage 1 切分优化器状态；Stage 2 再切分梯度；Stage 3 连参数也切分。阶段越高显存越省、通信越多。', MLSYS),
      cloze('流水线并行把模型按 {{c1::层}} 切到不同设备上，用 {{c2::微批次（micro-batch）}} 填充流水线以减少气泡。', MLSYS),
      qa('梯度检查点（重计算）用什么换显存？', '用计算时间换显存：前向只保存部分激活，反向时重新计算其余激活，通常多花约 30% 计算。', MLSYS),
      cloze('张量并行把单层的 {{c1::矩阵乘法}} 拆到多卡上，每层前向需要一次 {{c2::AllReduce}} 合并结果。', MLSYS),
      qa('混合精度训练为什么需要 loss scaling？', 'FP16 的可表示范围小，小梯度会下溢为 0；把 loss 放大若干倍再反向传播，更新前再缩回，避免梯度消失。', MLSYS),
      qa('全局批大小增大时，学习率通常怎么调？', '常用线性缩放规则：批大小扩大 k 倍，学习率也乘 k，并配合 warmup 避免训练初期发散。', MLSYS),
      cloze('数据并行中 {{c1::梯度累积}} 可以在显存不变的情况下模拟更大的批大小。', MLSYS),
      qa('为什么说通信与计算重叠能提升数据并行效率？', '反向传播从后往前算梯度，后面层的梯度一算好就可以开始 AllReduce，与前面层的计算并行，隐藏通信时间。', MLSYS),
    ],
  },
  {
    documentId: 'doc_demo_chem_mech',
    documentName: '有机化学::亲核取代反应讲义',
    sourceSessionId: 'demo-session-anki-chem',
    totalTasks: 6, completedTasks: 5, failedTasks: 1, activeTasks: 0, pausedTasks: 0,
    createdHoursAgo: 27, updatedHoursAgo: 26,
    cards: [
      qa('SN1 与 SN2 反应的速率方程分别是什么？', 'SN1：v = k[RX]（一级，只与底物有关）；SN2：v = k[RX][Nu⁻]（二级，与底物和亲核试剂都有关）。', CHEM),
      cloze('SN2 反应中亲核试剂从离去基团的 {{c1::背面}} 进攻，产物发生 {{c2::构型翻转（Walden 翻转）}}。', CHEM),
      qa('为什么叔卤代烃倾向于 SN1 而不是 SN2？', '叔碳正离子稳定（超共轭与诱导效应），有利于 SN1；同时三个烷基造成的空间位阻阻碍背面进攻，不利于 SN2。', CHEM),
      qa('极性质子溶剂对 SN1 有什么影响？', '能通过氢键稳定碳正离子中间体和离去基团，降低电离能垒，加快 SN1 反应。', CHEM),
      cloze('卤代烃中离去能力：{{c1::I⁻ > Br⁻ > Cl⁻ > F⁻}}，与对应氢卤酸的酸性顺序一致。', CHEM),
      qa('SN1 反应可能伴随什么重排？', '碳正离子重排：氢或烷基发生 1,2-迁移，生成更稳定的碳正离子（如仲碳 → 叔碳）。', CHEM),
      qa('E2 消除对底物构象有什么要求？', '要求离去基团与被消除的 β-H 处于反式共平面（anti-periplanar）。', CHEM),
    ],
    failures: [{ segment: 6, message: '第 6 段是扫描页，文字识别置信度过低（0.41），模型没能抽出完整的反应式。可以重试，或换成图文增强路线。' }],
  },
  {
    documentId: 'doc_demo_calc_mistakes',
    documentName: '高等数学::极限与导数 错题',
    sourceSessionId: 'demo-session-anki-calc',
    totalTasks: 2, completedTasks: 2, failedTasks: 0, activeTasks: 0, pausedTasks: 0,
    createdHoursAgo: 50, updatedHoursAgo: 49.5,
    cards: [
      formula('重要极限（1^∞ 型）', 'lim(x→∞) (1 + a/x)^x = eᵃ', '指数里的系数不能漏：(1+2/x)^x → e²，不是 e。', CALC),
      formula('等价无穷小（x→0）', 'sin x ~ x，ln(1+x) ~ x，eˣ − 1 ~ x，1 − cos x ~ x²/2', '只能在乘除中替换，加减中替换容易出错。', CALC),
      formula('x − sin x 的阶', 'x − sin x ~ x³/6（x→0）', '来自 sin x = x − x³/6 + o(x³)。', CALC),
      qa('连续与可导是什么关系？', '可导必连续，连续不一定可导。反例：f(x) = |x| 在 x = 0 处连续但不可导。', CALC),
      formula('闭区间上的最值', '比较驻点与端点处的函数值', 'y = x³ − 3x 在 [0,2] 上：y(0)=0，y(1)=−2，y(2)=2，最小值 −2。', CALC),
      qa('二阶导数为零时，还能用二阶导判别极值吗？', '不能，判别法失效。例如 f(x) = x⁴ 在 x = 0 处 f″(0) = 0，但仍是极小值点，需要回到定义或更高阶导数。', CALC),
    ],
  },
  {
    documentId: 'doc_demo_linalg_eigen',
    documentName: '线性代数::特征值与特征向量',
    sourceSessionId: 'demo-session-anki-linalg',
    totalTasks: 4, completedTasks: 2, failedTasks: 0, activeTasks: 0, pausedTasks: 2,
    createdHoursAgo: 75, updatedHoursAgo: 74,
    cards: [
      formula('特征值的定义', 'Ax = λx，x ≠ 0', 'λ 由特征方程 |λE − A| = 0 求出。', LINALG),
      formula('特征值之和与之积', 'λ₁ + … + λₙ = tr(A)，λ₁ · … · λₙ = |A|', '快速检验求出的特征值是否正确。', LINALG),
      cloze('实对称矩阵的不同特征值对应的特征向量一定 {{c1::正交}}。', LINALG),
      qa('矩阵可相似对角化的充要条件是什么？', 'n 阶矩阵有 n 个线性无关的特征向量；等价地，每个特征值的几何重数等于代数重数。', LINALG),
    ],
  },
  {
    documentId: 'doc_demo_highlight_mlsys',
    documentName: '划词制卡::机器学习系统',
    sourceSessionId: null,
    totalTasks: 1, completedTasks: 1, failedTasks: 0, activeTasks: 0, pausedTasks: 0,
    createdHoursAgo: 120, updatedHoursAgo: 120,
    cards: [
      qa('什么是参数服务器架构？', '一组服务器节点保存全局参数，工作节点拉取参数、计算梯度再推送回去；与 AllReduce 的去中心化方式相对。', MLSYS),
      qa('同步训练与异步训练的主要区别？', '同步训练每步等待所有节点完成再更新，结果确定但受慢节点拖累；异步训练各节点独立更新，吞吐高但存在梯度过时问题。', MLSYS),
      cloze('{{c1::梯度过时（stale gradient）}} 是异步数据并行收敛变慢的主要原因。', MLSYS),
    ],
  },
];

const TEMPLATE_BASE = {
  author: 'Deep Student',
  version: '1.0',
  generation_prompt: '',
  preview_front: '',
  preview_back: '',
  is_active: true,
  is_built_in: true,
  created_at: '2026-03-02T08:00:00.000Z',
  updated_at: '2026-09-12T08:00:00.000Z',
};

const CARD_CSS =
  '.card { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 15px; line-height: 1.7; padding: 18px 20px; box-sizing: border-box; } ';

export const EXTRA_TEMPLATES: CustomAnkiTemplate[] = [
  {
    ...TEMPLATE_BASE,
    id: 'tpl_demo_vocab',
    name: '英语单词卡',
    description: '单词 + 音标在正面，释义与例句在背面，适合考研 / 四六级词汇',
    note_type: 'Basic',
    fields: ['Word', 'Phonetic', 'Meaning', 'Example'],
    front_template: '<div class="card"><div class="word">{{Word}}</div><div class="phonetic">{{Phonetic}}</div></div>',
    back_template:
      '<div class="card"><div class="word">{{Word}}</div><div class="phonetic">{{Phonetic}}</div><hr id="answer" /><div class="meaning">{{Meaning}}</div>{{#Example}}<div class="example">{{Example}}</div>{{/Example}}</div>',
    css_style:
      CARD_CSS +
      '.word { font-size: 24px; font-weight: 700; letter-spacing: 0.01em; } .phonetic { opacity: 0.6; font-size: 14px; margin-top: 2px; } ' +
      '.meaning { font-weight: 600; } .example { margin-top: 8px; font-style: italic; opacity: 0.75; } ' +
      'hr#answer { border: none; border-top: 1px dashed currentColor; opacity: 0.3; margin: 10px 0; }',
    field_extraction_rules: {
      Word: { field_type: 'text', is_required: true, description: '单词原形' },
      Phonetic: { field_type: 'text', is_required: false, description: '英式音标' },
      Meaning: { field_type: 'text', is_required: true, description: '词性 + 中文释义' },
      Example: { field_type: 'text', is_required: false, description: '一句真题风格的例句' },
    },
    preview_data_json: JSON.stringify({ Word: 'feasible', Phonetic: '/ˈfiːzəbl/', Meaning: 'adj. 可行的', Example: 'The plan is technically feasible.' }),
  } as unknown as CustomAnkiTemplate,
  {
    ...TEMPLATE_BASE,
    id: 'tpl_demo_formula',
    name: '公式卡',
    description: '正面是公式名称，背面是公式与使用条件，适合数理化',
    note_type: 'Basic',
    fields: ['Name', 'Formula', 'Note'],
    front_template: '<div class="card"><div class="name">{{Name}}</div></div>',
    back_template:
      '<div class="card"><div class="name name--dim">{{Name}}</div><div class="formula">{{Formula}}</div>{{#Note}}<div class="note">{{Note}}</div>{{/Note}}</div>',
    css_style:
      CARD_CSS +
      '.name { font-weight: 600; } .name--dim { opacity: 0.6; font-size: 13px; } ' +
      '.formula { margin: 10px 0; padding: 10px 12px; border-radius: 8px; background: rgba(127,127,127,0.12); font-family: "STIX Two Math", "Cambria Math", serif; font-size: 17px; } ' +
      '.note { font-size: 13px; opacity: 0.75; }',
    field_extraction_rules: {
      Name: { field_type: 'text', is_required: true, description: '公式或定理名称' },
      Formula: { field_type: 'text', is_required: true, description: '公式本体' },
      Note: { field_type: 'text', is_required: false, description: '适用条件或易错点' },
    },
    preview_data_json: JSON.stringify({ Name: '等价无穷小（x→0）', Formula: 'sin x ~ x，ln(1+x) ~ x', Note: '只能在乘除中替换' }),
  } as unknown as CustomAnkiTemplate,
  {
    ...TEMPLATE_BASE,
    id: 'tpl_demo_choice',
    name: '学术选择题',
    description: '题干 + 选项在正面，答案与解析在背面',
    note_type: 'Basic',
    fields: ['Question', 'Options', 'Answer', 'Explanation'],
    front_template: '<div class="card"><div class="q">{{Question}}</div><div class="opts">{{Options}}</div></div>',
    back_template:
      '<div class="card"><div class="q">{{Question}}</div><div class="opts">{{Options}}</div><hr id="answer" /><div class="ans">答案：{{Answer}}</div><div class="exp">{{Explanation}}</div></div>',
    css_style:
      CARD_CSS +
      '.q { font-weight: 600; } .opts { white-space: pre-wrap; margin-top: 6px; } .ans { font-weight: 700; } .exp { margin-top: 6px; opacity: 0.8; } ' +
      'hr#answer { border: none; border-top: 1px dashed currentColor; opacity: 0.3; margin: 10px 0; }',
    field_extraction_rules: {
      Question: { field_type: 'text', is_required: true, description: '题干' },
      Options: { field_type: 'text', is_required: true, description: '选项，每行一个' },
      Answer: { field_type: 'text', is_required: true, description: '正确选项字母' },
      Explanation: { field_type: 'text', is_required: false, description: '解析' },
    },
    preview_data_json: JSON.stringify({ Question: '数据并行训练中各卡同步的是', Options: 'A. 输入数据\nB. 梯度\nC. 激活值\nD. 学习率', Answer: 'B', Explanation: '反向传播后 AllReduce 聚合梯度。' }),
  } as unknown as CustomAnkiTemplate,
];
