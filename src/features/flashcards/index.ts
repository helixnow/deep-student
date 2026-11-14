/**
 * Public cross-feature barrel for `src/features/flashcards`.
 *
 * Exposes flashcard invalidation events and the Image Occlusion builder modal/trigger
 * so peer features (`src/features/notes/**`, etc.) comply with `check-frontend-layers.mjs`.
 */
export {
  FLASHCARDS_CHANGED_EVENT,
  FSRS_LIBRARY_REFRESH_EVENT,
  FSRS_STATS_REFRESH_EVENT,
  emitFlashcardsChanged,
  requestFlashcardsDueRefresh,
  subscribeFlashcardsDueRefresh,
} from './events';

export {
  ImageOcclusionBuilderModal,
  OPEN_IMAGE_OCCLUSION_BUILDER_EVENT,
  openImageOcclusionBuilder,
  type ImageOcclusionBuilderModalProps,
  type OpenImageOcclusionBuilderDetail,
} from './occlusion/ImageOcclusionBuilderModal';
