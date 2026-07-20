// Public API for template-management feature
export { TemplateManagementApp, default } from './TemplateManagementApp';
export type { TemplateManagementAppProps } from './TemplateManagementApp';
export { TemplateBrowser } from './components/TemplateBrowser';
export type { TemplateBrowserProps, RenderPreview } from './components/TemplateBrowser';
export { TemplateToolbar } from './components/TemplateToolbar';
export {
  getTemplateKind,
  filterAndSortTemplates,
  type TemplateViewMode,
  type TemplateTypeFilter,
  type TemplateSourceFilter,
  type TemplateSortOrder,
} from './lib/templateLibrary';
