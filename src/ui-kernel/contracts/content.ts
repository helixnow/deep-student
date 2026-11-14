import type { ComponentType, ReactNode } from 'react';
import type { LearningHubContextMenuProps } from '@/features/learning-hub/components/LearningHubContextMenu';
import type { ResourceListItem } from '@/features/learning-hub/types';
import type { VfsFolderItem } from '@/dstu/types/folder';
import type { DstuNodeType, DstuPreviewType } from '@/dstu/types';
import type { RendererCapabilities } from '@/features/chat/components/renderers/rendererCapabilities';
import type { RichCodeRendererKind } from '@/features/chat/components/renderers/RichCodeRenderer';

/** Markdown's existing pre/code boundary; the original CodeBlock owns its own previews. */
export interface MarkdownCodeBlockProps {
  codeContent: string;
  className?: string;
  inline?: boolean;
  placement: 'pre' | 'code';
  renderMath: (value: string, displayMode: boolean) => ReactNode;
}

export interface MarkdownCodeBlockContribution {
  matches: (props: MarkdownCodeBlockProps) => boolean;
  component: ComponentType<MarkdownCodeBlockProps>;
}

/** The shared CodeBlock retains the existing preview/control state machine. */
export interface CodeBlockLanguageContribution {
  codeBlock: {
    kind: 'mermaid' | 'svg' | 'html' | 'xml' | 'rich';
    capability?: keyof RendererCapabilities;
    richRendererKind?: RichCodeRendererKind;
  };
}

export type ContentCodeBlockContribution = MarkdownCodeBlockContribution | CodeBlockLanguageContribution;

export type ContentMenuIcon = 'FolderPlus' | 'FileText' | 'ArrowClockwise' | 'Pencil' | 'Trash'
  | 'ArrowSquareOut' | 'Chat' | 'FolderOpen' | 'Copy' | 'Clipboard' | 'ArrowCounterClockwise'
  | 'Warning' | 'Star' | 'StarHalf' | 'CheckCircle' | 'Cards';

/** Learning hub (resource library / Finder) menu surfaces. */
export type LearningHubMenuScope = 'empty' | 'folder' | 'resource' | 'trash-empty' | 'trash-item';
/** Every surface that renders `resource.contextMenu`. */
export type ResourceMenuScope = LearningHubMenuScope | NotesTreeMenuContext['scope'];

export interface ContentMenuContext extends LearningHubContextMenuProps {
  closeMenu: () => void;
  scope: LearningHubMenuScope;
  folderId: string | null;
  resource?: ResourceListItem | VfsFolderItem;
  resourceItem: ResourceListItem | null;
  isFolder: boolean;
  isAddedToDesktop: boolean;
  trashId: string;
  trashItemType: string;
  addFolderShortcut: (id: string, title: string, path?: string) => unknown;
  addResourceShortcut: (id: string, title: string, type: DstuNodeType, path?: string) => unknown;
}

/** A row of the notes workspace tree (`NotesWorkspaceTreeItem` without the children). */
export interface NotesTreeMenuItem {
  id: string;
  name: string;
  kind: 'folder' | 'note' | 'mindmap';
  favorite?: boolean;
  path?: string;
  canRename?: boolean;
  canMove?: boolean;
}

/** What the notes workspace instance lets menu rows do; one object per open workspace. */
export interface NotesTreeMenuActions {
  open(item: NotesTreeMenuItem): void;
  openInSplit(item: NotesTreeMenuItem): void;
  isFavorite(item: NotesTreeMenuItem): boolean;
  setFavorite(item: NotesTreeMenuItem, favorite: boolean): void;
  createResource(kind: 'note' | 'mindmap', folderId: string | null): void;
  createFolder(parentId: string | null): void;
  createLearningNote(folderId: string | null): void;
  requestDelete(item: NotesTreeMenuItem): void;
}

/** The notes workspace tree (`NotesWorkspaceApp`). Labels resolve in the `workbench` namespace. */
export interface NotesTreeMenuContext {
  scope: 'notes-tree';
  closeMenu: () => void;
  item: NotesTreeMenuItem;
  /** Starts inline rename of `item` (same as F2). */
  beginRename: () => void;
  /** Folder that "new …" rows create in: the item itself for folders, otherwise its parent. */
  createFolderId: string | null;
  /** False for system folders that cannot be deleted. */
  canDelete: boolean;
  actions: NotesTreeMenuActions;
}

export type ResourceMenuContext = ContentMenuContext | NotesTreeMenuContext;
export type ResourceMenuContextOf<S extends ResourceMenuScope> = Extract<ResourceMenuContext, { scope: S }>;

/** Checked like a method (bivariantly), so a row for one surface still fits the slot's row type. */
type MenuCallback<C, R> = { bivarianceHack(context: C): R }['bivarianceHack'];

/** One menu row, evaluated against the context of the surface that opened the menu. */
export interface ResourceMenuRow<C> {
  id: string;
  order: number;
  visible(context: C): boolean;
  separator?: boolean;
  labelKey?: string | MenuCallback<C, string>;
  labelParams?(context: C): Record<string, unknown>;
  icon?: ContentMenuIcon | MenuCallback<C, ContentMenuIcon | undefined>;
  iconClassName?(context: C): string | undefined;
  disabled?(context: C): boolean;
  danger?: boolean;
  run?(context: C): void;
}

/** A learning hub row (no `scopes`). Its `visible` must check `context.scope`, as the official rows do. */
export type ContentMenuContribution = ResourceMenuRow<ContentMenuContext>;

/**
 * A row for the listed surfaces. The kernel only shows it there: `visible` is false on every other surface, so the
 * other callbacks always receive a context of one of `scopes`.
 */
export interface ScopedResourceMenuContribution<S extends ResourceMenuScope = ResourceMenuScope>
  extends ResourceMenuRow<ResourceMenuContextOf<S>> {
  scopes: readonly S[];
}

/** What the slot holds. Not `ScopedResourceMenuContribution<ResourceMenuScope>`: instances of that generic compare invariantly in `S`. */
export type ResourceMenuContribution =
  | ContentMenuContribution
  | (ResourceMenuRow<ResourceMenuContext> & { scopes: readonly ResourceMenuScope[] });

/** An operation a resource kind supports. Consumers look it up in `resource.types` instead of switching on the type. */
export type ResourceOperation =
  | 'open'
  | 'preview'
  | 'rename'
  | 'move'
  | 'delete'
  | 'copy'
  | 'favorite'
  | 'add-to-chat'
  | 'add-to-desktop';

/** One resource kind (learning hub / notes tree / desktop / chat reference), keyed by its `type` in `resource.types`. */
export interface ResourceTypeDefinition {
  /** A `DstuNodeType` value, or a kind owned by a plugin (e.g. `acme.flashcard`). */
  type: string;
  /** i18n key of the singular label; a key without ":" resolves in the contributor's namespace. */
  labelKey: string;
  /** Menu icon, the same set `resource.contextMenu` rows use. */
  icon?: ContentMenuIcon;
  order?: number;
  /** The preview panel for this kind; `'none'` means there is no preview panel. */
  preview?: DstuPreviewType | 'none';
  /** Operations the kind supports; hosts treat anything not listed as unsupported. */
  operations: readonly ResourceOperation[];
}

declare module '../slot-map' {
  interface SlotMap {
    'markdown.codeBlocks': ContentCodeBlockContribution;
    'resource.contextMenu': ResourceMenuContribution;
    'resource.types': ResourceTypeDefinition;
  }
}
