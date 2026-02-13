/**
 * Chat V2 - 预定义上下文类型统一导出
 *
 * 包含所有预定义的上下文类型定义，并提供注册函数
 */

import type { ContextTypeDefinition } from '../types';

// 导出各类型定义
export { systemPromptDefinition, SYSTEM_PROMPT_TYPE_ID, createSystemPromptBlocks } from './systemPrompt';
export type { SystemPromptMetadata, SystemPromptSource } from './systemPrompt';

// ★ 2025-01-03: User Preference 类型已删除，由新的 User Memory 系统替代

export { noteDefinition, NOTE_TYPE_ID } from './note';
export type { NoteMetadata } from './note';

// ★ 2025-12-26: Card 类型已删除，不再使用

export { imageDefinition, IMAGE_TYPE_ID, SUPPORTED_IMAGE_TYPES, isSupportedImageType } from './image';
export type { ImageMetadata } from './image';

export { fileDefinition, FILE_TYPE_ID, SUPPORTED_TEXT_FILE_TYPES, isSupportedTextFileType } from './file';
export type { FileMetadata } from './file';

export { retrievalDefinition, RETRIEVAL_TYPE_ID, RETRIEVAL_SOURCES, isValidRetrievalSource } from './retrieval';
export type { RetrievalMetadata, RetrievalSource } from './retrieval';

export { textbookDefinition, TEXTBOOK_TYPE_ID, TEXTBOOK_TOOLS } from './textbook';
export type { TextbookMetadata } from './textbook';

export { examDefinition, EXAM_TYPE_ID, EXAM_TOOLS } from './exam';
export type { ExamMetadata } from './exam';

export { essayDefinition, ESSAY_TYPE_ID, ESSAY_TOOLS } from './essay';
export type { EssayMetadata } from './essay';

export { translationDefinition, TRANSLATION_TYPE_ID, TRANSLATION_TOOLS } from './translation';
export type { TranslationMetadata } from './translation';

export { folderDefinition, FOLDER_TYPE_ID, FOLDER_XML_TAG, FOLDER_TOOLS, getToolsForFolderResource } from './folder';
export type { FolderContextData, FolderResourceItem, FolderMetadata } from './folder';

// 导入所有定义
import { systemPromptDefinition } from './systemPrompt';
// ★ 2025-01-03: userPreferenceDefinition 已删除，由新的 User Memory 系统替代
import { noteDefinition } from './note';
// ★ 2025-12-26: Card 类型已删除
import { imageDefinition } from './image';
import { fileDefinition } from './file';
import { retrievalDefinition } from './retrieval';
import { textbookDefinition } from './textbook';
import { examDefinition } from './exam';
import { essayDefinition } from './essay';
import { translationDefinition } from './translation';
import { folderDefinition } from './folder';

/**
 * 所有预定义类型定义数组
 * 按优先级排序：system_prompt(1) > note(10) > exam(22) > essay(23) > translation(24) > textbook(25) > image(30) = file(30) > retrieval(50) > folder(100)
 * ★ 2025-12-26: Card 类型已删除
 * ★ 2025-12-28: 添加 system_prompt 类型
 * ★ 2025-01-03: User Preference 类型已删除，由新的 User Memory 系统替代
 */
export const builtInDefinitions: ContextTypeDefinition[] = [
  systemPromptDefinition,
  // userPreferenceDefinition 已删除
  noteDefinition,
  // cardDefinition 已删除
  examDefinition,
  essayDefinition,
  translationDefinition,
  textbookDefinition,
  imageDefinition,
  fileDefinition,
  retrievalDefinition,
  folderDefinition,
];

/**
 * 类型 ID 到定义的映射
 * ★ 2025-12-26: Card 类型已删除
 * ★ 2025-12-28: 添加 system_prompt 类型
 * ★ 2025-01-03: User Preference 类型已删除
 */
export const definitionMap: Record<string, ContextTypeDefinition> = {
  system_prompt: systemPromptDefinition,
  // user_preference 已删除
  note: noteDefinition,
  // card 已删除
  exam: examDefinition,
  essay: essayDefinition,
  translation: translationDefinition,
  textbook: textbookDefinition,
  image: imageDefinition,
  file: fileDefinition,
  retrieval: retrievalDefinition,
  folder: folderDefinition,
};

/**
 * 所有预定义类型 ID
 * ★ 2025-12-26: Card 类型已删除
 * ★ 2025-12-28: 添加 system_prompt 类型
 * ★ 2025-01-03: User Preference 类型已删除
 */
export const builtInTypeIds = ['system_prompt', 'note', 'exam', 'essay', 'translation', 'textbook', 'image', 'file', 'retrieval', 'folder'] as const;

/**
 * 预定义类型 ID 类型
 */
export type BuiltInTypeId = typeof builtInTypeIds[number];

/**
 * 检查是否为预定义类型
 */
export function isBuiltInType(typeId: string): typeId is BuiltInTypeId {
  return builtInTypeIds.includes(typeId as BuiltInTypeId);
}

/**
 * 获取所有预定义类型关联的工具 ID
 */
export function getAllBuiltInToolIds(): string[] {
  const toolSet = new Set<string>();
  for (const def of builtInDefinitions) {
    def.tools?.forEach((tool) => toolSet.add(tool));
  }
  return Array.from(toolSet);
}
