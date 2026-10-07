/**
 * 笔记 / 思维导图两章共用的导图数据与内存后端（vfs_*_mindmap）。
 * 只依赖演示模块，不碰 app 模块（见 ../../types.ts）。
 */
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';

export const MM_EIGEN_ID = 'mm_demo_la_ch5';
export const MM_DP_ID = 'mm_demo_mlsys_ch3';

interface DemoMindmapNode {
  id: string;
  text: string;
  note?: string;
  children: DemoMindmapNode[];
  collapsed?: boolean;
  completed?: boolean;
  blankedRanges?: Array<{ start: number; end: number }>;
  style?: Record<string, unknown>;
}

/** 节点；`blanks` 里的片段在背诵模式下被挖空（按字符下标定位） */
function n(
  id: string,
  text: string,
  children: DemoMindmapNode[] = [],
  extra: { blanks?: string[]; note?: string; completed?: boolean; style?: Record<string, unknown> } = {},
): DemoMindmapNode {
  const node: DemoMindmapNode = { id, text, children };
  if (extra.note) node.note = extra.note;
  if (extra.completed) node.completed = true;
  if (extra.style) node.style = extra.style;
  if (extra.blanks?.length) {
    node.blankedRanges = extra.blanks
      .map((part) => {
        const start = text.indexOf(part);
        return start < 0 ? null : { start, end: start + part.length };
      })
      .filter((range): range is { start: number; end: number } => range !== null);
  }
  return node;
}

// 中心主题即导图标题（打开后窗口 / 标签页标题跟随中心主题）
const EIGEN_ROOT = n('root', '第 5 章 · 特征值与特征向量', [
  n('def', '基本概念', [
    n('def-1', '定义：$A\\boldsymbol{x}=\\lambda\\boldsymbol{x}$（$\\boldsymbol{x}$ 为非零向量）'),
    n('def-2', '特征方程 $\\lvert\\lambda E-A\\rvert=0$'),
    n('def-3', '特征子空间 = $(\\lambda E-A)\\boldsymbol{x}=\\boldsymbol{0}$ 的解空间'),
  ]),
  n('prop', '重要性质', [
    n('prop-1', '特征值之和等于迹：$\\sum\\lambda_i=\\operatorname{tr}A$'),
    n('prop-1b', '特征值之积等于行列式', [], { blanks: ['行列式'] }),
        n('prop-3', '不同特征值的特征向量线性无关', [], { blanks: ['线性无关'] }),
    n('prop-4', '$f(A)$ 的特征值为 $f(\\lambda)$', [], {
      note: '例：$A^{-1}$ 的特征值为 $1/\\lambda$，$A^*$ 的特征值为 $\\lvert A\\rvert/\\lambda$。',
    }),
  ]),
  n('calc', '计算步骤', [
    n('calc-1', '① 解特征方程求全部 $\\lambda_i$'),
    n('calc-2', '② 对每个 $\\lambda_i$ 解齐次方程组'),
    n('calc-3', '③ 基础解系即线性无关的特征向量', [], { blanks: ['基础解系'] }),
  ]),
  n('diag', '相似对角化', [
    n('diag-1', '充要条件：有 n 个线性无关的特征向量', [], { blanks: ['n 个线性无关的特征向量'] }),
    n('diag-2', '几何重数 = 代数重数', [], { blanks: ['代数重数'] }),
    n('diag-3', '实对称矩阵必可正交对角化', [], { blanks: ['正交对角化'] }),
  ]),
  n('app', '典型应用', [
    n('app-1', '求 $A^n$：$A^n=P\\Lambda^nP^{-1}$'),
    n('app-2', '二次型化标准形'),
    n('app-3', 'PCA：协方差矩阵的特征分解'),
  ]),
]);

