/**
 * 笔记模块命令
 * P1-16: 笔记功能已整合到 Learning Hub，在 learning-hub 视图可用
 */

import i18next from 'i18next';
import {
  FilePlus,
  FolderPlus,
  Search,
  Save,
  PanelLeft,
  List,
  FileOutput,
  Files,
  Wand2,
  Calculator,
  Table,
  Code,
  Link,
  Image,
} from 'lucide-react';
import type { Command } from '../registry/types';

/** Helper: get localized keywords array for a given command key */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

export const notesCommands: Command[] = [
  {
    id: 'notes.new',
    get name() { return i18next.t('command_palette:commands.notes.new', 'New Note'); },
    get description() { return i18next.t('command_palette:descriptions.notes.new', 'Create a new note'); },
    category: 'notes',
    shortcut: 'mod+n',
    icon: FilePlus,
    get keywords() { return kw('notes.new'); },
    priority: 100,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_CREATE_NEW'));
    },
  },
  {
    id: 'notes.new-folder',
    get name() { return i18next.t('command_palette:commands.notes.new-folder', 'New Folder'); },
    get description() { return i18next.t('command_palette:descriptions.notes.new-folder', 'Create a new folder'); },
    category: 'notes',
    shortcut: 'mod+shift+n',
    icon: FolderPlus,
    get keywords() { return kw('notes.new-folder'); },
    priority: 99,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_CREATE_FOLDER'));
    },
  },
  {
    id: 'notes.search',
    get name() { return i18next.t('command_palette:commands.notes.search', 'Search Notes'); },
    get description() { return i18next.t('command_palette:descriptions.notes.search', 'Focus sidebar search box'); },
    category: 'notes',
    shortcut: 'mod+shift+f',
    icon: Search,
    get keywords() { return kw('notes.search'); },
    priority: 98,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_FOCUS_SEARCH'));
    },
  },
  {
    id: 'notes.save',
    get name() { return i18next.t('command_palette:commands.notes.save', 'Save Note'); },
    get description() { return i18next.t('command_palette:descriptions.notes.save', 'Force save current note'); },
    category: 'notes',
    shortcut: 'mod+s',
    icon: Save,
    get keywords() { return kw('notes.save'); },
    priority: 97,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_FORCE_SAVE'));
    },
  },
  {
    id: 'notes.toggle-sidebar',
    get name() { return i18next.t('command_palette:commands.notes.toggle-sidebar', 'Toggle Sidebar'); },
    get description() { return i18next.t('command_palette:descriptions.notes.toggle-sidebar', 'Show/hide notes sidebar'); },
    category: 'notes',
    shortcut: 'mod+\\',
    icon: PanelLeft,
    get keywords() { return kw('notes.toggle-sidebar'); },
    priority: 90,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_TOGGLE_SIDEBAR'));
    },
  },
  {
    id: 'notes.toggle-outline',
    get name() { return i18next.t('command_palette:commands.notes.toggle-outline', 'Toggle Outline Panel'); },
    get description() { return i18next.t('command_palette:descriptions.notes.toggle-outline', 'Show/hide document outline panel'); },
    category: 'notes',
    shortcut: 'mod+shift+o',
    icon: List,
    get keywords() { return kw('notes.toggle-outline'); },
    priority: 89,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_TOGGLE_OUTLINE'));
    },
  },
  {
    id: 'notes.export-current',
    get name() { return i18next.t('command_palette:commands.notes.export-current', 'Export Current Note'); },
    get description() { return i18next.t('command_palette:descriptions.notes.export-current', 'Export current note as file'); },
    category: 'notes',
    icon: FileOutput,
    get keywords() { return kw('notes.export-current'); },
    priority: 80,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_EXPORT_CURRENT'));
    },
  },
  {
    id: 'notes.export-all',
    get name() { return i18next.t('command_palette:commands.notes.export-all', 'Export All Notes'); },
    get description() { return i18next.t('command_palette:descriptions.notes.export-all', 'Export all notes'); },
    category: 'notes',
    icon: Files,
    get keywords() { return kw('notes.export-all'); },
    priority: 79,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_EXPORT_ALL'));
    },
  },
  {
    id: 'notes.ai-continue',
    get name() { return i18next.t('command_palette:commands.notes.ai-continue', 'AI Continue Writing'); },
    get description() { return i18next.t('command_palette:descriptions.notes.ai-continue', 'Let AI continue writing'); },
    category: 'notes',
    shortcut: 'mod+j',
    icon: Wand2,
    get keywords() { return kw('notes.ai-continue'); },
    priority: 85,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('AI_CONTINUE_WRITING'));
    },
  },
  {
    id: 'notes.insert-math',
    get name() { return i18next.t('command_palette:commands.notes.insert-math', 'Insert Math Formula'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-math', 'Insert LaTeX math formula'); },
    category: 'notes',
    shortcut: 'mod+m',
    icon: Calculator,
    get keywords() { return kw('notes.insert-math'); },
    priority: 70,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_INSERT_MATH'));
    },
  },
  {
    id: 'notes.insert-table',
    get name() { return i18next.t('command_palette:commands.notes.insert-table', 'Insert Table'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-table', 'Insert a table'); },
    category: 'notes',
    shortcut: 'mod+shift+e', // 修改为 mod+shift+e，避免与全局 mod+shift+t (切换主题) 冲突
    icon: Table,
    get keywords() { return kw('notes.insert-table'); },
    priority: 69,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_INSERT_TABLE'));
    },
  },
  {
    id: 'notes.insert-codeblock',
    get name() { return i18next.t('command_palette:commands.notes.insert-codeblock', 'Insert Code Block'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-codeblock', 'Insert a code block'); },
    category: 'notes',
    shortcut: 'mod+shift+c',
    icon: Code,
    get keywords() { return kw('notes.insert-codeblock'); },
    priority: 68,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_INSERT_CODEBLOCK'));
    },
  },
  {
    id: 'notes.insert-link',
    get name() { return i18next.t('command_palette:commands.notes.insert-link', 'Insert Link'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-link', 'Insert a hyperlink'); },
    category: 'notes',
    icon: Link,
    get keywords() { return kw('notes.insert-link'); },
    priority: 67,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_INSERT_LINK'));
    },
  },
  {
    id: 'notes.insert-image',
    get name() { return i18next.t('command_palette:commands.notes.insert-image', 'Insert Image'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-image', 'Insert an image'); },
    category: 'notes',
    icon: Image,
    get keywords() { return kw('notes.insert-image'); },
    priority: 66,
    visibleInViews: ['learning-hub'],
    execute: () => {
      window.dispatchEvent(new CustomEvent('NOTES_INSERT_IMAGE'));
    },
  },
];
