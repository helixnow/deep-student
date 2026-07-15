/**
 * Notes commands shared by the legacy Learning Hub and the Workbench Notes app.
 */

import i18next from 'i18next';
import {
  FilePlus,
  FolderPlus,
  MagnifyingGlass,
  FloppyDisk,
  SidebarSimple,
  List,
  FileArrowDown,
  Calculator,
  Table,
  Code,
  Link,
  Image,
} from '@phosphor-icons/react';
import { getWorkspaceActiveResource } from '@/features/workbench/apps/notes/workspaceRegistry';
import type { Command, CommandView, DependencyResolver } from '../registry/types';

export const NOTES_WORKSPACE_COMMAND_EVENT = 'notes:workspace-command' as const;

export type NotesWorkspaceCommandAction =
  | 'create-note'
  | 'create-folder'
  | 'quick-switch'
  | 'search-content'
  | 'focus-search'
  | 'force-save'
  | 'toggle-sidebar'
  | 'toggle-backlinks'
  | 'toggle-outline'
  | 'export-current'
  | 'insert-math'
  | 'insert-table'
  | 'insert-codeblock'
  | 'insert-link'
  | 'insert-image';

export interface NotesWorkspaceCommandDetail {
  action: NotesWorkspaceCommandAction;
}

const NOTES_COMMAND_VIEWS: CommandView[] = ['learning-hub', 'workbench'];

/** Helper: get localized keywords array for a given command key. */
const kw = (key: string): string[] =>
  i18next.t(`command_palette:keywords.${key}`, { returnObjects: true, defaultValue: [] }) as string[];

function isNotesCommandEnabled(deps: DependencyResolver): boolean {
  const view = deps.getCurrentView();
  return view === 'learning-hub'
    || (view === 'workbench' && deps.getFocusedWorkbenchAppTypeId() === 'notes');
}

/** Commands that operate on the Markdown editor must not appear actionable for a mind map tab. */
function isNoteEditorCommandEnabled(deps: DependencyResolver): boolean {
  if (!isNotesCommandEnabled(deps)) return false;
  if (deps.getCurrentView() !== 'workbench') return true;
  return getWorkspaceActiveResource()?.type === 'note';
}

function isWorkbenchNotesCommandEnabled(deps: DependencyResolver): boolean {
  return deps.getCurrentView() === 'workbench'
    && deps.getFocusedWorkbenchAppTypeId() === 'notes';
}

function dispatchNotesCommand(
  deps: DependencyResolver,
  legacyEvent: string,
  action: NotesWorkspaceCommandAction,
): void {
  const view = deps.getCurrentView();
  if (view === 'workbench') {
    if (deps.getFocusedWorkbenchAppTypeId() !== 'notes') return;
    window.dispatchEvent(
      new CustomEvent<NotesWorkspaceCommandDetail>(NOTES_WORKSPACE_COMMAND_EVENT, {
        detail: { action },
      }),
    );
    return;
  }

  if (view === 'learning-hub' && legacyEvent) {
    window.dispatchEvent(new CustomEvent(legacyEvent));
  }
}

const notesCommandScope = {
  visibleInViews: NOTES_COMMAND_VIEWS,
  isEnabled: isNotesCommandEnabled,
};

const noteEditorCommandScope = {
  visibleInViews: NOTES_COMMAND_VIEWS,
  isEnabled: isNoteEditorCommandEnabled,
};