const DP_ROOT = n('root', '第 3 章 · 数据并行训练', [
  n('n1', '基本范式', [
    n('n1-1', 'mini-batch 切分到 K 个 worker'),
    n('n1-2', '参数服务器 / AllReduce 聚合梯度', [], { blanks: ['AllReduce'] }),
    n('n1-3', '更新值广播回各 worker'),
  ]),
  n('n2', '同步的代价', [
    n('n2-1', 'straggler 效应', [], { blanks: ['straggler'] }),
    n('n2-2', '加速比偏离线性'),
  ]),
  n('n3', '优化方向', [
    n('n3-1', '梯度压缩（量化 / 稀疏化）', [], { blanks: ['量化 / 稀疏化'] }),
    n('n3-2', '计算与通信重叠'),
    n('n3-3', '异步 SGD（陈旧梯度）'),
  ]),
]);

interface DemoMindmapRecord {
  meta: {
    id: string;
    resourceId: string;
    title: string;
    description?: string;
    isFavorite: boolean;
    defaultView: 'mindmap' | 'outline';
    theme?: string;
    createdAt: string;
    updatedAt: string;
  };
  content: string;
  versions: Array<{ versionId: string; mindmapId: string; resourceId: string; title: string; content: string; source: string; createdAt: string }>;
}

function record(id: string, title: string, description: string, root: DemoMindmapNode, createdAt: string, updatedAt: string): DemoMindmapRecord {
  // 平衡布局：分支左右展开，网站嵌入框（约 1120×680）里一屏放得下
  const renderConfig = { layoutId: 'balanced', direction: 'both', styleId: 'default', edgeType: 'bezier' };
  const content = JSON.stringify({ version: '1.0', root, meta: { createdAt, updatedAt, renderConfig } });
  return {
    meta: {
      id,
      resourceId: `res_${id}`,
      title,
      description,
      isFavorite: false,
      defaultView: 'mindmap',
      createdAt,
      updatedAt,
    },
    content,
    versions: [
      { versionId: `${id}_v2`, mindmapId: id, resourceId: `res_${id}_v2`, title, content, source: 'manual', createdAt: updatedAt },
      { versionId: `${id}_v1`, mindmapId: id, resourceId: `res_${id}_v1`, title, content, source: 'chat_update', createdAt },
    ],
  };
}

const mindmaps = new Map<string, DemoMindmapRecord>([
  [MM_EIGEN_ID, record(MM_EIGEN_ID, '第 5 章 · 特征值与特征向量', '从笔记《特征值与特征向量》生成', EIGEN_ROOT, '2026-09-28T13:20:00.000Z', '2026-10-04T21:05:00.000Z')],
  [MM_DP_ID, record(MM_DP_ID, '第 3 章 · 数据并行训练', '《机器学习系统》第 3 章知识框架', DP_ROOT, '2026-09-20T09:12:00.000Z', '2026-09-30T21:40:00.000Z')],
]);

export function listDemoMindmaps(): DemoMindmapRecord['meta'][] {
  return [...mindmaps.values()].map((item) => item.meta);
}

export function getDemoMindmapContent(id: string): string | null {
  return mindmaps.get(id)?.content ?? null;
}

