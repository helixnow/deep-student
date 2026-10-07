/**
 * 制卡任务 + 模板管理演示的内存后端。
 * 「考研英语 Unit10」是一个正在跑的任务：每隔几秒「生成」一张新卡，可暂停 / 继续 / 取消；
 * 有机化学讲义有一个失败分段，点「重试失败段」几秒后补出一张卡并完成。
 * 只依赖演示数据模块（见 ../../types.ts 的加载顺序约定）。
 */
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import type { DemoArgs } from '../../types';
import { tr } from '../../../lang';
import { DEMO_ANKI_TEMPLATES } from '../../../ankiTemplates';
import { DEMO_DOCS, EXTRA_TEMPLATES, type DemoDocSeed } from './data';

const HOUR = 3_600_000;
/** 进行中任务每隔多久「生成」出一张卡 */
const CARD_EVERY_MS = 3_500;

const desktopOnly = () =>
  new Error(tr(
    '导出 APKG 与同步到 Anki 需要本机文件与 AnkiConnect，请在桌面版中使用。',
    'APKG export and Anki sync need local files and AnkiConnect — available in the desktop app.',
  ));

interface DocState {
  seed: DemoDocSeed;
  cards: AnkiCard[];
  pending: AnkiCard[];
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  pausedTasks: number;
  createdAt: number;
  updatedAt: number;
  /** 进行中时下一张卡的出现时刻 */
  nextCardAt: number | null;
  failures: Array<{ segment: number; message: string }>;
}

const boot = Date.now();
let seq = 0;

const docs = new Map<string, DocState>(
  DEMO_DOCS.map((seed) => {
    const cards = seed.cards.map((card, i) => withId(card, seed.documentId, i));
    return [seed.documentId, {
      seed,
      cards,
      pending: (seed.pending ?? []).map((card, i) => withId(card, seed.documentId, cards.length + i)),
      completedTasks: seed.completedTasks,
      failedTasks: seed.failedTasks,
      activeTasks: seed.activeTasks,
      pausedTasks: seed.pausedTasks,
      createdAt: boot - seed.createdHoursAgo * HOUR,
      updatedAt: boot - seed.updatedHoursAgo * HOUR,
      nextCardAt: seed.activeTasks > 0 ? boot + CARD_EVERY_MS : null,
      failures: [...(seed.failures ?? [])],
    }];
  }),
);

function withId(card: AnkiCard, documentId: string, index: number): AnkiCard {
  const at = new Date(boot - (index + 1) * 60_000).toISOString();
  return { ...card, id: `${documentId}_card_${index + 1}`, task_id: `${documentId}_seg_${Math.floor(index / 3) + 1}`,
    is_error_card: false, created_at: at, updated_at: at };
}

/** 推进进行中的任务：按时间把待生成的卡挪进已生成，分段随之完成 */
function tick(doc: DocState): void {
  if (doc.nextCardAt == null || doc.activeTasks === 0) return;
  const now = Date.now();
  while (doc.nextCardAt != null && now >= doc.nextCardAt) {
    const next = doc.pending.shift();
    if (next) {
      const stamp = new Date(doc.nextCardAt).toISOString();
      doc.cards.push({ ...next, created_at: stamp, updated_at: stamp });
      doc.updatedAt = doc.nextCardAt;
    }
    const total = doc.seed.totalTasks;
    const produced = doc.cards.length;
    const all = produced + doc.pending.length;
    // 卡片进度折算成分段进度（至少保留一个分段在跑，直到最后一张卡出来）
    const done = doc.pending.length === 0
      ? total - doc.failedTasks
      : Math.min(total - doc.failedTasks - 1, Math.floor((produced / all) * total));
    doc.completedTasks = Math.max(doc.completedTasks, done);
    doc.activeTasks = total - doc.completedTasks - doc.failedTasks - doc.pausedTasks;
    doc.nextCardAt = doc.pending.length > 0 ? doc.nextCardAt + CARD_EVERY_MS : null;
    if (doc.activeTasks <= 0) {
      doc.activeTasks = 0;
      doc.nextCardAt = null;
    }
  }
}

function sessionOf(doc: DocState) {
  tick(doc);
  return {
    documentId: doc.seed.documentId,
    documentName: doc.seed.documentName,
    sourceSessionId: doc.seed.sourceSessionId,
    totalTasks: doc.seed.totalTasks,
    completedTasks: doc.completedTasks,
    failedTasks: doc.failedTasks,
    activeTasks: doc.activeTasks,
    pausedTasks: doc.pausedTasks,
    lastUpdated: new Date(doc.updatedAt).toISOString(),
    createdAt: new Date(doc.createdAt).toISOString(),
    totalCards: doc.cards.length,
  };
}

function requireDoc(id: unknown): DocState {
  const doc = docs.get(String(id ?? ''));
  if (!doc) throw new Error(tr('制卡任务不存在', 'Card-making task not found'));
  return doc;
}

