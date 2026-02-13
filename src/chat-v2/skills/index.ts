/**
 * Chat V2 - Skills 系统模块导出
 *
 * 提供统一的 Skills 系统入口
 */

// 类型导出
export type {
  SkillMetadata,
  SkillDefinition,
  SkillLocation,
  SkillLoadConfig,
  SkillResourceMetadata,
  SkillParseResult,
  SkillValidationResult,
} from './types';

export {
  validateSkillMetadata,
  SKILL_INSTRUCTION_TYPE_ID,
  SKILL_DEFAULT_PRIORITY,
  SKILL_XML_TAG,
  DEFAULT_SKILL_LOAD_CONFIG,
} from './types';

// 解析器
export {
  parseSkillFile,
  isValidSkillFile,
  extractSkillMetadata,
  serializeSkillToMarkdown,
} from './parser';

// API
export {
  listSkillDirectories,
  readSkillFile,
  createSkill,
  updateSkill,
  deleteSkill,
} from './api';
export type {
  SkillFileContent,
  SkillDirectoryEntry,
  SkillCreateParams,
  SkillUpdateParams,
} from './api';

// 注册表
export {
  skillRegistry,
  getSkill,
  getAutoInvokeSkills,
  getSkillContextTypeId,
  subscribeToSkillRegistry,
} from './registry';

// 上下文类型定义
export {
  skillInstructionDefinition,
  createSkillInstructionBlocks,
} from './skillContextType';

// 资源辅助函数
export {
  createResourceFromSkill,
  createResourcesFromSkills,
  isSkillContextRef,
} from './resourceHelper';

// 初始化
export {
  initializeSkillSystem,
  isSkillSystemInitialized,
  resetSkillSystem,
} from './init';

// 文件系统加载器
export {
  loadSkillsFromFileSystem,
  reloadSkills,
  loadSingleSkill,
} from './loader';

// 内置 Skills
export {
  getBuiltinSkills,
  builtinSkills,
  dstuMemoryOrchestratorSkill,
  tutorModeSkill,
  researchModeSkill,
} from './builtin';

// 内置 Skills 自定义存储
export {
  getBuiltinSkillCustomization,
  saveBuiltinSkillCustomization,
  resetBuiltinSkillCustomization,
  getAllBuiltinSkillCustomizations,
  applyCustomizationToSkill,
  extractCustomizationFromSkill,
} from './builtinStorage';
export type { BuiltinSkillCustomization } from './builtinStorage';

// UI 组件
export {
  SkillCard,
  ActiveSkillBadge,
  ActiveSkillBadgeCompact,
  NoActiveSkillButton,
  SkillSelector,
} from './components';
export type {
  SkillCardProps,
  ActiveSkillBadgeProps,
  NoActiveSkillProps,
  SkillSelectorProps,
} from './components';

// React Hooks
export {
  useSkillList,
  useSkillDetails,
  useSkillsByLocation,
  useAutoInvokeSkills,
  useSkillSearch,
  useSkillSummary,
  useSkillDefaults,
} from './hooks';
export type { UseSkillDefaultsReturn } from './hooks';

// 默认技能管理
export { skillDefaults } from './skillDefaults';

// 渐进披露架构
export {
  LOAD_SKILLS_TOOL_NAME,
  LOAD_SKILLS_TOOL_SCHEMA,
  getLoadedSkills,
  getLoadedToolSchemas,
  isSkillLoaded,
  loadSkillsToSession,
  clearSessionSkills,
  unloadSkill,
  handleLoadSkillsToolCall,
  generateAvailableSkillsPrompt,
  getProgressiveDisclosureConfig,
  DEFAULT_PROGRESSIVE_DISCLOSURE_CONFIG,
  subscribeToLoadedSkills,
} from './progressiveDisclosure';
export type {
  LoadedSkillInfo,
  ProgressiveDisclosureConfig,
} from './progressiveDisclosure';

// 工具 Schema 类型
export type {
  ToolSchema,
  ToolInputSchema,
  JsonSchemaProperty,
} from './types';

// 共享工具函数（从 utils.ts 导出，避免循环依赖）
export { getLocalizedSkillName } from './utils';
