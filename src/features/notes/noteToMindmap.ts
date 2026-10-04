/**
 * 笔记 → 思维导图：把笔记的标题 / 列表大纲本地解析成导图（不调模型、秒出），
 * 建在笔记所在的文件夹并在学习资源里打开。
 *
 * 解析与「导入 Markdown 导图」「粘贴大纲」共用 markdownListToNodes：
 * 标题层级 + 嵌套列表成节点，段落 / 表格 / 代码块并入上一节点备注，$…$ 公式节点内渲染。
 */
import { getFolderTree } from '@/dstu/api/folderApi';
import type { FolderTreeNode } from '@/dstu/types/folder';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import { createMindMap } from '@/features/mindmap/api/mindmapApi';
import type { MindMapDocument, MindMapNode } from '@/features/mindmap/types';
import { markdownListToNodes } from '@/features/mindmap/utils/pasteMarkdown';
import { showGlobalNotification } from '@/components/UnifiedNotification';

type Translate = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

/** 少于这么多节点（含根）就不算大纲，提示先整理成标题 / 列表 */
const MIN_OUTLINE_NODES = 3;
/** 超过这么多节点时，第 2 层起默认折叠：打开先看「根 → 章 → 核心概念」概览，不至于整图缩成看不清的一条 */
const OVERVIEW_COLLAPSE_THRESHOLD = 40;
const OVERVIEW_DEPTH = 2;

function collapseBelow(node: MindMapNode, depth: number): MindMapNode {
  if (node.children.length === 0) return node;
  return {
    ...node,
    ...(depth >= OVERVIEW_DEPTH ? { collapsed: true } : {}),
    children: node.children.map((child) => collapseBelow(child, depth + 1)),
  };
}

function countNodes(node: MindMapNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/** 笔记大纲 → 导图文档：只有一个顶级条目时它就是根，否则以笔记标题为根 */
export function buildMindmapFromNoteMarkdown(markdown: string, noteTitle: string): MindMapDocument | null {
  const forest = markdownListToNodes(markdown);
  if (forest.length === 0) return null;
  const root: MindMapNode = forest.length === 1
    ? { ...forest[0], id: 'root' }
    : { id: 'root', text: noteTitle, children: forest };
  const total = countNodes(root);
  if (total < MIN_OUTLINE_NODES) return null;
  return {
    version: '1.0',
    root: total > OVERVIEW_COLLAPSE_THRESHOLD ? collapseBelow(root, 0) : root,
    meta: { createdAt: new Date().toISOString() },
  };
}

function findItemFolderId(nodes: FolderTreeNode[], itemId: string): string | null {
  for (const node of nodes) {
    if (node.items.some((item) => item.itemId === itemId)) return node.folder.id;
    const nested = findItemFolderId(node.children, itemId);
    if (nested) return nested;
  }
  return null;
}

export async function generateMindmapFromNote(input: {
  markdown: string;
  noteTitle: string;
  noteId?: string | null;
  translate: Translate;
}): Promise<void> {
  const { translate: tr } = input;
  const title = input.noteTitle.trim() || tr('notes:generateMindmap.untitled', '笔记导图');
  let doc: MindMapDocument | null;
  try {
    doc = buildMindmapFromNoteMarkdown(input.markdown, title);
  } catch (error) {
    // 超深 / 超大大纲（解析器守卫抛错）
    showGlobalNotification('error', tr('notes:generateMindmap.failedWithError', '生成思维导图失败：{{error}}', { error: String(error) }));
    return;
  }
  if (!doc) {
    showGlobalNotification('warning', tr('notes:generateMindmap.noOutline', '这篇笔记里没有标题或列表，先用标题 / 列表整理出层级再生成导图'));
    return;
  }

  let folderId: string | undefined;
  if (input.noteId) {
    const tree = await getFolderTree();
    if (tree.ok) folderId = findItemFolderId(tree.value, input.noteId) ?? undefined;
  }

  try {
    // 导图标题与根节点一致（标签页 / 画布显示的都是根节点文字，列表名不一致会对不上）
    const mapTitle = doc.root.text.trim() || title;
    const mindmap = await createMindMap({
      title: mapTitle,
      content: JSON.stringify(doc),
      defaultView: 'mindmap',
      folderId,
    });
    showGlobalNotification('success', tr('notes:generateMindmap.created', '已生成思维导图「{{title}}」（{{count}} 个节点）', {
      title: mapTitle,
      count: countNodes(doc.root),
    }));
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'learning-hub', openResource: `/${mindmap.id}` });
  } catch (error) {
    showGlobalNotification('error', tr('notes:generateMindmap.failedWithError', '生成思维导图失败：{{error}}', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
