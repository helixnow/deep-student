/** Study Space profiles, zero-copy cross-space mounts, and semantic anchor edges. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsFolder } from './core.ts';

export type StudySpaceMemoryScope =
  | 'space_isolated'
  | 'space_and_global'
  | 'global_only';

export type WorkbenchLayoutPreset =
  | 'chat_focus'
  | 'split_reader_chat'
  | 'split_notes_chat'
  | 'practice_review'
  | 'freeform_desktop';

export type SpaceMountItemType =
  | 'note'
  | 'exam'
  | 'file'
  | 'image'
  | 'translation'
  | 'essay'
  | 'mindmap'
  | 'folder';

export interface StudySpaceProfile {
  spaceId: string;
  rootFolderId: string;
  examDate: string | null;
  dailyBudgetMinutes: number;
  targetRetention: number;
  workbenchLayoutPreset: string;
  defaultDeckId: string | null;
  memoryScope: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertStudySpaceProfileInput {
  spaceId: string;
  rootFolderId: string;
  examDate?: string | null;
  dailyBudgetMinutes?: number | null;
  targetRetention?: number | null;
  workbenchLayoutPreset?: string | null;
  defaultDeckId?: string | null;
  memoryScope?: string | null;
}

export interface StudySpaceMount {
  id: string;
  spaceId: string;
  targetFolderId: string;
  itemType: string;
  itemId: string;
  createdAt: string;
}

export interface CreateSpaceMountInput {
  spaceId: string;
  targetFolderId: string;
  itemType: string;
  itemId: string;
}

export interface RemoveSpaceMountInput {
  mountId?: string | null;
  targetFolderId?: string | null;
  itemType?: string | null;
  itemId?: string | null;
}

export interface ListSpaceMountsFilter {
  spaceId?: string | null;
  targetFolderId?: string | null;
  itemType?: string | null;
  itemId?: string | null;
}

export interface ResolvedMountScope {
  effectiveFolderIds: string[];
  mountedResourceIds: string[];
  mountedItemKeys: Set<string>;
}

export interface AnchorEdgeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnchorEdgeAnchorObject {
  kind: string;
  resourceId: string;
  aliasResourceId?: string | null;
  label?: string | null;
  page?: number | null;
  rect?: AnchorEdgeRect | null;
  quote?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  blockId?: string | null;
  heading?: string | null;
  nodeId?: string | null;
  questionId?: string | null;
  cfi?: string | null;
  namespace?: string | null;
  locator?: string | null;
}

export interface AnchorEdgeWireInput {
  edgeId?: string | null;
  sourceKind: string;
  sourceResourceId: string;
  sourceSubId?: string | null;
  sourceAnchorUri?: string | null;
  sourceAnchor?: AnchorEdgeAnchorObject | null;
  sourceLabel?: string | null;
  targetKind?: string | null;
  targetResourceId?: string | null;
  targetLocatorKey?: string | null;
  targetPage?: number | null;
  targetStartMs?: number | null;
  targetEndMs?: number | null;
  targetRect?: AnchorEdgeRect | null;
  targetRectJson?: string | null;
  targetAnchorUri?: string | null;
  targetAnchor?: AnchorEdgeAnchorObject | null;
  studySpaceId?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface AnchorEdgeRecord {
  edgeId: string;
  sourceKind: string;
  sourceResourceId: string;
  sourceSubId: string;
  sourceAnchorUri: string;
  sourceLabel: string;
  targetKind: string;
  targetResourceId: string;
  targetLocatorKey: string;
  targetPage: number | null;
  targetStartMs: number | null;
  targetEndMs: number | null;
  targetRect: AnchorEdgeRect | null;
  targetAnchorUri: string;
  studySpaceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AnchorEdgesUpsertResult {
  upserted: number;
}

export interface AnchorEdgesDeleteResult {
  deleted: number;
}

export interface InboxFolderInfo {
  id: string;
  title: string;
}

export type InboxFolderSummary = InboxFolderInfo;

export interface StudySpaceRepository {
  ensureInboxFolder(conn: SqlExecutor): VfsFolder;
  getProfile(conn: SqlExecutor, spaceId: string): StudySpaceProfile | null;
  listProfiles(conn: SqlExecutor): StudySpaceProfile[];
  upsertProfile(conn: SqlExecutor, input: UpsertStudySpaceProfileInput): StudySpaceProfile;
  deleteProfile(conn: SqlExecutor, spaceId: string): boolean;
  listMounts(conn: SqlExecutor, filter?: ListSpaceMountsFilter): StudySpaceMount[];
  addMount(conn: SqlExecutor, input: CreateSpaceMountInput): StudySpaceMount;
  removeMount(conn: SqlExecutor, input: RemoveSpaceMountInput): boolean;
  resolveMountScopeForFolders(conn: SqlExecutor, folderIds: readonly string[]): ResolvedMountScope;
  upsertAnchorEdges(conn: SqlExecutor, edges: readonly AnchorEdgeWireInput[]): AnchorEdgesUpsertResult;
  deleteAnchorEdgesBySource(
    conn: SqlExecutor,
    sourceKind: string,
    sourceResourceId: string,
    keepEdgeIds?: readonly string[] | null,
  ): AnchorEdgesDeleteResult;
  queryAnchorEdgesByTarget(
    conn: SqlExecutor,
    targetResourceIds: readonly string[],
    targetKind?: string | null,
  ): AnchorEdgeRecord[];
}