function documentTasks(doc: DocState) {
  const out = [];
  const failedSegments = new Set(doc.failures.map((f) => f.segment));
  for (let i = 1; i <= doc.seed.totalTasks; i++) {
    const failure = doc.failures.find((f) => f.segment === i);
    let status = 'Completed';
    if (failedSegments.has(i)) status = 'Failed';
    else if (i > doc.completedTasks + doc.failures.length) status = doc.pausedTasks > 0 ? 'Paused' : doc.activeTasks > 0 ? 'Streaming' : 'Pending';
    out.push({ id: `${doc.seed.documentId}_seg_${i}`, status, segment_index: i - 1, error_message: failure?.message ?? null,
      updated_at: new Date(doc.updatedAt).toISOString() });
  }
  return out;
}

function retrySegment(taskId: string): null {
  const doc = [...docs.values()].find((d) => taskId.startsWith(`${d.seed.documentId}_seg_`));
  if (!doc) throw new Error(tr('分段不存在', 'Segment not found'));
  const segment = Number(taskId.split('_seg_')[1]);
  doc.failures = doc.failures.filter((f) => f.segment !== segment);
  doc.failedTasks = doc.failures.length;
  doc.activeTasks += 1;
  doc.updatedAt = Date.now();
  if (doc.seed.documentId === 'doc_demo_chem_mech' && doc.pending.length === 0) {
    doc.pending.push(withId({
      front: '比较 SN1 与 SN2 的立体化学结果', back: 'SN2：构型完全翻转；SN1：经平面碳正离子，得到外消旋（常伴随少量构型翻转过量）。',
      tags: ['有机化学', '反应机理'], images: [], template_id: 'tpl_demo_basic',
      fields: { Front: '比较 SN1 与 SN2 的立体化学结果', Back: 'SN2：构型完全翻转；SN1：经平面碳正离子，得到外消旋（常伴随少量构型翻转过量）。' },
    }, doc.seed.documentId, doc.cards.length));
  }
  doc.nextCardAt = Date.now() + CARD_EVERY_MS;
  return null;
}

// ---------------------------------------------------------------- 模板

/** 通用演示模板没带预览数据，模板库卡片会是空白：这里补上 */
const PREVIEW_DATA: Record<string, Record<string, string>> = {
  tpl_demo_basic: { Front: 'ZeRO 的三个阶段分别切分了什么？', Back: 'Stage 1 优化器状态；Stage 2 再加梯度；Stage 3 连参数也切分。' },
  tpl_demo_cloze: { Text: 'SN2 反应中亲核试剂从离去基团的 {{c1::背面}} 进攻，产物发生 {{c2::构型翻转}}。' },
};

/** 编辑器里「预览正面 / 背面文本」是必填项 */
const PREVIEW_TEXT: Record<string, [string, string]> = {
  tpl_demo_basic: ['ZeRO 的三个阶段分别切分了什么？', 'Stage 1 优化器状态；Stage 2 梯度；Stage 3 参数'],
  tpl_demo_cloze: ['SN2 反应从离去基团的 [...] 进攻', 'SN2 反应从离去基团的背面进攻'],
  tpl_demo_vocab: ['feasible /ˈfiːzəbl/', 'adj. 可行的'],
  tpl_demo_formula: ['等价无穷小（x→0）', 'sin x ~ x，ln(1+x) ~ x'],
  tpl_demo_choice: ['数据并行训练中各卡同步的是', '答案：B 梯度'],
};

const templates = new Map<string, CustomAnkiTemplate>(
  [...DEMO_ANKI_TEMPLATES, ...EXTRA_TEMPLATES].map((tpl) => [tpl.id, {
    ...tpl,
    preview_data_json: tpl.preview_data_json ?? (PREVIEW_DATA[tpl.id] ? JSON.stringify(PREVIEW_DATA[tpl.id]) : undefined),
    preview_front: tpl.preview_front || PREVIEW_TEXT[tpl.id]?.[0] || tpl.name,
    preview_back: tpl.preview_back || PREVIEW_TEXT[tpl.id]?.[1] || tpl.description,
  }]),
);
let defaultTemplateId: string | null = 'tpl_demo_basic';

function bumpVersion(version: string | undefined): string {
  const [major = '1', minor = '0'] = String(version ?? '1.0').split('.');
  return `${major}.${Number(minor) + 1}`;
}

function templateRefs(id: string): number {
  let n = 0;
  for (const doc of docs.values()) n += doc.cards.filter((c) => c.template_id === id).length;
  return n;
}

let preventSleep = false;

