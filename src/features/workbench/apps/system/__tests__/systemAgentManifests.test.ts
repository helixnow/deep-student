import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { workbenchToolsSkill } from '@/features/chat/skills/builtin-tools/workbench-tools';
import {
  settingsAgentManifest,
  taskDashboardAgentManifest,
  templatesAgentManifest,
} from '../agentManifests';
import {
  registerTaskDashboardAgentSurface,
  registerTemplateAgentSurface,
  type TaskDashboardAgentSnapshot,
  type TemplateAgentSnapshot,
} from '../agentSurfaceRegistry';

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

const context = (windowId: string, typeId: string) => ({
  windowId,
  typeId,
  instanceKey: null,
});

describe('system app Agent manifests', () => {
  it('opens a real settings section through the settings store', async () => {
    useSettingsShellStore.getState().setActiveTab('apis');
    const result = await settingsAgentManifest.execute?.(
      context('settings-window', 'settings'),
      { name: 'openSection', args: { section: 'models' } },
    );

    expect(result).toMatchObject({ handled: true, acknowledged: true, changed: true });
    expect(useSettingsShellStore.getState().activeTab).toBe('models');
    expect(settingsAgentManifest.observe?.(context('settings-window', 'settings'))).toMatchObject({
      state: { activeSection: 'models' },
    });
  });

  it('searches and opens only templates exposed by the mounted surface', async () => {
    let snapshot: TemplateAgentSnapshot = {
      activeTab: 'browse',
      selectedTemplateId: null,
      searchQuery: '',
      loading: false,
      error: null,
      templates: [{ id: 'tpl-1', name: 'Basic', updatedAt: '2026-01-01' }],
      totalTemplates: 1,
    };
    cleanups.push(registerTemplateAgentSurface('templates-window', {
      snapshot: () => snapshot,
      search: (query) => {
        snapshot = { ...snapshot, searchQuery: query };
        return true;
      },
      openTemplate: (templateId) => {
        if (!snapshot.templates.some((template) => template.id === templateId)) return false;
        snapshot = { ...snapshot, activeTab: 'edit', selectedTemplateId: templateId };
        return true;
      },
    }));

    const ctx = context('templates-window', 'templates');
    expect(await templatesAgentManifest.execute?.(ctx, {
      name: 'search',
      args: { query: 'Basic' },
    })).toMatchObject({ handled: true, acknowledged: true });
    expect(await templatesAgentManifest.execute?.(ctx, {
      name: 'openTemplate',
      args: { templateId: 'tpl-1' },
      targetRef: 'templates:template:tpl-1',
    })).toMatchObject({ handled: true, acknowledged: true });
    expect(templatesAgentManifest.observe?.(ctx)).toMatchObject({
      selection: ['templates:template:tpl-1'],
      state: { searchQuery: 'Basic', selectedTemplateId: 'tpl-1' },
    });
    expect(await templatesAgentManifest.execute?.(ctx, {
      name: 'openTemplate',
      args: { templateId: 'missing' },
      targetRef: 'templates:template:missing',
    })).toMatchObject({ handled: false, code: 'ENTITY_NOT_FOUND' });
  });

  it('filters and focuses only task sessions exposed by the mounted surface', async () => {
    let snapshot: TaskDashboardAgentSnapshot = {
      filter: 'all',
      searchQuery: '',
      focusedSessionId: null,
      loading: false,
      sessions: [{
        id: 'doc-1',
        name: 'Lecture notes',
        status: 'active',
        sourceSessionId: 'sess-1',
        updatedAt: '2026-01-01',
      }],
      totalSessions: 1,
    };
    cleanups.push(registerTaskDashboardAgentSurface('tasks-window', {
      snapshot: () => snapshot,
      filter: (filter) => {
        snapshot = { ...snapshot, filter };
        return true;
      },
      focusSession: (sessionId) => {
        if (!snapshot.sessions.some((session) => session.id === sessionId)) return false;
        snapshot = { ...snapshot, focusedSessionId: sessionId };
        return true;
      },
    }));

    const ctx = context('tasks-window', 'taskDashboard');
    expect(await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'filter',
      args: { filter: 'active' },
    })).toMatchObject({ handled: true, acknowledged: true });
    expect(await taskDashboardAgentManifest.execute?.(ctx, {
      name: 'focusSession',
      args: { sessionId: 'doc-1' },
      targetRef: 'taskDashboard:session:doc-1',
    })).toMatchObject({ handled: true, acknowledged: true });
    expect(taskDashboardAgentManifest.observe?.(ctx)).toMatchObject({
      selection: ['taskDashboard:session:doc-1'],
      state: { filter: 'active', focusedSessionId: 'doc-1' },
    });
  });

  it('advertises file-preview as a valid workbench target type', () => {
    expect(JSON.stringify(workbenchToolsSkill.embeddedTools)).toContain('file-preview');
  });
});
