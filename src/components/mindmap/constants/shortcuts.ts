/**
 * 快捷键定义
 */

/** 快捷键动作 */
export type ShortcutAction = 
  | 'addSibling'
  | 'addChild'
  | 'delete'
  | 'edit'
  | 'indent'
  | 'outdent'
  | 'moveUp'
  | 'moveDown'
  | 'collapse'
  | 'expand'
  | 'collapseAll'
  | 'expandAll'
  | 'undo'
  | 'redo'
  | 'search'
  | 'save'
  | 'copy'
  | 'paste'
  | 'cut'
  | 'selectAll'
  | 'escape'
  | 'focusParent'
  | 'focusFirstChild';

/** 快捷键映射 */
export const SHORTCUTS: Record<ShortcutAction, string[]> = {
  // 节点操作
  addSibling: ['Enter'],
  addChild: ['Tab', 'mod+Enter'],
  delete: ['Backspace', 'Delete'],
  edit: ['F2', 'Space'],
  
  // 层级操作
  indent: ['Tab'],
  outdent: ['shift+Tab'],
  
  // 移动操作
  moveUp: ['mod+ArrowUp'],
  moveDown: ['mod+ArrowDown'],
  
  // 折叠操作
  collapse: ['mod+['],
  expand: ['mod+]'],
  collapseAll: ['mod+shift+['],
  expandAll: ['mod+shift+]'],
  
  // 历史操作
  undo: ['mod+z'],
  redo: ['mod+shift+z', 'mod+y'],
  
  // 搜索
  search: ['mod+f'],
  
  // 保存
  save: ['mod+s'],
  
  // 剪贴板
  copy: ['mod+c'],
  paste: ['mod+v'],
  cut: ['mod+x'],
  
  // 选择
  selectAll: ['mod+a'],
  escape: ['Escape'],
  
  // 导航
  focusParent: ['mod+ArrowLeft'],
  focusFirstChild: ['mod+ArrowRight'],
};

/** 大纲视图专用快捷键 */
export const OUTLINE_SHORTCUTS: Partial<Record<ShortcutAction, string[]>> = {
  indent: ['Tab'],
  outdent: ['shift+Tab'],
  addSibling: ['Enter'],
  addChild: ['mod+Enter'],
};

/** 导图视图专用快捷键 */
export const MINDMAP_SHORTCUTS: Partial<Record<ShortcutAction, string[]>> = {
  addSibling: ['Enter'],
  addChild: ['Tab', 'mod+Enter'],
  delete: ['Backspace', 'Delete'],
  edit: ['F2', 'Space'],
  moveUp: ['mod+ArrowUp'],
  moveDown: ['mod+ArrowDown'],
  collapse: ['mod+['],
  expand: ['mod+]'],
  undo: ['mod+z'],
  redo: ['mod+shift+z', 'mod+y'],
  save: ['mod+s'],
  copy: ['mod+c'],
  paste: ['mod+v'],
  cut: ['mod+x'],
  escape: ['Escape'],
  focusParent: ['ArrowLeft'],
  focusFirstChild: ['ArrowRight'],
};

