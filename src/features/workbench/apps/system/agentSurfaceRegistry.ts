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

const templateSurfaces = new Map<string, TemplateAgentSurface>();
const taskDashboardSurfaces = new Map<string, TaskDashboardAgentSurface>();

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
