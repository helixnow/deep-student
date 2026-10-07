/**
 * 第 07 章「笔记」：笔记工作区窗口——左侧文件树（线性代数 / 机器学习系统两门课的文件夹、
 * 九篇笔记、两张导图），打开《特征值与特征向量》（标题、列表、公式、待办、双链），
 * 右侧「链接」面板列出反向链接。编辑、自动保存、新建、改名、标签、学习属性、
 * 双链跳转、图谱都走 ../data/notes 的内存后端。
 */
import type { DemoAppPack } from '../types';
import { handleDemoNotes } from '../data/notes/notesBackend';
import { NOTE_EIGEN_ID } from '../data/notes/notesContent';
import { MM_EIGEN_ID } from '../data/notes/mindmaps';
import { patchSettingsStrings } from '../data/notes/i18nPatch';

/** 工作区启动时恢复的标签页（NotesWorkspaceApp 的持久化状态） */
const WORKSPACE_STATE = {
  tabs: [
    { key: `note:${NOTE_EIGEN_ID}`, type: 'note', id: NOTE_EIGEN_ID, title: '特征值与特征向量', pinned: false },
    { key: 'note:note_demo_diag', type: 'note', id: 'note_demo_diag', title: '矩阵的相似对角化', pinned: false },
    { key: `mindmap:${MM_EIGEN_ID}`, type: 'mindmap', id: MM_EIGEN_ID, title: '第 5 章 · 特征值与特征向量', pinned: false },
  ],
  activeTabKey: `note:${NOTE_EIGEN_ID}`,
  rightTabKey: null,
  focusedPane: 'main',
  splitLayout: [50, 50],
  // 窄屏下链接面板是覆盖层，会盖住正文；只在宽窗口默认展开
  backlinksOpen: typeof window !== 'undefined' && window.innerWidth >= 900,
  explorerOpen: true,
  collapsedFolderPaths: [],
};

const pack: DemoAppPack = {
  title: '笔记',
  load: async () => {
    const [{ default: NotesWorkspaceApp }, { createNotesDemoWindow }] = await Promise.all([
      import('@/features/workbench/apps/notes/NotesWorkspaceApp'),
      import('./notes/NotesDemoWindow'),
    ]);
    return createNotesDemoWindow(NotesWorkspaceApp);
  },
  instanceKey: NOTE_EIGEN_ID,
  launchPayload: { resourceType: 'note', resourceId: NOTE_EIGEN_ID },
  handle: handleDemoNotes,
  localStorage: {
    'workbench.notesWorkspace.state.v1': JSON.stringify(WORKSPACE_STATE),
  },
  namespaces: ['common', 'notes', 'workbench', 'mindmap', 'vfs', 'dstu', 'backend_errors', 'graph_conflict', 'app_menu', 'translation'],
  prepare: patchSettingsStrings,
};

export default pack;
