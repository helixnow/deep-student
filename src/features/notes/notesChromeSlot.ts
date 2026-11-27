import { createContext, useContext } from 'react';

/**
 * 宿主（学习资源标签栏等）提供的页面级操作位：笔记编辑器把「保存状态 · 阅读 · 页面」
 * 渲染进宿主的标签栏右侧，页面上方只剩一条栏（Notion 式），不再叠一行笔记 chrome。
 * 未提供（null / 无 Provider）时编辑器保留自己的 chrome 行。分屏时宿主应传 null。
 */
export const NotesChromeSlotContext = createContext<HTMLElement | null>(null);

export const useNotesChromeSlot = () => useContext(NotesChromeSlotContext);

/**
 * 可选：由多标签窗格按标签可见性提供，解耦「标签可见」与「窗口失焦」。
 * 为 null 时 NotesCrepeEditor 退回使用 isActive 判定是否占领顶栏操作位，
 * 避免 Notes 窗口失焦时「已保存 / 阅读 / 页面」从标题栏掉回正文上方引发跳动。
 */
export const NotesChromeSlotVisibleContext = createContext<boolean | null>(null);

export const useNotesChromeSlotVisible = () => useContext(NotesChromeSlotVisibleContext);
