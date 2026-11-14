import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import analysis from '@app/locales/zh-CN/analysis.json';
import anki from '@app/locales/zh-CN/anki.json';
import appMenu from '@app/locales/zh-CN/app_menu.json';
import backendErrors from '@app/locales/zh-CN/backend_errors.json';
import cardManager from '@app/locales/zh-CN/card_manager.json';
import chatHost from '@app/locales/zh-CN/chat_host.json';
import chatModule from '@app/locales/zh-CN/chat_module.json';
import chatV2 from '@app/locales/zh-CN/chatV2.json';
import cloudStorage from '@app/locales/zh-CN/cloudStorage.json';
import commandPalette from '@app/locales/zh-CN/command_palette.json';
import common from '@app/locales/zh-CN/common.json';
import consoleNs from '@app/locales/zh-CN/console.json';
import data from '@app/locales/zh-CN/data.json';
import dev from '@app/locales/zh-CN/dev.json';
import dragDrop from '@app/locales/zh-CN/drag_drop.json';
import dstu from '@app/locales/zh-CN/dstu.json';
import enhancedRag from '@app/locales/zh-CN/enhanced_rag.json';
import essayGrading from '@app/locales/zh-CN/essay_grading.json';
import examSheet from '@app/locales/zh-CN/exam_sheet.json';
import flashcards from '@app/locales/zh-CN/flashcards.json';
import forms from '@app/locales/zh-CN/forms.json';
import generativeUi from '@app/locales/zh-CN/generativeUi.json';
import graphConflict from '@app/locales/zh-CN/graph_conflict.json';
import learningHub from '@app/locales/zh-CN/learningHub.json';
import llmUsage from '@app/locales/zh-CN/llm_usage.json';
import mcp from '@app/locales/zh-CN/mcp.json';
import mediaStudio from '@app/locales/zh-CN/mediaStudio.json';
import migration from '@app/locales/zh-CN/migration.json';
import mindmap from '@app/locales/zh-CN/mindmap.json';
import notes from '@app/locales/zh-CN/notes.json';
import pdf from '@app/locales/zh-CN/pdf.json';
import pluginManager from '@app/locales/zh-CN/plugin_manager.json';
import practice from '@app/locales/zh-CN/practice.json';
import quickAssistant from '@app/locales/zh-CN/quickAssistant.json';
import review from '@app/locales/zh-CN/review.json';
import settings from '@app/locales/zh-CN/settings.json';
import sidebar from '@app/locales/zh-CN/sidebar.json';
import skills from '@app/locales/zh-CN/skills.json';
import stats from '@app/locales/zh-CN/stats.json';
import superAgent from '@app/locales/zh-CN/superAgent.json';
import sync from '@app/locales/zh-CN/sync.json';
import template from '@app/locales/zh-CN/template.json';
import textbook from '@app/locales/zh-CN/textbook.json';
import todo from '@app/locales/zh-CN/todo.json';
import translation from '@app/locales/zh-CN/translation.json';
import vfs from '@app/locales/zh-CN/vfs.json';
import workbench from '@app/locales/zh-CN/workbench.json';
import workspace from '@app/locales/zh-CN/workspace.json';

/**
 * 主应用组件用的 i18next 实例：文案直接读主应用 zh-CN locale 的全部命名空间，同步初始化（逐帧渲染不能等异步加载）。
 * 打包时主应用自己的 src/i18n.ts 也被替换成这个文件（webpack-override.mjs），所以这里不能有相对导入。
 */
const resources = {
  analysis,
  anki,
  app_menu: appMenu,
  backend_errors: backendErrors,
  card_manager: cardManager,
  chat_host: chatHost,
  chat_module: chatModule,
  chatV2,
  cloudStorage,
  command_palette: commandPalette,
  common,
  console: consoleNs,
  data,
  dev,
  drag_drop: dragDrop,
  dstu,
  enhanced_rag: enhancedRag,
  essay_grading: essayGrading,
  exam_sheet: examSheet,
  flashcards,
  forms,
  generativeUi,
  graph_conflict: graphConflict,
  learningHub,
  llm_usage: llmUsage,
  mcp,
  mediaStudio,
  migration,
  mindmap,
  notes,
  pdf,
  plugin_manager: pluginManager,
  practice,
  quickAssistant,
  review,
  settings,
  sidebar,
  skills,
  stats,
  superAgent,
  sync,
  template,
  textbook,
  todo,
  translation,
  vfs,
  workbench,
  workspace,
};

export const appI18n = i18n.createInstance();

void appI18n.use(initReactI18next).init({
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  ns: Object.keys(resources),
  resources: { 'zh-CN': resources },
  interpolation: { escapeValue: false },
  initAsync: false,
  react: { useSuspense: false },
});

export default appI18n;
