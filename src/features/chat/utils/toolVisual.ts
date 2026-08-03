import {
  ArrowCounterClockwise,
  ArrowsLeftRight,
  Cards,
  ClockCountdown,
  Desktop,
  DownloadSimple,
  Exam,
  FileDoc,
  FileText,
  FileXls,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  Gear,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Plug,
  PresentationChart,
  Terminal,
  Trash,
  UploadSimple,
  Wrench,
  type Icon,
} from '@phosphor-icons/react';

export type ToolVisualKind =
  | 'resource'
  | 'folder'
  | 'search'
  | 'read'
  | 'create'
  | 'edit'
  | 'move'
  | 'delete'
  | 'restore'
  | 'transfer'
  | 'learning'
  | 'office'
  | 'automation'
  | 'workspace'
  | 'system'
  | 'default';

export interface ToolVisual {
  Icon: Icon;
  kind: ToolVisualKind;
  className: string;
  backgroundClassName: string;
}

const TOOL_VISUALS: Record<ToolVisualKind, ToolVisual> = {
  resource: { Icon: Files, kind: 'resource', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  folder: { Icon: Folder, kind: 'folder', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  search: { Icon: MagnifyingGlass, kind: 'search', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  read: { Icon: FileText, kind: 'read', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  create: { Icon: Plus, kind: 'create', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  edit: { Icon: PencilSimple, kind: 'edit', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  move: { Icon: ArrowsLeftRight, kind: 'move', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  delete: { Icon: Trash, kind: 'delete', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  restore: { Icon: ArrowCounterClockwise, kind: 'restore', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  transfer: { Icon: UploadSimple, kind: 'transfer', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  learning: { Icon: Exam, kind: 'learning', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  office: { Icon: FileText, kind: 'office', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  automation: { Icon: ClockCountdown, kind: 'automation', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  workspace: { Icon: Desktop, kind: 'workspace', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  system: { Icon: Gear, kind: 'system', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
  default: { Icon: Wrench, kind: 'default', className: 'text-muted-foreground', backgroundClassName: 'bg-muted/70 dark:bg-muted/40' },
};

function normalizedToolName(toolName: string | undefined): string {
  return (toolName ?? '')
    .toLowerCase()
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp[_.:-]/, '')
    .replace(/[.:/-]/g, '_');
}

/**
 * Resolves a stable semantic icon for tools users see in the chat timeline.
 * Specific object types take precedence over generic action verbs.
 */
export function getToolVisual(toolName: string | undefined): ToolVisual {
  const name = normalizedToolName(toolName);

  if (/(^|_)folder(_|$)/.test(name)) {
    if (/(^|_)folder_list($|_)/.test(name)) return { ...TOOL_VISUALS.folder, Icon: FolderOpen };
    if (/(^|_)create($|_)/.test(name)) return { ...TOOL_VISUALS.folder, Icon: FolderPlus };
    return TOOL_VISUALS.folder;
  }

  if (/(^|_)(qbank|exam)(_|$)/.test(name)) return TOOL_VISUALS.learning;
  if (/(^|_)(anki|chatanki)(_|$)/.test(name)) return { ...TOOL_VISUALS.learning, Icon: Cards };
  if (/(^|_)xlsx(_|$)/.test(name)) return { ...TOOL_VISUALS.office, Icon: FileXls };
  if (/(^|_)docx(_|$)/.test(name)) return { ...TOOL_VISUALS.office, Icon: FileDoc };
  if (/(^|_)(pptx|presentation)(_|$)/.test(name)) return { ...TOOL_VISUALS.office, Icon: PresentationChart };
  if (/(^|_)(automation|schedule)(_|$)/.test(name)) return TOOL_VISUALS.automation;
  if (/(^|_)(workspace|workbench)(_|$)/.test(name)) return TOOL_VISUALS.workspace;
  if (/(^|_)(shell|terminal)(_|$)/.test(name)) return { ...TOOL_VISUALS.workspace, Icon: Terminal };
  if (/(^|_)(settings|config|connector)(_|$)/.test(name)) {
    return name.includes('connector') ? { ...TOOL_VISUALS.system, Icon: Plug } : TOOL_VISUALS.system;
  }

  if (/(^|_)(search|query|find)(_|$)/.test(name)) return TOOL_VISUALS.search;
  if (/(^|_)(read|get|view|preview)(_|$)/.test(name)) return { ...TOOL_VISUALS.read, Icon: FileText };
  if (/(^|_)(create|add|new|generate)(_|$)/.test(name)) return TOOL_VISUALS.create;
  if (/(^|_)(update|write|edit|rename|set)(_|$)/.test(name)) return TOOL_VISUALS.edit;
  if (/(^|_)(move|reorder)(_|$)/.test(name)) return TOOL_VISUALS.move;
  if (/(^|_)(delete|remove|purge)(_|$)/.test(name)) return TOOL_VISUALS.delete;
  if (/(^|_)(restore|revert|undo)(_|$)/.test(name)) return TOOL_VISUALS.restore;
  if (/(^|_)(upload|import)(_|$)/.test(name)) return TOOL_VISUALS.transfer;
  if (/(^|_)(download|export)(_|$)/.test(name)) return { ...TOOL_VISUALS.transfer, Icon: DownloadSimple };
  if (/(^|_)(resource|dstu|file_list)(_|$)/.test(name)) return TOOL_VISUALS.resource;

  return TOOL_VISUALS.default;
}