export function handleAnki(cmd: string, args: DemoArgs): unknown {
  const a = args as Record<string, any>;
  switch (cmd) {
    // 任务看板
    case 'list_document_sessions':
      return [...docs.values()].map(sessionOf).sort((x, y) => y.lastUpdated.localeCompare(x.lastUpdated));
    case 'get_anki_stats': {
      const all = [...docs.values()];
      all.forEach(tick);
      return { totalCards: all.reduce((s, d) => s + d.cards.length, 0), totalDocuments: all.length,
        errorCards: 0, templateCount: templates.size };
    }
    case 'get_document_cards': {
      const doc = requireDoc(a.documentId);
      tick(doc);
      return doc.cards;
    }
    case 'get_document_tasks':
      return documentTasks(requireDoc(a.documentId));
    case 'pause_document_processing': {
      const doc = requireDoc(a.documentId);
      tick(doc);
      doc.pausedTasks += doc.activeTasks;
      doc.activeTasks = 0;
      doc.nextCardAt = null;
      doc.updatedAt = Date.now();
      return null;
    }
    case 'resume_document_processing': {
      const doc = requireDoc(a.documentId);
      doc.activeTasks += doc.pausedTasks;
      doc.pausedTasks = 0;
      doc.updatedAt = Date.now();
      if (doc.pending.length === 0 && doc.activeTasks > 0) {
        // 已暂停的线性代数任务：恢复后补完剩下的分段
        doc.pending.push(withId({
          front: '相似矩阵有哪些共同点？', back: '特征多项式、特征值、迹、行列式、秩都相同。', tags: ['线性代数', '特征值'], images: [],
          template_id: 'tpl_demo_basic', fields: { Front: '相似矩阵有哪些共同点？', Back: '特征多项式、特征值、迹、行列式、秩都相同。' },
        }, doc.seed.documentId, doc.cards.length));
      }
      doc.nextCardAt = Date.now() + CARD_EVERY_MS;
      return null;
    }
    case 'cancel_document_processing': {
      const doc = requireDoc(a.documentId);
      tick(doc);
      const stopped = doc.activeTasks + doc.pausedTasks;
      for (let i = 0; i < stopped; i++) {
        doc.failures.push({ segment: doc.completedTasks + doc.failures.length + 1, message: tr('已取消', 'Cancelled') });
      }
      doc.failedTasks = doc.failures.length;
      doc.activeTasks = 0;
      doc.pausedTasks = 0;
      doc.pending = [];
      doc.nextCardAt = null;
      doc.updatedAt = Date.now();
      return null;
    }
    case 'trigger_task_processing':
      return retrySegment(String(a.taskId ?? ''));
    case 'delete_document_session':
      docs.delete(String(a.documentId ?? ''));
      return null;
    case 'recover_stuck_document_tasks':
      return 0;
    case 'get_prevent_sleep':
      return preventSleep;
    case 'set_prevent_sleep':
      preventSleep = Boolean(a.enabled);
      return preventSleep;
    case 'chat_v2_get_anki_cards_from_block_by_document_id':
      return [];
    // 选保存位置：生产代码把这里的异常折成笼统的「导出失败」，所以演示按「用户取消」返回，
    // 自己发一条说明（直接派发 showGlobalNotification 窗口事件，不 import 应用模块）
    case 'plugin:dialog|save':
    case 'plugin:dialog|open':
      window.dispatchEvent(new CustomEvent('showGlobalNotification', {
        detail: { type: 'info', message: desktopOnly().message },
      }));
      return null;
    case 'export_multi_template_apkg':
    case 'export_cards_as_apkg':
    case 'add_cards_to_anki_connect':
      throw desktopOnly();
    case 'check_anki_connect_status':
      return false;

    // 模板库
    case 'get_all_custom_templates':
      return [...templates.values()];
    case 'get_default_template_id':
      return defaultTemplateId;
    case 'set_default_template':
      defaultTemplateId = String(a.templateId ?? '') || null;
      return null;
    case 'import_builtin_templates':
      return tr('内置模板已是最新（0 个新增）', 'Built-in templates are up to date (0 added)');
    case 'create_custom_template': {
      const now = new Date().toISOString();
      const id = `tpl_user_${++seq}`;
      templates.set(id, { ...(a.request ?? {}), id, version: a.request?.version ?? '1.0', is_built_in: false,
        is_active: a.request?.is_active ?? true, created_at: now, updated_at: now } as CustomAnkiTemplate);
      return id;
    }
    case 'update_custom_template': {
      const current = templates.get(String(a.templateId ?? ''));
      if (!current) throw new Error(tr('模板不存在', 'Template not found'));
      const { expected_version: _expected, ...rest } = a.request ?? {};
      templates.set(current.id, { ...current, ...rest, version: bumpVersion(current.version), updated_at: new Date().toISOString() });
      return null;
    }
    case 'delete_custom_template': {
      const id = String(a.templateId ?? '');
      const tpl = templates.get(id);
      const refs = templateRefs(id);
      templates.delete(id);
      if (defaultTemplateId === id) defaultTemplateId = 'tpl_demo_basic';
      return { deleted: true, isBuiltIn: Boolean(tpl?.is_built_in), referencingCards: refs };
    }
    case 'count_custom_template_references':
      return templateRefs(String(a.templateId ?? ''));
    case 'export_template': {
      const tpl = templates.get(String(a.templateId ?? ''));
      return { template_data: JSON.stringify({ version: 1, template: tpl }, null, 2) };
    }
    case 'import_custom_templates_bulk':
      throw new Error(tr('导入模板文件请在桌面版中使用。', 'Importing template files is available in the desktop app.'));
    default:
      return undefined;
  }
}
