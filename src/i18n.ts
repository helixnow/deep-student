import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translation files
import zhCNCommon from './locales/zh-CN/common.json';
import zhCNSidebar from './locales/zh-CN/sidebar.json';
import zhCNSettings from './locales/zh-CN/settings.json';
import zhCNAnalysis from './locales/zh-CN/analysis.json';

import zhCNEnhancedRag from './locales/zh-CN/enhanced_rag.json';
import zhCNAnki from './locales/zh-CN/anki.json';
import zhCNTemplate from './locales/zh-CN/template.json';
import zhCNData from './locales/zh-CN/data.json';
import zhCNChatHost from './locales/zh-CN/chat_host.json';
import zhCNNotes from './locales/zh-CN/notes.json';
import zhCNCardManager from './locales/zh-CN/card_manager.json';

import zhCNDev from './locales/zh-CN/dev.json';
import zhCNExamSheet from './locales/zh-CN/exam_sheet.json';
import zhCNDragDrop from './locales/zh-CN/drag_drop.json';
import zhCNPdf from './locales/zh-CN/pdf.json';
import zhCNTextbook from './locales/zh-CN/textbook.json';
import zhCNGraphConflict from './locales/zh-CN/graph_conflict.json';
import zhCNTranslation from './locales/zh-CN/translation.json';
import zhCNEssayGrading from './locales/zh-CN/essay_grading.json';
import zhCNAppMenu from './locales/zh-CN/app_menu.json';
import zhCNChatModule from './locales/zh-CN/chat_module.json';
import zhCNChatV2 from './locales/zh-CN/chatV2.json';
import zhCNLearningHub from './locales/zh-CN/learningHub.json';
import zhCNDstu from './locales/zh-CN/dstu.json';
import zhCNMigration from './locales/zh-CN/migration.json';
import zhCNSkills from './locales/zh-CN/skills.json';
import zhCNCommandPalette from './locales/zh-CN/command_palette.json';
import zhCNBackendErrors from './locales/zh-CN/backend_errors.json';
import zhCNMcp from './locales/zh-CN/mcp.json';
import zhCNWorkspace from './locales/zh-CN/workspace.json';
import zhCNStats from './locales/zh-CN/stats.json';
import zhCNLlmUsage from './locales/zh-CN/llm_usage.json';
import zhCNReview from './locales/zh-CN/review.json';
import zhCNPractice from './locales/zh-CN/practice.json';
import zhCNSync from './locales/zh-CN/sync.json';
import zhCNMindmap from './locales/zh-CN/mindmap.json';

// Optional namespaces are loaded asynchronously
const zhCNKnowledgeGraph = {};

import enUSCommon from './locales/en-US/common.json';
import enUSSidebar from './locales/en-US/sidebar.json';
import enUSSettings from './locales/en-US/settings.json';
import enUSAnalysis from './locales/en-US/analysis.json';

import enUSEnhancedRag from './locales/en-US/enhanced_rag.json';
import enUSAnki from './locales/en-US/anki.json';
import enUSTemplate from './locales/en-US/template.json';
import enUSData from './locales/en-US/data.json';
import enUSChatHost from './locales/en-US/chat_host.json';
import enUSNotes from './locales/en-US/notes.json';
import enUSCardManager from './locales/en-US/card_manager.json';
import enUSDev from './locales/en-US/dev.json';
import enUSExamSheet from './locales/en-US/exam_sheet.json';
import enUSDragDrop from './locales/en-US/drag_drop.json';
import enUSPdf from './locales/en-US/pdf.json';
import enUSTextbook from './locales/en-US/textbook.json';
import enUSGraphConflict from './locales/en-US/graph_conflict.json';
import enUSTranslation from './locales/en-US/translation.json';
import enUSEssayGrading from './locales/en-US/essay_grading.json';
import enUSAppMenu from './locales/en-US/app_menu.json';
import enUSChatModule from './locales/en-US/chat_module.json';
import enUSChatV2 from './locales/en-US/chatV2.json';
import enUSLearningHub from './locales/en-US/learningHub.json';
import enUSDstu from './locales/en-US/dstu.json';
import enUSMigration from './locales/en-US/migration.json';
import enUSSkills from './locales/en-US/skills.json';
import enUSCommandPalette from './locales/en-US/command_palette.json';
import enUSBackendErrors from './locales/en-US/backend_errors.json';
import enUSMcp from './locales/en-US/mcp.json';
import enUSWorkspace from './locales/en-US/workspace.json';
import enUSStats from './locales/en-US/stats.json';
import enUSLlmUsage from './locales/en-US/llm_usage.json';
import enUSReview from './locales/en-US/review.json';
import enUSPractice from './locales/en-US/practice.json';
import enUSSync from './locales/en-US/sync.json';
import enUSMindmap from './locales/en-US/mindmap.json';

// Define placeholders for optional modules (they will be loaded asynchronously)
const zhCNForms = {};
const zhCNConsole = {};

const enUSForms = {};
const enUSConsole = {};

// Derive namespaced slices from existing bundles to satisfy strict namespace access
const enUSKnowledgeGraph = {};

