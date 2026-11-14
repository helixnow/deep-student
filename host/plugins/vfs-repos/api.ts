/**
 * L11 public repository contracts. Wire fields follow question_repo.rs and
 * path_cache_repo.rs.
 *
 * The contract surface is split by responsibility under `types/`; this module
 * stays the single stable import point for the rest of the host.
 */
export * from './types/common.ts';
export * from './types/core.ts';
export * from './types/content.ts';
export * from './types/indexing.ts';
export * from './types/files.ts';
export * from './types/questions.ts';
export * from './types/services.ts';
export * from './types/note-owner-writes.ts';
export * from './types/study-spaces.ts';
export { StudySpaceRepo, fnv1a64Hex } from './repository/study-spaces.ts';
export {
  DEFAULT_PDF_PREVIEW_CONFIG, type PdfPreviewConfig, type PdfPreviewResult,
} from './repository/pdf-preview.ts';
// dstu-core media_types.rs, shared so command lanes do not copy the routing.
export {
  AUDIO_EXTENSIONS, BILIBILI_LINK_EXTENSION, BILIBILI_LINK_MIME, VIDEO_EXTENSIONS, isLinkItem, mediaKind,
  type VfsMediaKind,
} from './src/media-kind.ts';

export { questionTypeFromStr, difficultyFromStr, questionStatusFromStr, sourceTypeFromStr } from './src/question-types.ts';
