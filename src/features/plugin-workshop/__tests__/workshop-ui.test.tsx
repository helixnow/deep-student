import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkshopConfirmationCard } from '../WorkshopConfirmationCard';
import { WorkshopCreations } from '../WorkshopCreations';
import { useWorkshop } from '../useWorkshop';
import { describeWorkshopError } from '../errors';
import { workshopActions, type WorkshopAdapter, type WorkshopItem } from '../types';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<object>()), ...(await import('../../plugin-manager/__tests__/i18nMock')).i18nMock() }));

const item: WorkshopItem = {
  id: 'vocabulary', proposalId: 'proposal-1', name: '每日单词', version: '2', previousVersion: '1',
  capabilities: ['在插件自己的数据目录里保存数据'], changes: ['新增错题入口'], trust: 'full', phase: 'proposed',
  places: [{ kind: 'app', title: '每日单词' }],
};
const fresh: WorkshopItem = { ...item, previousVersion: undefined, version: '' };

describe('plugin workshop UI (adapter component tests, not Host E2E)', () => {
  it('proposed: 「开始做」 starts, 「不要了」 declines; plan, where-to-find and section labels, no risk block yet', () => {
    const onAction = vi.fn();
    render(<WorkshopConfirmationCard item={fresh} embedded onAction={onAction} />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('每日单词');
    expect(screen.getByText('它能做什么').className).toContain('text-xs');
    expect(screen.getByText('这次会做的')).toBeInTheDocument();
    expect(screen.getByTestId('workshop-where').textContent).toBe('装好后在哪里找到它：全部应用 → 每日单词');
    expect(screen.queryByTestId('workshop-risk')).toBeNull();
    expect(screen.queryByText('视觉未验证')).toBeNull();
    expect(screen.queryByText('完全信任')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开始做' }));
    expect(onAction).toHaveBeenCalledWith('confirm');
    fireEvent.click(screen.getByRole('button', { name: '不要了' }));
    expect(onAction).toHaveBeenCalledWith('cancel');
  });

  it('ready: primary 「安装」, secondary 「不要了」, the risk said once in plain words', () => {
    const onAction = vi.fn();
    render(<WorkshopConfirmationCard item={{ ...fresh, phase: 'ready', version: '1.0.0' }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-phase').textContent).toBe('等你确认');
    expect(screen.getByTestId('workshop-risk').textContent).toBe('它和 DeepStudent 一起运行，能做到应用本身能做的事。安装前工坊已经检查过它能正常装上、正常卸下。用着不对劲，随时可以关掉或卸载。');
    // Version stays off the title of a new work.
    expect(screen.queryByText(/v1\.0\.0/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    expect(onAction).toHaveBeenLastCalledWith('confirm');
    fireEvent.click(screen.getByRole('button', { name: '不要了' }));
    expect(onAction).toHaveBeenLastCalledWith('cancel');
    expect(workshopActions('ready')).toEqual(['confirm', 'cancel']);
  });

  it('a modification card shows its version and 「相对 v<旧> 的变化」', () => {
    render(<WorkshopConfirmationCard item={{ ...item, phase: 'ready' }} onAction={vi.fn()} />);
    expect(screen.getByText('每日单词 · v2')).toBeInTheDocument();
    expect(screen.getByText('相对 v1 的变化')).toBeInTheDocument();
  });

  it('proposed: says that 开始做 approves writing and test-loading, asks for a missing address inside the card, sends it with 开始做', () => {
    const onAction = vi.fn();
    const settings = [{ key: 'calendarUrl', title: '课表日历地址（.ics）', kind: 'ics-url' as const }];
    render(<WorkshopConfirmationCard item={{ ...item, phase: 'proposed', settings }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-start-consent').textContent).toContain('同意 AI 按上面的计划写出代码，并在应用里试着装上、卸下检查一遍');
    const start = screen.getByTestId('workshop-action-start');
    expect(start).toBeDisabled();
    expect(screen.getByText('怎么找到 .ics 地址？')).toBeTruthy();
    const input = screen.getByLabelText('课表日历地址（.ics）');
    fireEvent.change(input, { target: { value: 'http://jw.school.edu.cn/a.ics' } });
    expect(start).toBeDisabled();
    fireEvent.change(input, { target: { value: ' https://jw.school.edu.cn/a.ics ' } });
    fireEvent.click(start);
    expect(onAction).toHaveBeenCalledWith('confirm', { calendarUrl: 'https://jw.school.edu.cn/a.ics' });
  });

  it('failed because the address is not a calendar: the field comes back with 「改好了，再试一次」; other failures offer no retry here', () => {
    const onAction = vi.fn();
    const settings = [{ key: 'calendarUrl', title: '课表日历地址（.ics）', kind: 'ics-url' as const, value: 'https://jw.school.edu.cn/login' }];
    const view = render(<WorkshopConfirmationCard item={{ ...item, phase: 'failed', settings, error: 'WORKSHOP_LINK: 「课表日历地址（.ics）」 is not a calendar (.ics)' }} onAction={onAction} />);
    fireEvent.change(screen.getByLabelText('课表日历地址（.ics）'), { target: { value: 'https://jw.school.edu.cn/cal.ics' } });
    fireEvent.click(screen.getByTestId('workshop-action-retry'));
    expect(onAction).toHaveBeenCalledWith('confirm', { calendarUrl: 'https://jw.school.edu.cn/cal.ics' });
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'failed', settings, error: 'WORKSHOP_INVALID: Build failed' }} onAction={onAction} />);
    expect(screen.queryByTestId('workshop-action-retry')).toBeNull();
  });

  it('editing: the Agent is changing a started work itself, said honestly and without a decision that would race it', () => {
    render(<WorkshopConfirmationCard item={{ ...item, phase: 'editing' }} onAction={vi.fn()} />);
    expect(screen.getByTestId('workshop-editing').textContent).toBe('AI 正在按检查结果改代码，改完会在这里等你确认。');
    expect(screen.queryByTestId('workshop-action-start')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('cancelled: a quiet line and no actions', () => {
    render(<WorkshopConfirmationCard item={{ ...item, phase: 'cancelled' }} onAction={vi.fn()} />);
    expect(screen.getByTestId('workshop-cancelled').textContent).toBe('已经不要了。想再做，跟 AI 说一声就行。');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('progress says what is happening: files written, the address check, compile, test load, the repair round; 「停下」 while generating; nothing once installing', () => {
    const onAction = vi.fn();
    const view = render(<WorkshopConfirmationCard item={{ ...item, phase: 'generating', progress: { stage: 'making' } }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-progress').textContent).toBe('正在做：AI 正在写代码…');
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'generating', progress: { stage: 'making', files: ['package.json', 'index.ts'] } }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-progress').textContent).toBe('正在做：已写好 package.json、index.ts');
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'generating', progress: { stage: 'checking', step: 'link' } }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-progress').textContent).toBe('正在检查你填的地址能不能读到日历…');
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'generating', progress: { stage: 'checking', step: 'compile' } }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-progress').textContent).toBe('正在自己检查：编译代码…');
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'generating', progress: { stage: 'checking', step: 'load' } }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-progress').textContent).toBe('正在自己检查：试着装上再卸下…');
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'generating', progress: { stage: 'fixing', attempt: 2 } }} onAction={onAction} />);
    expect(screen.getByTestId('workshop-progress').textContent).toBe('发现问题，正在修（第 2 次）');
    expect(screen.queryByText(/自动编译与修复/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '停下' }));
    expect(onAction).toHaveBeenCalledWith('cancel');
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'installing' }} onAction={onAction} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('action errors read as a plain sentence with a next step; raw text folded under 技术信息', () => {
    const onRefresh = vi.fn();
    render(<WorkshopConfirmationCard item={{ ...item, phase: 'ready' }} error="WORKSHOP_CONFLICT: confirmation is stale" onAction={vi.fn()} onRefresh={onRefresh} />);
    expect(screen.getByText('这张卡片的内容已经更新过了，刷新一下再确认。')).toBeInTheDocument();
    expect(screen.getByTestId('workshop-error-technical').textContent).toContain('WORKSHOP_CONFLICT');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('offers restore/modify for an uninstalled creation without regenerating it', () => {
    const onAction = vi.fn();
    const onModify = vi.fn();
    const undone = { ...item, phase: 'undone' as const };
    render(<WorkshopCreations items={[undone]} onAction={onAction} onModify={onModify} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(onAction).toHaveBeenCalledWith('restore', undone);
    expect(onModify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '让 AI 改' }));
    expect(onModify).toHaveBeenCalledWith(undone);
    expect(screen.getByText('已卸载')).toBeInTheDocument();
  });

  it('action vocabulary per phase', () => {
    expect(workshopActions('installed')).toEqual(['try', 'disable', 'undo', 'restore', 'export', 'redo']);
    expect(workshopActions('failed')).toEqual(['restore', 'undo', 'confirm', 'discard', 'redo', 'reduce']);
    expect(workshopActions('editing')).toEqual([]);
    // A turned-down or replaced proposal can only be deleted (the card offers it only when nothing was installed).
    expect(workshopActions('cancelled')).toEqual(['discard']);
    expect(workshopActions('superseded')).toEqual(['discard']);
  });

  it('deduplicates confirmation clicks and uses the returned Host state', async () => {
    let resolve!: (value: { item: WorkshopItem }) => void;
    const adapter: WorkshopAdapter = {
      list: vi.fn().mockResolvedValue([item]), get: vi.fn(), subscribe: () => vi.fn(),
      act: vi.fn(() => new Promise(done => { resolve = done; })),
    };
    const { result } = renderHook(() => useWorkshop(adapter));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { void result.current.act('confirm', item); void result.current.act('confirm', item); });
    expect(adapter.act).toHaveBeenCalledTimes(1);
    expect(result.current.items[0].phase).toBe('proposed');
    await act(async () => { resolve({ item: { ...item, phase: 'generating' } }); });
    expect(result.current.items[0].phase).toBe('generating');
  });

  it('reconciles ambiguous failures without claiming installed or rolled back', async () => {
    const adapter: WorkshopAdapter = {
      list: vi.fn().mockResolvedValue([item]), get: vi.fn(), subscribe: () => vi.fn(),
      act: vi.fn().mockRejectedValue(new Error('connection lost')),
    };
    const { result } = renderHook(() => useWorkshop(adapter));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.act('confirm', item); });
    expect(adapter.list).toHaveBeenCalledTimes(2);
    expect(result.current.items[0].phase).toBe('proposed');
    expect(result.current.error).toBe('connection lost');
  });

  it('omits outer Card border and padding when embedded inside chat tool output', () => {
    const { container, rerender } = render(<WorkshopConfirmationCard item={item} onAction={vi.fn()} />);
    const standalone = container.firstElementChild as HTMLElement;
    expect(standalone.className).toContain('border');
    expect(standalone.className).toContain('rounded-[var(--radius-card)]');
    rerender(<WorkshopConfirmationCard item={item} embedded onAction={vi.fn()} />);
    const embeddedRoot = container.firstElementChild as HTMLElement;
    expect(embeddedRoot.className).toContain('space-y-3');
    expect(embeddedRoot.className).not.toContain('rounded-[var(--radius-card)]');
    expect(screen.getByRole('button', { name: '开始做' })).toBeInTheDocument();
  });
});

describe('describeWorkshopError', () => {
  it.each([
    ['WORKSHOP_STATE: background generation interrupted by Host shutdown', 'interrupted', 'retry'],
    ['ENGINE_INCOMPATIBLE: plugin "workshop.plugin-x" requires ^0.19', 'incompatible', 'redo'],
    ['WORKSHOP_SELF_CHECK_UNAVAILABLE: application services unavailable: notes', 'servicesDisabled', 'none'],
    ['Installed candidate is not active; retained version is running', 'notActive', 'repair'],
    ['WORKSHOP_INVALID: a plugin that declares agentTools cannot import modules ("node:fs"); network access is tool.fetch', 'sealed', 'repair'],
    ['WORKSHOP_INVALID: a plugin that declares agentTools cannot use the global "fetch"; use tool.fetch', 'sealed', 'repair'],
    ['WORKSHOP_CONFLICT: confirmation is stale', 'conflict', 'refresh'],
    ['WORKSHOP_STATE: cannot act in installed', 'state', 'refresh'],
    ['WORKSHOP_INVALID: work belongs to another conversation', 'otherConversation', 'none'],
    ['SAFE_MODE_ACTIVE: workshop code cannot run or install in safe mode', 'safeMode', 'none'],
    ['UI_ERROR_BUDGET: Render failed', 'crashed', 'repair'],
    ['WORKSHOP_INVALID: unresolved source input ./x', 'invalid', 'repair'],
    ['something odd', 'unknown', 'repair'],
  ])('%s → %s', (raw, key, next) => {
    expect(describeWorkshopError(raw, '编成口诀')).toMatchObject({ key, next, raw });
  });

  it('names the plugin in the crash sentence', () => {
    expect(describeWorkshopError('UI_ERROR_BUDGET: x', '编成口诀').values).toEqual({ name: '编成口诀' });
  });
});
