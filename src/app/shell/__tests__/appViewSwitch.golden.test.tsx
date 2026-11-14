/**
 * W38 — App ↔ 视图切换 golden（改造前取证，改造后必须逐字节相同）。
 *
 * 这里复现 App.tsx 的真实视图层组合：官方 shell 插件注册的 `views` 槽位、
 * App 上的三个内容 hook（`useDashboardAndSettingsContents` /
 * `useFeatureViewContents` / `useAuxiliaryViewContents`）、App 内联的
 * task-dashboard / data-management 内容、以及 `RegisteredViewLayer` 的
 * keepAlive/visited/显隐语义。lazyComponents 用同步 marker 替身，避免真实页面
 * 的模块加载噪声；golden 只记录可观察输出：
 *   - 每一步挂载的层（DOM 顺序）、当前可见层、进入/退出 class 与 visibility；
 *   - 每层收到的内容 marker（视图 → 内容的绑定）；
 *   - 每个 marker 的渲染次数（切换视图不得重渲染已挂载内容）。
 *
 * 删除 `useViewLayerContents`、改用 W17 `views` lazy 工厂后，只需替换本文件的
 * 内容提供实现（`useFeatureViewContents` 等 → lazy view 组件），golden 不变。
 */
import React, { Suspense, useMemo } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/lazyComponents', async () => {
  const React = await import('react');
  const { LAZY_MARKERS, Mark } = await import('./viewSwitchMarkers');
  const out: Record<string, unknown> = {};
  for (const name of LAZY_MARKERS) {
    out[name] = function LazyMarkerStub() {
      return React.createElement(Mark, { name });
    };
  }
  out.PageLoadingFallback = function LoadingFallbackStub() {
    return React.createElement('div', { 'data-loading': 'page' });
  };
  return out;
});

vi.mock('@/components/layout', () => ({
  MobilePageScaffold: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', { 'data-scaffold': 'mobile' }, children),
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', { 'data-scroll-area': 'custom' }, children),
}));

vi.mock('@/components/system-status/FeatureUnavailablePanel', () => ({
  FeatureUnavailablePanel: ({ component }: { component: string }) =>
    React.createElement('div', { 'data-unavailable': component }),
}));

vi.mock('@/styles/motion-springs', () => ({ prefersReducedMotion: () => true }));

import { UiKernel } from '@/ui-kernel/kernel';
import { Mark, renders, resetRenders } from './viewSwitchMarkers';
import { UiKernelProvider, useSlot } from '@/ui-kernel/react';
import type { ShellView } from '@/ui-kernel/contracts/shell';
import shellPlugin from '@/ui-plugins/official/shell';
import { RegisteredViewLayer } from '@/ui-plugins/official/shell/RegisteredViewLayer';
import {
  useAuxiliaryViewContents,
  useDashboardAndSettingsContents,
  useFeatureViewContents,
} from '@/app/shell/useViewLayer';
import type { CurrentView } from '@/types/navigation';

const GOLDEN = path.resolve('src/app/shell/__golden__/app-view-switch.json');

const t = ((key: string) => key) as never;
const noop = () => undefined;

const VIEW_SEQUENCE: CurrentView[] = [
  'chat-v2', 'dashboard', 'settings', 'flashcards', 'media',
  'learning-hub', 'todo', 'chat-v2', 'ui-lab', 'data-management', 'chat-v2',
];

interface Env {
  dev: boolean;
  uiLabEnabled: boolean;
  isSmallScreen: boolean;
  workbenchActive: boolean;
}

const ENVIRONMENTS: Env[] = [
  { dev: false, uiLabEnabled: false, isSmallScreen: false, workbenchActive: false },
  { dev: true, uiLabEnabled: true, isSmallScreen: false, workbenchActive: false },
  { dev: true, uiLabEnabled: false, isSmallScreen: true, workbenchActive: false },
  { dev: false, uiLabEnabled: true, isSmallScreen: false, workbenchActive: true },
];

function AppViewLayerHarness({ env, currentView, visited }: {
  env: Env;
  currentView: CurrentView;
  visited: ReadonlySet<CurrentView>;
}) {
  const setCurrentView = useMemo(() => () => undefined, []);
  const { dashboardContent, settingsContent } = useDashboardAndSettingsContents(
    currentView, env.isSmallScreen, setCurrentView as never,
  );
  const taskDashboardContent = useMemo(
    () => <Mark name="taskDashboardContent" />,
    [],
  );
  const {
    skillsManagementContent, flashcardsContent, mediaStudioContent, styleDebugContent,
    learningHubContent, pdfReaderContent, chatV2Content, templateManagementContent,
  } = useFeatureViewContents(
    currentView, false, t, false, noop, noop, 0,
  );
  const dataManagementContent = useMemo(
    () => <Mark name="dataManagementContent" />,
    [],
  );
  const {
    todoContent, sandboxWorkbenchContent, crepeDemoContent, chatV2TestContent, llmPlaygroundContent,
  } = useAuxiliaryViewContents(setCurrentView as never);

  const viewContents: Record<string, React.ReactNode> = {
    dashboardContent, settingsContent, taskDashboardContent, skillsManagementContent,
    dataManagementContent, templateManagementContent, styleDebugContent, learningHubContent,
    mediaStudioContent, sandboxWorkbenchContent, pdfReaderContent, todoContent,
    flashcardsContent, crepeDemoContent, chatV2TestContent, llmPlaygroundContent, chatV2Content,
  };
  const viewEntries = useSlot<ShellView>('views');
  return (
    <>
      {env.workbenchActive ? (
        <Mark name="LazyWorkbenchDesktop" />
      ) : viewEntries
        .filter(({ value }) => !value.visible || value.visible({ dev: env.dev, uiLabEnabled: env.uiLabEnabled }))
        .map(({ value }) => (
          <RegisteredViewLayer
            key={value.id}
            entry={value}
            content={value.contentKey ? viewContents[value.contentKey] : undefined}
            view={value.id as CurrentView}
            currentView={currentView}
            visitedViews={visited}
            errorBoundaryName={value.id}
            navDirection={1}
            extraClass={value.extraClass}
          />
        ))}
    </>
  );
}

