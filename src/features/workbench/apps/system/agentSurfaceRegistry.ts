export interface TemplateAgentItem {
  id: string;
  name: string;
  description?: string;
  updatedAt?: string;
}

export interface TemplateAgentSnapshot {
  activeTab: 'browse' | 'edit' | 'create';
  selectedTemplateId: string | null;
  searchQuery: string;
  loading: boolean;
  error: string | null;
  templates: TemplateAgentItem[];
  totalTemplates: number;
}

export interface TemplateAgentSurface {
  snapshot: () => TemplateAgentSnapshot;
  openTemplate: (templateId: string) => boolean;
  search: (query: string) => boolean;
}

export interface TaskDashboardAgentItem {
  id: string;
  name: string;
  status: 'active' | 'attention' | 'completed';
  sourceSessionId: string | null;
  updatedAt: string;
}

export interface TaskDashboardAgentSnapshot {
  filter: 'all' | 'active' | 'attention' | 'completed';
  searchQuery: string;
  focusedSessionId: string | null;
  loading: boolean;
  sessions: TaskDashboardAgentItem[];
  totalSessions: number;
}

export interface TaskDashboardAgentSurface {
  snapshot: () => TaskDashboardAgentSnapshot;
  focusSession: (sessionId: string) => boolean;
  filter: (filter: TaskDashboardAgentSnapshot['filter']) => boolean;
}

export interface SkillsAgentItem {
  id: string;
  name: string;
  description?: string;
  /** 技能来源分组：global / project / builtin */
  location: 'global' | 'project' | 'builtin';
  builtin: boolean;
  /** 启用态（未被用户停用） */
  enabled: boolean;
  /** 是否默认注入新会话 */
  defaultEnabled: boolean;
}

export interface SkillsAgentSnapshot {
  searchQuery: string;
  locationFilter: 'all' | 'global' | 'project' | 'builtin';
  selectedSkillId: string | null;
  editorOpen: boolean;
  loading: boolean;
  skills: SkillsAgentItem[];
  totalSkills: number;
}

export interface SkillsAgentSurface {
  snapshot: () => SkillsAgentSnapshot;
  search: (query: string) => boolean;
  focusSkill: (skillId: string) => boolean;
  openSkill: (skillId: string) => boolean;
  setEnabled: (skillId: string, enabled: boolean) => boolean;
}

const templateSurfaces = new Map<string, TemplateAgentSurface>();
const taskDashboardSurfaces = new Map<string, TaskDashboardAgentSurface>();
const skillsSurfaces = new Map<string, SkillsAgentSurface>();

function registerSurface<T>(registry: Map<string, T>, windowId: string, surface: T): () => void {
  registry.set(windowId, surface);
  return () => {
    if (registry.get(windowId) === surface) registry.delete(windowId);
  };
}

export function registerTemplateAgentSurface(
  windowId: string,
  surface: TemplateAgentSurface,
): () => void {
  return registerSurface(templateSurfaces, windowId, surface);
}

export function getTemplateAgentSurface(windowId: string): TemplateAgentSurface | undefined {
  return templateSurfaces.get(windowId);
}

export function registerTaskDashboardAgentSurface(
  windowId: string,
  surface: TaskDashboardAgentSurface,
): () => void {
  return registerSurface(taskDashboardSurfaces, windowId, surface);
}

export function getTaskDashboardAgentSurface(
  windowId: string,
): TaskDashboardAgentSurface | undefined {
  return taskDashboardSurfaces.get(windowId);
}

export function registerSkillsAgentSurface(
  windowId: string,
  surface: SkillsAgentSurface,
): () => void {
  return registerSurface(skillsSurfaces, windowId, surface);
}

export function getSkillsAgentSurface(windowId: string): SkillsAgentSurface | undefined {
  return skillsSurfaces.get(windowId);
}
