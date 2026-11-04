export {
  registerContentDirtyChecker,
  isContentDirty,
  isAnyContentDirty,
  listDirtyContentKeys,
  registerContentSaveHandler,
  hasContentSaveHandler,
  saveContentNow,
  flushAllDirtyContent,
  __resetContentDirtyRegistry,
} from '@/services/contentDirtyRegistry';
export type { ContentSaveState } from '@/services/contentDirtyRegistry';