const workbenchNotesCommandScope = {
  visibleInViews: ['workbench'] satisfies CommandView[],
  isEnabled: isWorkbenchNotesCommandEnabled,
};

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
    ...notesCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_CREATE_NEW', 'create-note'),
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
    ...notesCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_CREATE_FOLDER', 'create-folder'),
  },
  {
    id: 'notes.quick-switch',
    get name() { return i18next.t('command_palette:commands.notes.quick-switch', 'Quick switcher'); },
    get description() { return i18next.t('command_palette:descriptions.notes.quick-switch', 'Quickly open a note or mind map'); },
    category: 'notes',
    shortcut: 'mod+o',
    icon: MagnifyingGlass,
    get keywords() { return kw('notes.quick-switch'); },
    priority: 99,
    ...workbenchNotesCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, '', 'quick-switch'),
  },
  {
    id: 'notes.search',
    get name() { return i18next.t('command_palette:commands.notes.search', 'Search Notes'); },
    get description() { return i18next.t('command_palette:descriptions.notes.search', 'Search notes or filter files'); },
    category: 'notes',
    shortcut: 'mod+shift+f',
    icon: MagnifyingGlass,
    get keywords() { return kw('notes.search'); },
    priority: 98,
    ...notesCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_FOCUS_SEARCH', 'search-content'),
  },
  {
    id: 'notes.save',
    get name() { return i18next.t('command_palette:commands.notes.save', 'Save Note'); },
    get description() { return i18next.t('command_palette:descriptions.notes.save', 'Force save current note'); },
    category: 'notes',
    shortcut: 'mod+s',
    icon: FloppyDisk,
    get keywords() { return kw('notes.save'); },
    priority: 97,
    ...noteEditorCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_FORCE_SAVE', 'force-save'),
  },
  {
    id: 'notes.toggle-sidebar',
    get name() { return i18next.t('command_palette:commands.notes.toggle-sidebar', 'Toggle Sidebar'); },
    get description() { return i18next.t('command_palette:descriptions.notes.toggle-sidebar', 'Show/hide notes sidebar'); },
    category: 'notes',
    shortcut: 'mod+\\',
    icon: SidebarSimple,
    get keywords() { return kw('notes.toggle-sidebar'); },
    priority: 90,
    ...notesCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_TOGGLE_SIDEBAR', 'toggle-sidebar'),
  },
  {
    id: 'notes.toggle-backlinks',
    get name() { return i18next.t('command_palette:commands.notes.toggle-backlinks', 'Toggle backlinks'); },
    get description() { return i18next.t('command_palette:descriptions.notes.toggle-backlinks', 'Show or hide linked notes'); },
    category: 'notes',
    icon: Link,
    get keywords() { return kw('notes.toggle-backlinks'); },
    priority: 89,
    ...workbenchNotesCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, '', 'toggle-backlinks'),
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
    ...noteEditorCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_TOGGLE_OUTLINE', 'toggle-outline'),
  },
  {
    id: 'notes.export-current',
    get name() { return i18next.t('command_palette:commands.notes.export-current', 'Export Current Note'); },
    get description() { return i18next.t('command_palette:descriptions.notes.export-current', 'Export current note as file'); },
    category: 'notes',
    icon: FileArrowDown,
    get keywords() { return kw('notes.export-current'); },
    priority: 80,
    ...notesCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_EXPORT_CURRENT', 'export-current'),
  },
  // notes.export-all is not implemented; do not register an actionable command.
  {
    id: 'notes.insert-math',
    get name() { return i18next.t('command_palette:commands.notes.insert-math', 'Insert Math Formula'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-math', 'Insert LaTeX math formula'); },
    category: 'notes',
    shortcut: 'mod+m',
    icon: Calculator,
    get keywords() { return kw('notes.insert-math'); },
    priority: 70,
    ...noteEditorCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_INSERT_MATH', 'insert-math'),
  },
  {
    id: 'notes.insert-table',
    get name() { return i18next.t('command_palette:commands.notes.insert-table', 'Insert Table'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-table', 'Insert a table'); },
    category: 'notes',
    shortcut: 'mod+shift+e',
    icon: Table,
    get keywords() { return kw('notes.insert-table'); },
    priority: 69,
    ...noteEditorCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_INSERT_TABLE', 'insert-table'),
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
    ...noteEditorCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_INSERT_CODEBLOCK', 'insert-codeblock'),
  },
  {
    id: 'notes.insert-link',
    get name() { return i18next.t('command_palette:commands.notes.insert-link', 'Insert Link'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-link', 'Insert a hyperlink'); },
    category: 'notes',
    icon: Link,
    get keywords() { return kw('notes.insert-link'); },
    priority: 67,
    ...noteEditorCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_INSERT_LINK', 'insert-link'),
  },
  {
    id: 'notes.insert-image',
    get name() { return i18next.t('command_palette:commands.notes.insert-image', 'Insert Image'); },
    get description() { return i18next.t('command_palette:descriptions.notes.insert-image', 'Insert an image'); },
    category: 'notes',
    icon: Image,
    get keywords() { return kw('notes.insert-image'); },
    priority: 66,
    ...noteEditorCommandScope,
    execute: (deps) => dispatchNotesCommand(deps, 'NOTES_INSERT_IMAGE', 'insert-image'),
  },
];
