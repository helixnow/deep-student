import type { DstuNodeType } from '@/dstu/types';

export type FinderViewKind =
  | 'folder'
  | 'favorites'
  | 'recent'
  | 'trash'
  | 'indexStatus'
  | 'memory'
  | 'desktop';

export type QuickAccessType =
  | 'allFiles'
  | 'favorites'
  | 'notes'
  | 'textbooks'
  | 'exams'
  | 'essays'
  | 'translations'
  | 'images'
  | 'files'
  | 'mindmaps'
  | 'recent'
  | 'trash'
  | 'indexStatus'
  | 'memory'
  | 'desktop';

export interface FinderPathLike {
  viewKind: FinderViewKind;
  folderId: string | null;
  typeFilter: DstuNodeType | null;
}

export interface ViewCapabilities {
  canCreate: boolean;
  canDragDrop: boolean;
  canDelete: boolean;
  canMove: boolean;
  canSearch: boolean;
  canAddToChat: boolean;
}

export interface ResourceLocator {
  sourceId?: string;
  resourceId?: string;
  resourceType?: string;
  title?: string;
  path?: string;
}

export const SPECIAL_VIEW_KINDS: readonly FinderViewKind[] = [
  'favorites',
  'recent',
  'trash',
  'indexStatus',
  'memory',
  'desktop',
] as const;

export const VIEW_CAPABILITY_MATRIX: Record<FinderViewKind, ViewCapabilities> = {
  folder: {
    canCreate: true,
    canDragDrop: true,
    canDelete: true,
    canMove: true,
    canSearch: true,
    canAddToChat: true,
  },
  favorites: {
    canCreate: false,
    canDragDrop: false,
    canDelete: true,
    canMove: true,
    canSearch: true,
    canAddToChat: true,
  },
  recent: {
    canCreate: false,
    canDragDrop: false,
    canDelete: true,
    canMove: true,
    canSearch: true,
    canAddToChat: true,
  },
  trash: {
    canCreate: false,
    canDragDrop: false,
    canDelete: true,
    canMove: false,
    canSearch: true,
    canAddToChat: false,
  },
  indexStatus: {
    canCreate: false,
    canDragDrop: false,
    canDelete: false,
    canMove: false,
    canSearch: false,
    canAddToChat: false,
  },
  memory: {
    canCreate: false,
    canDragDrop: false,
    canDelete: false,
    canMove: false,
    canSearch: false,
    canAddToChat: false,
  },
  desktop: {
    canCreate: false,
    canDragDrop: false,
    canDelete: false,
    canMove: false,
    canSearch: false,
    canAddToChat: false,
  },
};

const QUICK_ACCESS_TARGETS: Record<QuickAccessType, Pick<FinderPathLike, 'viewKind' | 'typeFilter'>> = {
  allFiles: { viewKind: 'folder', typeFilter: null },
  favorites: { viewKind: 'favorites', typeFilter: null },
  notes: { viewKind: 'folder', typeFilter: 'note' },
  textbooks: { viewKind: 'folder', typeFilter: 'textbook' },
  exams: { viewKind: 'folder', typeFilter: 'exam' },
  essays: { viewKind: 'folder', typeFilter: 'essay' },
  translations: { viewKind: 'folder', typeFilter: 'translation' },
  images: { viewKind: 'folder', typeFilter: 'image' },
  files: { viewKind: 'folder', typeFilter: 'file' },
  mindmaps: { viewKind: 'folder', typeFilter: 'mindmap' },
  recent: { viewKind: 'recent', typeFilter: null },
  trash: { viewKind: 'trash', typeFilter: null },
  indexStatus: { viewKind: 'indexStatus', typeFilter: null },
  memory: { viewKind: 'memory', typeFilter: null },
  desktop: { viewKind: 'desktop', typeFilter: null },
};

const QUICK_ACCESS_BY_VIEW_KIND: Partial<Record<FinderViewKind, QuickAccessType>> = {
  favorites: 'favorites',
  recent: 'recent',
  trash: 'trash',
  indexStatus: 'indexStatus',
  memory: 'memory',
  desktop: 'desktop',
};

const QUICK_ACCESS_BY_TYPE_FILTER: Partial<Record<DstuNodeType, QuickAccessType>> = {
  note: 'notes',
  textbook: 'textbooks',
  exam: 'exams',
  essay: 'essays',
  translation: 'translations',
  image: 'images',
  file: 'files',
  mindmap: 'mindmaps',
};

export function isSpecialViewKind(viewKind: FinderViewKind): boolean {
  return SPECIAL_VIEW_KINDS.includes(viewKind);
}

export function getViewCapabilities(viewKind: FinderViewKind): ViewCapabilities {
  return VIEW_CAPABILITY_MATRIX[viewKind];
}

export function getQuickAccessTarget(type: QuickAccessType): Pick<FinderPathLike, 'viewKind' | 'typeFilter'> {
  return QUICK_ACCESS_TARGETS[type];
}

export function getQuickAccessTypeFromPath(path: FinderPathLike): QuickAccessType | undefined {
  if (path.viewKind !== 'folder') {
    return QUICK_ACCESS_BY_VIEW_KIND[path.viewKind];
  }

  if (path.folderId) {
    return undefined;
  }

  if (path.typeFilter) {
    return QUICK_ACCESS_BY_TYPE_FILTER[path.typeFilter];
  }

  return 'allFiles';
}

export function getFinderPathDisplayPath(path: FinderPathLike & { breadcrumbs?: Array<{ dstuPath?: string }> }): string {
  if (path.viewKind === 'favorites') return '/@favorites';
  if (path.viewKind === 'recent') return '/@recent';
  if (path.viewKind === 'trash') return '/@trash';
  if (path.viewKind === 'indexStatus') return '/@indexStatus';
  if (path.viewKind === 'memory') return '/@memory';
  if (path.viewKind === 'desktop') return '/@desktop';
  if (path.breadcrumbs && path.breadcrumbs.length > 0) {
    return path.breadcrumbs[path.breadcrumbs.length - 1]?.dstuPath || '/';
  }
  return '/';
}

export function canLocateResource(locator: ResourceLocator | null | undefined): boolean {
  if (!locator) return false;
  return Boolean(locator.sourceId || locator.resourceId || locator.path);
}