interface LayerRecord {
  id: string;
  active: boolean;
  visibility: string | null;
  enter: string;
  content: string | null;
  scaffold: boolean;
}

function readLayers(): LayerRecord[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-view-layer-shell]')).map((el) => {
    const id = el.getAttribute('data-view-layer-shell') ?? '';
    const className = el.className;
    const style = el.style;
    return {
      id,
      active: className.includes('z-10') || className.includes('pointer-events-auto'),
      visibility: style.visibility || null,
      enter: className.includes('desktop-shell-content-enter-rev')
        ? 'enter-rev'
        : className.includes('desktop-shell-content-enter')
          ? 'enter'
          : 'none',
      content: el.querySelector<HTMLElement>('[data-content]')?.getAttribute('data-content') ?? null,
      scaffold: Boolean(el.querySelector('[data-scaffold]')),
    };
  });
}

function contentCounts() {
  const counts: Record<string, number> = {};
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-content]'))) {
    const name = el.getAttribute('data-content') ?? '';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

async function recordScenario(kernel: UiKernel, env: Env) {
  const visited = new Set<CurrentView>(['chat-v2']);
  const steps: unknown[] = [];
  const { rerender } = render(
    <UiKernelProvider kernel={kernel}>
      <Suspense fallback={null}>
        <AppViewLayerHarness env={env} currentView="chat-v2" visited={visited} />
      </Suspense>
    </UiKernelProvider>,
  );
  for (const view of VIEW_SEQUENCE) {
    await act(async () => {
      visited.add(view);
      rerender(
        <UiKernelProvider kernel={kernel}>
          <Suspense fallback={null}>
            <AppViewLayerHarness env={env} currentView={view} visited={visited} />
          </Suspense>
        </UiKernelProvider>,
      );
    });
    const layers = readLayers();
    steps.push({
      view,
      branch: env.workbenchActive ? 'workbench' : 'views',
      layers,
      mountedContents: contentCounts(),
      markerRenders: Object.fromEntries(
        Object.entries(renders).filter(([name]) => name !== '__all').sort(([a], [b]) => a.localeCompare(b)),
      ),
      markerRenderTotal: renders.__all ?? 0,
    });
  }
  cleanup();
  return steps;
}

function recordAll() {
  const environments: unknown[] = [];
  const kernel = new UiKernel();
  return (async () => {
    await kernel.install(shellPlugin, { origin: 'builtin' });
    for (const env of ENVIRONMENTS) {
      resetRenders();
      environments.push({ env, steps: await recordScenario(kernel, env) });
    }
    await kernel.dispose();
    return {
      $comment: 'W38 App/view-switch golden. Generated before any App refactor; must stay byte-identical.',
      order: VIEW_SEQUENCE,
      environments,
    };
  })();
}

describe('App view switching', () => {
  let kernel: UiKernel;
  beforeEach(async () => {
    kernel = new UiKernel();
    await kernel.install(shellPlugin, { origin: 'builtin' });
  });
  afterEach(async () => {
    cleanup();
    await kernel.dispose();
  });

  it('matches the recorded view-switch golden', async () => {
    const actual = await (async () => {
      const environments: unknown[] = [];
      for (const env of ENVIRONMENTS) {
        resetRenders();
        environments.push({ env, steps: await recordScenario(kernel, env) });
      }
      return { order: VIEW_SEQUENCE, environments };
    })();
    if (process.env.W38_UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify({
        $comment: 'W38 App/view-switch golden. Generated before any App refactor; must stay byte-identical.',
        ...actual,
      }, null, 2)}\n`);
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    expect(actual).toEqual({ order: golden.order, environments: golden.environments });
  });

  it('keeps the golden self-consistent with the shell inventory', async () => {
    const views = kernel.slots.list<ShellView>('views').map(({ value }) => value);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const recorded = new Set<string>();
    for (const scenario of golden.environments) {
      for (const step of scenario.steps) {
        if (step.branch === 'workbench') continue;
        for (const layer of step.layers) recorded.add(layer.id);
      }
    }
    for (const id of recorded) {
      expect(views.some((view) => view.id === id)).toBe(true);
    }
  });
});

// Exported so a future fixture refresh can be produced without touching assertions.
export { recordAll };
