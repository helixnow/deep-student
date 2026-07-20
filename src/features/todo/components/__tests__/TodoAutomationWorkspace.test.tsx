import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invokeMock,
  listenMock,
  storeState,
  launchMock,
  parseMock,
  computeNextRunsMock,
} = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  return {
    invokeMock: vi.fn(),
    listenMock: vi.fn(),
    storeState: state,
    launchMock: vi.fn(),
    parseMock: vi.fn(),
    computeNextRunsMock: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

vi.mock('@/features/settings/components/AutomationSettingsSection', () => ({
  AutomationSettingsSection: () => <div data-testid="automation-definition-list" />,
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: { launch: launchMock },
}));

// 全局 store：组件应完全通过 useAutomationStore 取数与触发 mutation
vi.mock('../../stores/useAutomationStore', () => {
  const useAutomationStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector(storeState);
  useAutomationStore.getState = () => storeState;
  return {
    useAutomationStore,
    startAutomationSync: vi.fn(() => () => undefined),
  };
});

vi.mock('../automation/AutomationRunHistory', () => ({
  AutomationRunHistory: ({ runs, automationNames, busyRunId, onRetry, onCancel, onOpenSession }: {
    runs: Array<{ id: string; automationId: string; sessionId?: string }>;
    automationNames: Record<string, string>;
    busyRunId?: string | null;
    onRetry: (runId: string) => void;
    onCancel: (runId: string) => void;
    onOpenSession: (sessionId: string) => void;
  }) => (
    <div data-testid="run-history" data-busy-run={busyRunId ?? ''}>
      {runs.map((run) => (
        <div key={run.id} data-testid={`run-${run.id}`}>
          <span>{automationNames[run.automationId] ?? run.automationId}</span>
          <button type="button" onClick={() => onRetry(run.id)}>{`retry-${run.id}`}</button>
          <button type="button" onClick={() => onCancel(run.id)}>{`cancel-${run.id}`}</button>
          {run.sessionId ? (
            <button type="button" onClick={() => onOpenSession(run.sessionId as string)}>
              {`open-${run.id}`}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../automation/AutomationScheduleEditor', () => ({
  AutomationScheduleEditor: ({ value, idPrefix }: {
    value: { kind: string; time: string };
    idPrefix?: string;
  }) => (
    <div data-testid="schedule-editor" data-kind={value.kind} data-time={value.time} data-id-prefix={idPrefix} />
  ),
}));

vi.mock('../automation/AutomationTemplates', () => ({
  AutomationTemplatePicker: ({ onSelect }: {
    onSelect: (draft: Record<string, unknown>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSelect({
        name: 'Template name',
        prompt: 'Template prompt',
        actionType: 'notify',
        schedule: { kind: 'weekdays', time: '07:30' },
        catchUpPolicy: 'skip',
      })}
    >
      pick-template
    </button>
  ),
}));

vi.mock('../automation/automationFormat', () => ({
  formatRelativeTime: (iso?: string) => (iso ? 'in 3 hours' : ''),
  formatAbsoluteTime: (iso?: string) => (iso ? 'Jul 15, 2026, 8:00 PM' : ''),
}));

vi.mock('../automation/scheduleMath', () => ({
  computeNextRuns: computeNextRunsMock,
  formatWeekdayList: (weekdays: number[]) => weekdays.join('、'),
}));

vi.mock('../../automationNlParser', () => ({
  parseAutomationNaturalLanguage: parseMock,
}));

vi.mock('react-i18next', () => {
  const translations: Record<string, string> = {
    'todo:automation.title': 'Scheduled tasks',
    'todo:automation.subtitle': 'Reminders and unattended Agent runs',
    'todo:automation.summary': 'Automation summary',
    'todo:automation.loading': 'Loading automation overview',
    'todo:automation.enabled': 'Enabled',
    'todo:automation.running': 'Running',
    'todo:automation.failed24h': 'Failed in 24h',
    'todo:automation.next': 'Next run',
    'todo:automation.never': 'None',
    'todo:automation.startingSoon': 'Starting soon',
    'todo:automation.background': 'Keep running after closing the window',
    'todo:automation.backgroundHint': 'Background hint',
    'todo:automation.history.title': 'Run history',
    'todo:automation.history.toggleAria': 'Run history ({{count}})',
    'todo:automation.new': 'New task',
    'todo:automation.createTitle': 'New scheduled task',
    'todo:automation.name': 'Name',
    'todo:automation.action': 'Action',
    'todo:automation.notify': 'Notification + todo',
    'todo:automation.schedule': 'Schedule',
    'todo:automation.catchUp': 'Missed runs',
    'todo:automation.runOnce': 'Run once after resume',
    'todo:automation.catchAll': 'Run each missed occurrence',
    'todo:automation.skip': 'Skip',
    'todo:automation.sessionMode': 'Session',
    'todo:automation.isolated': 'New each run',
    'todo:automation.named': 'Continuous session',
    'todo:automation.model': 'Model configuration ID',
    'todo:automation.defaultModel': 'Use default model',
    'todo:automation.retries': 'Failure retries',
    'todo:automation.retryBackoff': 'Retry delay seconds',
    'todo:automation.timeout': 'Timeout seconds',
    'todo:automation.advanced': 'Retries & timeout',
    'todo:automation.prompt': 'Task instructions',
    'todo:automation.nameRequired': 'Enter a task name',
    'todo:automation.promptRequired': 'Enter task instructions',
    'todo:automation.retry': 'Retry',
    'todo:automation.create': 'Create',
    'todo:automation.emptyTitle': 'No scheduled tasks yet',
    'todo:automation.emptyHint': 'Empty hint',
    'todo:automation.emptyTemplate': 'Start from a template',
    'todo:automation.createPanel.quickTitle': 'Create with one sentence',
    'todo:automation.createPanel.nlApply': 'Fill the form',
    'todo:automation.createPanel.nlFirstRun': 'First run: {{time}}',
    'todo:automation.createPanel.templatesToggle': 'Start from a template list',
    'todo:automation.createPanel.agentPrompt': 'Agent instructions (optional)',
    'todo:automation.createPanel.agentPromptHint': 'Leave empty to reuse the task instructions above',
    'todo:automation.createPanel.promptCount': '{{count}} / {{max}}',
    'todo:automation.createPanel.scheduleInvalid': 'This schedule never produces a next run',
    'todo:automation.createPanel.shortcutHint': 'Esc to close · Cmd/Ctrl+Enter to create',
    'todo:automation.createPanel.success': 'Scheduled task "{{name}}" created',
    'todo:automation.createPanel.scheduleSummary.daily': 'Daily at {{time}}',
    'todo:automation.nl.placeholder': 'Describe in one sentence',
    'todo:automation.nl.matchedLabel': 'Detected time expression',
    'todo:automation.nl.noSchedule': 'No schedule detected',
    'todo:automation.nl.confidence.medium': 'Parse confidence: medium, please confirm the schedule',
    'todo:automation.nl.confidence.low': 'Parse confidence: low, please set the schedule manually',
    'settings:automation.action_type.agent_turn': 'Agent task',
    'settings:automation.errors.invalid_response': 'The automation list returned invalid data.',
    'common:actions.refresh': 'Refresh',
    'common:actions.close': 'Close',
    'common:actions.cancel': 'Cancel',
  };
  const interpolate = (template: string, options?: Record<string, unknown>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(options?.[key] ?? ''));
  return {
    initReactI18next: { type: '3rdParty' as const, init: () => undefined },
    useTranslation: () => ({
      t: (key: string, options?: string | Record<string, unknown>) => {
        const template = translations[key];
        if (template !== undefined) {
          return typeof options === 'object' ? interpolate(template, options) : template;
        }
        if (typeof options === 'string') return options;
        if (options && typeof options === 'object' && options.defaultValue !== undefined) {
          return String(options.defaultValue);
        }
        return key;
      },
      i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    }),
  };
});

import { TodoAutomationWorkspace } from '../TodoAutomationWorkspace';
import { requestAutomationCreate } from '../../automationCreateRequest';

const automation = {
  id: 'auto_morning',
  version: 3,
  name: 'Morning review',
  schedule: { kind: 'daily', time: '20:00', timezone: 'Asia/Shanghai' },
  prompt: 'Review the due queue',
  enabled: true,
  actionType: 'notify' as const,
  heartbeat: false,
  catchUpPolicy: 'run_once' as const,
  maxRetries: 2,
  retryBackoffSeconds: 60,
  timeoutSeconds: 600,
};

const run = {
  id: 'run_1',
  automationId: automation.id,
  status: 'queued',
  triggerType: 'schedule',
  scheduledFor: '2026-07-14T12:00:00Z',
  attempt: 1,
  maxAttempts: 3,
  sessionId: 'sess_1',
  delivered: [],
};

function resetStore(overrides: Record<string, unknown> = {}) {
  for (const key of Object.keys(storeState)) delete storeState[key];
  Object.assign(storeState, {
    automations: [automation],
    count: 1,
    max: 20,
    summary: {
      enabledCount: 1,
      runningCount: 0,
      failedCount: 0,
      // 远未来时刻：保证「已过期 → 即将开始」分支不随真实时间推进而误触发
      nextRunAt: '2099-07-15T12:00:00Z',
      backgroundEnabled: true,
    },
    runs: [run],
    loading: false,
    error: null,
    busyKey: null,
    refresh: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    create: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    runNow: vi.fn(async () => undefined),
    retryRun: vi.fn(async () => undefined),
    cancelRun: vi.fn(async () => undefined),
    setBackgroundEnabled: vi.fn(async () => undefined),
    ...overrides,
  });
}

function createPanelWrapper(): HTMLElement {
  const panel = document.getElementById('automation-create-panel');
  expect(panel).not.toBeNull();
  return (panel as HTMLElement).closest('.automation-collapse') as HTMLElement;
}

describe('TodoAutomationWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockResolvedValue(() => undefined);
    invokeMock.mockResolvedValue({ success: true });
    parseMock.mockReturnValue(null);
    computeNextRunsMock.mockReturnValue([new Date('2026-07-15T12:00:00Z')]);
    resetStore();
  });

  it('shows skeleton stat cards while the first summary load is in flight', () => {
    resetStore({ summary: null, runs: [], automations: [], count: 0, loading: true });
    render(<TodoAutomationWorkspace />);

    expect(screen.getByTestId('automation-summary-skeleton')).toBeInTheDocument();
    // 没有误导性的 "0" 统计值
    expect(screen.queryByText('Enabled')).not.toBeInTheDocument();
  });

  it('renders summary stats, relative next-run time and default-expanded run history', () => {
    render(<TodoAutomationWorkspace />);

    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('in 3 hours')).toBeInTheDocument();
    expect(screen.getByTitle('Jul 15, 2026, 8:00 PM')).toBeInTheDocument();

    // 历史默认展开：折叠容器 data-open=true 且行可见
    const historyPanel = document.getElementById('automation-history-panel') as HTMLElement;
    const collapse = historyPanel.closest('.automation-collapse') as HTMLElement;
    expect(collapse.dataset.open).toBe('true');
    expect(screen.getByTestId('run-run_1')).toHaveTextContent('Morning review');

    // 折叠按钮具备可读的 aria-label 与 aria-controls
    const toggle = screen.getByRole('button', { name: 'Run history (1)' });
    expect(toggle).toHaveAttribute('aria-controls', 'automation-history-panel');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('wires run history actions to the store and opens sessions via workbenchBus', () => {
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'retry-run_1' }));
    expect(storeState.retryRun).toHaveBeenCalledWith('run_1');

    fireEvent.click(screen.getByRole('button', { name: 'cancel-run_1' }));
    expect(storeState.cancelRun).toHaveBeenCalledWith('run_1');

    fireEvent.click(screen.getByRole('button', { name: 'open-run_1' }));
    expect(launchMock).toHaveBeenCalledWith({
      typeId: 'chat',
      instanceKey: 'sess_1',
      reason: 'api',
    });
  });

  it('surfaces store errors in an alert bar with a retry action', () => {
    resetStore({ error: 'AUTOMATION_LIST_INVALID_RESPONSE' });
    render(<TodoAutomationWorkspace />);

    // 原始错误码经过本地化映射后展示
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The automation list returned invalid data.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(storeState.refresh).toHaveBeenCalled();
  });

  it('suppresses version-conflict payloads from the global error bar', () => {
    // 版本冲突由列表的行内提示呈现，顶部错误条不重复透出（判定走 code 解析而非子串匹配）
    resetStore({
      error: JSON.stringify({
        code: 'AUTOMATION_VERSION_CONFLICT',
        message: 'Automation changed after it was read.',
        errorType: 'conflict',
      }),
    });
    render(<TodoAutomationWorkspace />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the human-readable message instead of the raw JSON error payload', () => {
    resetStore({
      error: JSON.stringify({ code: 'DATABASE_ERROR', message: 'Database is locked' }),
    });
    render(<TodoAutomationWorkspace />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Database is locked');
    expect(alert).not.toHaveTextContent('DATABASE_ERROR');
  });

  it('shows a "starting soon" label instead of past-tense relative time for an overdue next run', () => {
    resetStore({
      summary: {
        enabledCount: 1,
        runningCount: 0,
        failedCount: 0,
        nextRunAt: '2020-01-01T00:00:00Z',
        backgroundEnabled: true,
      },
    });
    render(<TodoAutomationWorkspace />);

    expect(screen.getByText('Starting soon')).toBeInTheDocument();
  });

  it('expands the inline create panel and blocks submit with inline field errors', async () => {
    render(<TodoAutomationWorkspace />);

    const wrapper = createPanelWrapper();
    expect(wrapper.dataset.open).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(wrapper.dataset.open).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const errors = await screen.findAllByRole('alert');
    expect(errors.some((node) => node.textContent?.includes('Enter a task name'))).toBe(true);
    expect(errors.some((node) => node.textContent?.includes('Enter task instructions'))).toBe(true);
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(storeState.create).not.toHaveBeenCalled();
  });

  it('shows an inline schedule error when the schedule can never run', async () => {
    computeNextRunsMock.mockReturnValue([]);
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic reminder' } });
    fireEvent.change(screen.getByLabelText('Task instructions'), { target: { value: 'Synthetic QA only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const inlineError = await screen.findByRole('alert');
    expect(inlineError).toHaveTextContent('This schedule never produces a next run');
    expect(storeState.create).not.toHaveBeenCalled();
  });

  it('creates a notification task through the store without Agent-only fields', async () => {
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic reminder' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Notification + todo' }));
    fireEvent.change(screen.getByLabelText('Task instructions'), { target: { value: 'Synthetic QA only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(storeState.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Synthetic reminder',
        actionType: 'notify',
        prompt: 'Synthetic QA only',
        schedule: expect.objectContaining({ kind: 'daily' }),
      }));
    });
    const [input] = (storeState.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(input).not.toHaveProperty('agentPrompt');
    expect(input).not.toHaveProperty('sessionMode');

    // 创建成功：面板收起 + 轻量成功反馈
    await waitFor(() => {
      expect(createPanelWrapper().dataset.open).toBe('false');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Scheduled task "Synthetic reminder" created');
  });

  it('keeps the create form usable while an unrelated mutation is busy', () => {
    resetStore({ busyKey: 'run:auto_morning' });
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('shows a rethrown create error inline without closing the panel', async () => {
    (storeState.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('AUTOMATION_LIMIT_REACHED'));
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic reminder' } });
    fireEvent.change(screen.getByLabelText('Task instructions'), { target: { value: 'Synthetic QA only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const inlineError = await screen.findByRole('alert');
    expect(inlineError).toHaveTextContent('AUTOMATION_LIMIT_REACHED');
    expect(createPanelWrapper().dataset.open).toBe('true');
  });

  it('previews a natural-language parse and fills the form on demand', () => {
    parseMock.mockReturnValue({
      name: 'Review words',
      prompt: 'Review words',
      schedule: { kind: 'daily', time: '08:00' },
      confidence: 'medium',
      matchedText: 'daily at 8am',
    });
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByLabelText('Create with one sentence'), {
      target: { value: 'remind me to review words daily at 8am' },
    });

    expect(screen.getByText('Daily at 08:00')).toBeInTheDocument();
    expect(screen.getByText('daily at 8am')).toBeInTheDocument();
    expect(screen.getByText('Parse confidence: medium, please confirm the schedule')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fill the form' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Review words');
    expect(screen.getByLabelText('Task instructions')).toHaveValue('Review words');
    expect(screen.getByTestId('schedule-editor').dataset.kind).toBe('daily');
    expect(screen.getByTestId('schedule-editor').dataset.time).toBe('08:00');
  });

  it('fills the form from a template', () => {
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start from a template list' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick-template' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Template name');
    expect(screen.getByLabelText('Task instructions')).toHaveValue('Template prompt');
    expect(screen.getByTestId('schedule-editor').dataset.kind).toBe('weekdays');
  });

  it('consumes a create request issued before the workspace mounted (command palette race)', () => {
    // 命令面板先切视图后请求创建；请求发生在监听器挂载前也不能丢
    requestAutomationCreate();
    render(<TodoAutomationWorkspace />);
    expect(createPanelWrapper().dataset.open).toBe('true');
  });

  it('opens the create panel from the automation:request-create window event and closes on Escape', () => {
    render(<TodoAutomationWorkspace />);

    const wrapper = createPanelWrapper();
    expect(wrapper.dataset.open).toBe('false');

    fireEvent(window, new CustomEvent('automation:request-create'));
    expect(wrapper.dataset.open).toBe('true');

    fireEvent.keyDown(document.getElementById('automation-create-panel') as HTMLElement, { key: 'Escape' });
    expect(wrapper.dataset.open).toBe('false');
  });

  it('toggles background execution through the store', () => {
    render(<TodoAutomationWorkspace />);

    fireEvent.click(screen.getByRole('switch', { name: 'Keep running after closing the window' }));
    expect(storeState.setBackgroundEnabled).toHaveBeenCalledWith(false);
  });
});
