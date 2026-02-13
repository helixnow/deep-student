/**
 * DSTU 适配器索引
 *
 * 提供各模块从旧 API 迁移到 DSTU API 的适配层
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 10
 */

// ============================================================================
// 笔记适配器
// ============================================================================

export {
  notesDstuAdapter,
  useNotesDstu,
  dstuNodeToNoteItem,
  noteItemToDstuNode,
  type UseNotesDstuOptions,
  type UseNotesDstuReturn,
} from './notesDstuAdapter';

// ============================================================================
// 教材适配器
// ============================================================================

export {
  textbookDstuAdapter,
  useTextbooksDstu,
  dstuNodeToTextbookItem,
  textbookItemToDstuNode,
  type TextbookItem,
  type UseTextbooksDstuOptions,
  type UseTextbooksDstuReturn,
} from './textbookDstuAdapter';

// ============================================================================
// 翻译适配器
// ============================================================================

export {
  translationDstuAdapter,
  useTranslationsDstu,
  dstuNodeToTranslationItem,
  translationItemToDstuNode,
  type UseTranslationsDstuOptions,
  type UseTranslationsDstuReturn,
} from './translationDstuAdapter';

// ============================================================================
// 题目集适配器
// ============================================================================

export {
  examDstuAdapter,
  useExamsDstu,
  dstuNodeToExamSession,
  examSessionToDstuNode,
  type ExamSheetSession,
  type UseExamsDstuOptions,
  type UseExamsDstuReturn,
} from './examDstuAdapter';

// ============================================================================
// 作文适配器
// ============================================================================

export {
  essayDstuAdapter,
  useEssaysDstu,
  dstuNodeToEssaySession,
  essaySessionToDstuNode,
  gradingSessionToDstuNode,
  type EssaySessionItem,
  type UseEssaysDstuOptions,
  type UseEssaysDstuReturn,
} from './essayDstuAdapter';

// ============================================================================
// 附件适配器
// ============================================================================

export {
  attachmentDstuAdapter,
  useAttachmentsDstu,
  dstuNodeToAttachment,
  attachmentToDstuNode,
  type AttachmentType,
  type AttachmentMetadata,
  type AttachmentItem,
  type UseAttachmentsDstuOptions,
  type UseAttachmentsDstuReturn,
} from './attachmentDstuAdapter';
