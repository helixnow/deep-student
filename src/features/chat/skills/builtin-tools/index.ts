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
export { dstuToolsSkill } from './dstu-tools';
export { mindmapToolsSkill } from './mindmap-tools';
export { attachmentToolsSkill } from './attachment-tools';
export { todoToolsSkill } from './todo-tools';
export { qbankToolsSkill } from './qbank-tools';
export { workspaceToolsSkill } from './workspace-tools';
export { webFetchSkill } from './web-fetch';
export { browserToolsSkill } from './browser-tools';
export { subagentWorkerSkill, SUBAGENT_WORKER_SYSTEM_PROMPT } from './subagent-worker';
export { templateDesignerSkill } from './template-designer';
export { askUserSkill } from './ask-user';
export { academicSearchSkill } from './academic-search';
export { docxToolsSkill } from './docx-tools';
export { pptxToolsSkill } from './pptx-tools';
export { xlsxToolsSkill } from './xlsx-tools';
export { sessionManagerSkill } from './session-manager';
export { userTodoToolsSkill } from './user-todo-tools';
export { imageGenerationSkill } from './image-generation';
export { toolPackSkill } from './tool-pack';
export { selfServiceToolsSkill } from './self-service-tools';
export { automationToolsSkill } from './automation-tools';
export { rootRequestToolsSkill } from './root-request-tools';
export { essayGradingSkill } from './essay-grading';
export { reviewPlanningSkill } from './review-planning';
export { documentProcessingSkill } from './document-processing';
export { workbenchToolsSkill } from './workbench-tools';
export { translationToolsSkill } from './translation-tools';
export { settingsToolsSkill } from './settings-tools';
export { llmUsageToolsSkill } from './llm-usage-tools';
export { dataGovernanceToolsSkill } from './data-governance-tools';
export { textbookPdfToolsSkill } from './textbook-pdf-tools';
export { learningOverviewToolsSkill } from './learning-overview-tools';
export { indexWebpageToolsSkill } from './index-webpage-tools';

import { knowledgeRetrievalSkill } from './knowledge-retrieval';
import { canvasNoteSkill } from './canvas-note';
import { vfsMemorySkill } from './vfs-memory';
import { learningResourceSkill } from './learning-resource';
import { dstuToolsSkill } from './dstu-tools';
import { mindmapToolsSkill } from './mindmap-tools';
import { attachmentToolsSkill } from './attachment-tools';
import { todoToolsSkill } from './todo-tools';
import { qbankToolsSkill } from './qbank-tools';
import { workspaceToolsSkill } from './workspace-tools';
import { webFetchSkill } from './web-fetch';
import { browserToolsSkill } from './browser-tools';
import { subagentWorkerSkill } from './subagent-worker';
import { templateDesignerSkill } from './template-designer';
import { askUserSkill } from './ask-user';
import { academicSearchSkill } from './academic-search';
import { docxToolsSkill } from './docx-tools';
import { pptxToolsSkill } from './pptx-tools';
import { xlsxToolsSkill } from './xlsx-tools';
import { sessionManagerSkill } from './session-manager';
import { userTodoToolsSkill } from './user-todo-tools';
import { imageGenerationSkill } from './image-generation';
import { toolPackSkill } from './tool-pack';
import { selfServiceToolsSkill } from './self-service-tools';
import { automationToolsSkill } from './automation-tools';
import { rootRequestToolsSkill } from './root-request-tools';
import { essayGradingSkill } from './essay-grading';
import { reviewPlanningSkill } from './review-planning';
import { documentProcessingSkill } from './document-processing';
import { workbenchToolsSkill } from './workbench-tools';
import { translationToolsSkill } from './translation-tools';
import { settingsToolsSkill } from './settings-tools';
import { llmUsageToolsSkill } from './llm-usage-tools';
import { dataGovernanceToolsSkill } from './data-governance-tools';
import { textbookPdfToolsSkill } from './textbook-pdf-tools';
import { learningOverviewToolsSkill } from './learning-overview-tools';
import { indexWebpageToolsSkill } from './index-webpage-tools';
import type { SkillDefinition } from '../types';
import { getPlatform } from '@/utils/platform';

export function filterBuiltinToolSkillsForPlatform(
  skills: readonly SkillDefinition[],
  platform: string,
): SkillDefinition[] {
  const p = platform.toLowerCase();
  // Result-returning browser bridge: Windows WebView2 + macOS WKWebView.
  if (p === 'windows' || p === 'macos') return [...skills];
  return skills.filter((skill) => skill.id !== browserToolsSkill.id);
}

/**
 * 所有内置工具组 Skills
 *
 * 完全替代 builtinMcpServer.ts，所有内置工具通过 Skills 渐进披露加载。
 * LLM 通过 load_skills 工具按需加载。
 */
const allBuiltinToolSkills: SkillDefinition[] = [
  knowledgeRetrievalSkill,
  canvasNoteSkill,
  vfsMemorySkill,
  learningResourceSkill,
  dstuToolsSkill,
  mindmapToolsSkill,
  attachmentToolsSkill,
  todoToolsSkill,
  qbankToolsSkill,
  workspaceToolsSkill,
  webFetchSkill,
  browserToolsSkill,
  subagentWorkerSkill,
  templateDesignerSkill,
  askUserSkill,
  academicSearchSkill,
  docxToolsSkill,
  pptxToolsSkill,
  xlsxToolsSkill,
  sessionManagerSkill,
  userTodoToolsSkill,
  imageGenerationSkill,
  toolPackSkill,
  selfServiceToolsSkill,
  automationToolsSkill,
  rootRequestToolsSkill,
  essayGradingSkill,
  reviewPlanningSkill,
  documentProcessingSkill,
  workbenchToolsSkill,
  translationToolsSkill,
  settingsToolsSkill,
  llmUsageToolsSkill,
  dataGovernanceToolsSkill,
  textbookPdfToolsSkill,
  learningOverviewToolsSkill,
  indexWebpageToolsSkill,
];

// The result-returning browser bridge is implemented for Windows WebView2 and
// macOS WKWebView. Other runtimes fail closed and do not advertise tools that
// can only return BRIDGE_UNSUPPORTED.
const runtimePlatform =
  typeof window === 'undefined' || typeof navigator === 'undefined' ? 'unknown' : getPlatform();
export const builtinToolSkills: SkillDefinition[] = filterBuiltinToolSkillsForPlatform(
  allBuiltinToolSkills,
  runtimePlatform,
);

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
