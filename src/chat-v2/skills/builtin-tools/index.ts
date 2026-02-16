/**
 * 内置工具组 Skills 索引
 *
 * 这些 Skills 完全替代原 builtinMcpServer.ts 中的工具定义，
 * 按功能分组以支持渐进披露架构。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

export { knowledgeRetrievalSkill } from './knowledge-retrieval';
export { canvasNoteSkill } from './canvas-note';
export { vfsMemorySkill } from './vfs-memory';
export { learningResourceSkill } from './learning-resource';
export { mindmapToolsSkill } from './mindmap-tools';
export { attachmentToolsSkill } from './attachment-tools';
export { todoToolsSkill } from './todo-tools';
export { qbankToolsSkill } from './qbank-tools';
export { workspaceToolsSkill } from './workspace-tools';
export { webFetchSkill } from './web-fetch';
export { subagentWorkerSkill, SUBAGENT_WORKER_SYSTEM_PROMPT } from './subagent-worker';
export { templateDesignerSkill } from './template-designer';
export { askUserSkill } from './ask-user';
export { academicSearchSkill } from './academic-search';
export { docxToolsSkill } from './docx-tools';
export { pptxToolsSkill } from './pptx-tools';
export { xlsxToolsSkill } from './xlsx-tools';

import { knowledgeRetrievalSkill } from './knowledge-retrieval';
import { canvasNoteSkill } from './canvas-note';
import { vfsMemorySkill } from './vfs-memory';
import { learningResourceSkill } from './learning-resource';
import { mindmapToolsSkill } from './mindmap-tools';
import { attachmentToolsSkill } from './attachment-tools';
import { todoToolsSkill } from './todo-tools';
import { qbankToolsSkill } from './qbank-tools';
import { workspaceToolsSkill } from './workspace-tools';
import { webFetchSkill } from './web-fetch';
import { subagentWorkerSkill } from './subagent-worker';
import { templateDesignerSkill } from './template-designer';
import { askUserSkill } from './ask-user';
import { academicSearchSkill } from './academic-search';
import { docxToolsSkill } from './docx-tools';
import { pptxToolsSkill } from './pptx-tools';
import { xlsxToolsSkill } from './xlsx-tools';
import type { SkillDefinition } from '../types';

/**
 * 所有内置工具组 Skills
 *
 * 完全替代 builtinMcpServer.ts，所有内置工具通过 Skills 渐进披露加载。
 * LLM 通过 load_skills 工具按需加载。
 */
export const builtinToolSkills: SkillDefinition[] = [
  knowledgeRetrievalSkill,
  canvasNoteSkill,
  vfsMemorySkill,
  learningResourceSkill,
  mindmapToolsSkill,
  attachmentToolsSkill,
  todoToolsSkill,
  qbankToolsSkill,
  workspaceToolsSkill,
  webFetchSkill,
  subagentWorkerSkill,
  templateDesignerSkill,
  askUserSkill,
  academicSearchSkill,
  docxToolsSkill,
  pptxToolsSkill,
  xlsxToolsSkill,
];

/**
 * 获取所有内置工具组 Skills
 */
export function getBuiltinToolSkills(): SkillDefinition[] {
  return [...builtinToolSkills];
}

/**
 * 根据 ID 获取内置工具组 Skill
 */
export function getBuiltinToolSkillById(id: string): SkillDefinition | undefined {
  return builtinToolSkills.find(skill => skill.id === id);
}