const resources = {
  'zh-CN': {
    common: zhCNCommon,
    sidebar: zhCNSidebar,
    settings: zhCNSettings,
    analysis: zhCNAnalysis,

    enhanced_rag: zhCNEnhancedRag,
    anki: zhCNAnki,
    template: zhCNTemplate,
    data: zhCNData,
    chat_host: zhCNChatHost,
    notes: zhCNNotes,
    exam_sheet: zhCNExamSheet,
    card_manager: zhCNCardManager,
    knowledge_graph: zhCNKnowledgeGraph,
    dev: zhCNDev,
    drag_drop: zhCNDragDrop,
    pdf: zhCNPdf,
    textbook: zhCNTextbook,
    graph: {},
    graph_conflict: zhCNGraphConflict,
    translation: zhCNTranslation,
    essay_grading: zhCNEssayGrading,
    app_menu: zhCNAppMenu,
    chat_module: zhCNChatModule,
    chatV2: zhCNChatV2,
    learningHub: zhCNLearningHub,
    dstu: zhCNDstu,
    migration: zhCNMigration,
    skills: zhCNSkills,
    command_palette: zhCNCommandPalette,
    backend_errors: zhCNBackendErrors,
    mcp: zhCNMcp,
    workspace: zhCNWorkspace,
    stats: zhCNStats,
    llm_usage: zhCNLlmUsage,
    review: zhCNReview,
    practice: zhCNPractice,
    sync: zhCNSync,
    mindmap: zhCNMindmap,
    forms: zhCNForms,
    console: zhCNConsole,
  },
  'en-US': {
    common: enUSCommon,
    sidebar: enUSSidebar,
    settings: enUSSettings,
    analysis: enUSAnalysis,

    enhanced_rag: enUSEnhancedRag,
    anki: enUSAnki,
    template: enUSTemplate,
    data: enUSData,
    chat_host: enUSChatHost,
    notes: enUSNotes,
    exam_sheet: enUSExamSheet,
    card_manager: enUSCardManager,
    knowledge_graph: enUSKnowledgeGraph,
    dev: enUSDev,
    drag_drop: enUSDragDrop,
    pdf: enUSPdf,
    textbook: enUSTextbook,
    graph: {},
    graph_conflict: enUSGraphConflict,
    translation: enUSTranslation,
    essay_grading: enUSEssayGrading,
    app_menu: enUSAppMenu,
    chat_module: enUSChatModule,
    chatV2: enUSChatV2,
    learningHub: enUSLearningHub,
    dstu: enUSDstu,
    migration: enUSMigration,
    skills: enUSSkills,
    command_palette: enUSCommandPalette,
    backend_errors: enUSBackendErrors,
    mcp: enUSMcp,
    workspace: enUSWorkspace,
    stats: enUSStats,
    llm_usage: enUSLlmUsage,
    review: enUSReview,
    practice: enUSPractice,
    sync: enUSSync,
    mindmap: enUSMindmap,
    forms: enUSForms,
    console: enUSConsole,
  },
};

const isDev = Boolean(import.meta.env?.DEV);

if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: 'en-US',
      defaultNS: 'common',
      ns: ['common', 'sidebar', 'settings', 'analysis', 'enhanced_rag', 'anki', 'template', 'data', 'chat_host', 'chat_module', 'chatV2', 'notes', 'exam_sheet', 'card_manager', 'knowledge_graph', 'dev', 'drag_drop', 'pdf', 'textbook', 'graph', 'graph_conflict', 'translation', 'essay_grading', 'app_menu', 'learningHub', 'dstu', 'migration', 'skills', 'command_palette', 'backend_errors', 'mcp', 'workspace', 'stats', 'llm_usage', 'review', 'practice', 'sync', 'mindmap', 'forms', 'console'],
      fallbackNS: ['sidebar', 'settings', 'analysis', 'enhanced_rag', 'anki', 'template', 'data', 'chat_host', 'chat_module', 'notes', 'exam_sheet', 'card_manager', 'knowledge_graph', 'dev', 'drag_drop', 'pdf', 'textbook', 'graph_conflict', 'translation', 'essay_grading', 'learningHub', 'backend_errors', 'forms', 'console'],

      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        caches: ['localStorage'],
        lookupLocalStorage: 'i18nextLng',
      },

      interpolation: {
        escapeValue: false,
      },

      react: {
        useSuspense: false,
      },

      returnObjects: true,
      debug: false,
    });
}

// Async load optional translation files
(async () => {
  try {
    const ns = (await import('./locales/zh-CN/forms.json')).default;
    i18n.addResourceBundle('zh-CN', 'forms', ns, true, true);
  } catch {}
  try {
    const ns = (await import('./locales/zh-CN/console.json')).default;
    i18n.addResourceBundle('zh-CN', 'console', ns, true, true);
  } catch {}

  try {
    const ns = (await import('./locales/en-US/forms.json')).default;
    i18n.addResourceBundle('en-US', 'forms', ns, true, true);
  } catch {}
  try {
    const ns = (await import('./locales/en-US/console.json')).default;
    i18n.addResourceBundle('en-US', 'console', ns, true, true);
  } catch {}

  // 云存储命名空间
  try {
    const ns = (await import('./locales/zh-CN/cloudStorage.json')).default;
    i18n.addResourceBundle('zh-CN', 'cloudStorage', ns, true, true);
  } catch {}
  try {
    const ns = (await import('./locales/en-US/cloudStorage.json')).default;
    i18n.addResourceBundle('en-US', 'cloudStorage', ns, true, true);
  } catch {}
})();

export default i18n;