export function createDemoMindmap(title: string, content?: string): DemoMindmapRecord['meta'] {
  const id = `mm_demo_${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const body = content ?? JSON.stringify({ version: '1.0', root: n('root', title), meta: { createdAt: now, updatedAt: now } });
  const item: DemoMindmapRecord = {
    meta: { id, resourceId: `res_${id}`, title, isFavorite: false, defaultView: 'mindmap', createdAt: now, updatedAt: now },
    content: body,
    versions: [],
  };
  mindmaps.set(id, item);
  return item.meta;
}

/** 窄屏（手机宽度）先开大纲视图：画布缩到一屏时字太小 */
export function setDemoMindmapDefaultView(id: string, view: 'mindmap' | 'outline'): void {
  const item = mindmaps.get(id);
  if (item) item.meta = { ...item.meta, defaultView: view };
}

export function renameDemoMindmap(id: string, title: string): boolean {
  const item = mindmaps.get(id);
  if (!item) return false;
  item.meta = { ...item.meta, title, updatedAt: new Date().toISOString() };
  return true;
}

export function deleteDemoMindmap(id: string): boolean {
  return mindmaps.delete(id);
}

let ankiSeq = 0;

/** vfs_*_mindmap 与背诵「背不出的做成卡片」 */
export function handleDemoMindmaps(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'vfs_get_mindmap':
      return mindmaps.get(String(args.mindmapId ?? ''))?.meta ?? null;
    case 'vfs_get_mindmap_content':
      return getDemoMindmapContent(String(args.mindmapId ?? ''));
    case 'vfs_list_mindmaps':
      return listDemoMindmaps();
    case 'vfs_create_mindmap': {
      const params = (args.params ?? {}) as { title?: string; content?: string };
      return createDemoMindmap(params.title || tr('未命名导图', 'Untitled mind map'), params.content);
    }
    case 'vfs_update_mindmap': {
      const item = mindmaps.get(String(args.mindmapId ?? ''));
      if (!item) throw new Error(tr('导图不存在', 'Mind map not found'));
      const { content, expectedUpdatedAt, ...metadata } = (args.params ?? {}) as Record<string, unknown>;
      if (expectedUpdatedAt && expectedUpdatedAt !== item.meta.updatedAt) throw new Error('MINDMAP_UPDATE_CONFLICT');
      const now = new Date().toISOString();
      if (typeof content === 'string' && content !== item.content) {
        item.content = content;
        item.versions.unshift({
          versionId: `${item.meta.id}_v${item.versions.length + 1}`,
          mindmapId: item.meta.id,
          resourceId: `res_${item.meta.id}_v${item.versions.length + 1}`,
          title: item.meta.title,
          content,
          source: 'auto',
          createdAt: now,
        });
      }
      item.meta = { ...item.meta, ...(metadata as Partial<DemoMindmapRecord['meta']>), updatedAt: now };
      return item.meta;
    }
    case 'vfs_set_mindmap_favorite': {
      const item = mindmaps.get(String(args.mindmapId ?? ''));
      if (item) item.meta = { ...item.meta, isFavorite: Boolean(args.isFavorite) };
      return null;
    }
    case 'vfs_get_mindmap_versions': {
      const item = mindmaps.get(String(args.mindmapId ?? ''));
      return (item?.versions ?? []).map(({ content: _content, ...version }) => version);
    }
    case 'vfs_get_mindmap_version': {
      for (const item of mindmaps.values()) {
        const found = item.versions.find((v) => v.versionId === args.versionId);
        if (found) {
          const { content: _content, ...version } = found;
          return version;
        }
      }
      return null;
    }
    case 'vfs_get_mindmap_version_content': {
      for (const item of mindmaps.values()) {
        const found = item.versions.find((v) => v.versionId === args.versionId);
        if (found) return found.content;
      }
      return null;
    }
    case 'vfs_restore_mindmap_version': {
      for (const item of mindmaps.values()) {
        const found = item.versions.find((v) => v.versionId === args.versionId);
        if (found) {
          item.content = found.content;
          item.meta = { ...item.meta, updatedAt: new Date().toISOString() };
          return item.meta;
        }
      }
      throw new Error(tr('版本不存在', 'Version not found'));
    }
    // 背诵模式「背不出的做成卡片」：存卡 + 进 FSRS 队列
    case 'save_anki_cards': {
      const request = (args.request ?? args) as { cards?: unknown[] };
      const count = Array.isArray(request.cards) ? request.cards.length : 0;
      const savedIds = Array.from({ length: count }, () => `card_demo_recite_${++ankiSeq}`);
      return { savedIds, taskId: `task_demo_${ankiSeq}`, failed: [] };
    }
    case 'fsrs_enqueue_cards':
      return null;
    default:
      return undefined;
  }
}
