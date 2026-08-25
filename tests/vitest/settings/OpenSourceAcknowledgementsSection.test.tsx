import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setViewportWidth = (width: number) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const minWidth = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
    return {
      matches: minWidth ? width >= Number(minWidth[1]) : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
};

// 默认以桌面宽度覆盖 Dialog 行为；移动内联契约在对应测试内显式切换。
beforeEach(() => {
  setViewportWidth(1280);
});

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDragControls: () => ({ start: vi.fn() }),
  motion: new Proxy({}, {
    get: (_, tag: string) => {
      const Component = ({ children, ...props }: Record<string, unknown>) => {
        const Tag = tag as keyof JSX.IntrinsicElements;
        return React.createElement(Tag, props, children);
      };

      return Component;
    },
  }),
}));

vi.mock('@tauri-apps/api/path', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveResource: vi.fn(async (resource: string) => `/mock/resources/${resource}`),
}));

vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTextFile: vi.fn(async () => 'RESOURCE THIRD-PARTY NOTICES\nrs-fsrs@1.2.1'),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg2?: string | Record<string, unknown>, arg3?: Record<string, unknown>) => {
      const fallback = typeof arg2 === 'string' ? arg2 : undefined;
      const options = (typeof arg2 === 'object' && arg2 !== null ? arg2 : arg3) ?? {};
      const translations: Record<string, string> = {
        'acknowledgements.openSource.title': '开源项目致谢',
        'acknowledgements.openSource.description': 'DeepStudent 依托以下成熟的开源生态快速发展，感谢所有社区长期的维护与创新。',
        'acknowledgements.openSource.openDialog': '查看致谢名单',
        'acknowledgements.openSource.closeDialog': '关闭',
        'acknowledgements.openSource.projectLicense': '项目许可证',
        'acknowledgements.openSource.thirdPartyLicense': '第三方许可证',
        'acknowledgements.openSource.projectLicenseDescription': '项目许可证说明',
        'acknowledgements.openSource.thirdPartyLicenseDescription': '第三方许可证说明',
        'acknowledgements.openSource.backToAcknowledgements': '返回致谢名单',
        'acknowledgements.openSource.loadingLicenses': '正在加载许可证...',
        'acknowledgements.openSource.licenseLoadError': '无法加载许可证文本。',
        'acknowledgements.openSource.categories.coreStack': '核心框架与构建',
        'acknowledgements.openSource.categories.uiAndInteraction': '界面与交互',
        'acknowledgements.openSource.categories.contentEditing': '内容与编辑',
        'acknowledgements.openSource.categories.stateAndData': '状态管理与数据协作',
        'acknowledgements.openSource.categories.visualization': '拖拽与可视化',
        'acknowledgements.openSource.categories.utilities': '工具与体验增强',
        'acknowledgements.openSource.categories.aiAndAgents': 'AI 与协议能力',
        'acknowledgements.openSource.categories.rustEcosystem': 'Tauri 与 Rust 生态',
        'acknowledgements.openSource.categories.testingAndTooling': '测试与工程工具',
        'acknowledgements.openSource.expand': `展开${String(options?.category ?? '')}`,
        'acknowledgements.openSource.collapse': `收起${String(options?.category ?? '')}`,
      };

      return translations[key] ?? fallback ?? key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { OpenSourceAcknowledgementsSection } from '@/features/settings';

describe('OpenSourceAcknowledgementsSection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the acknowledgements collapsed until the user opens the dialog', () => {
    render(<OpenSourceAcknowledgementsSection />);

    expect(screen.getByText('开源项目致谢')).toBeInTheDocument();
    expect(screen.getByText('DeepStudent 依托以下成熟的开源生态快速发展，感谢所有社区长期的维护与创新。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看致谢名单' })).toBeInTheDocument();
    expect(screen.queryByText('9 个生态分组，77 个项目')).not.toBeInTheDocument();
    expect(screen.queryByText('核心框架与构建')).not.toBeInTheDocument();
    expect(screen.queryByText('React 18')).not.toBeInTheDocument();
    expect(screen.queryByText('Tailwind CSS')).not.toBeInTheDocument();
  });

  it('expands the full acknowledgements list inline only after the user clicks the trigger', async () => {
    // P1-9 移动端分支：致谢名单在 About 页内联展开，而不是打开 Dialog。
    setViewportWidth(390);
    const user = userEvent.setup();

    render(<OpenSourceAcknowledgementsSection />);

    expect(screen.getByRole('button', { name: '查看致谢名单' })).toBeInTheDocument();
    expect(screen.queryByText('Tailwind CSS')).not.toBeInTheDocument();
    expect(screen.queryByText('ESLint')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看致谢名单' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看致谢名单' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText('9 个生态分组，77 个项目')).not.toBeInTheDocument();
    expect(screen.queryAllByText('6 项')).toHaveLength(0);
    expect(screen.queryAllByText('7 项')).toHaveLength(0);
    expect(screen.getByText('核心框架与构建')).toBeInTheDocument();
    expect(screen.getByText('React 18')).toBeInTheDocument();
    expect(screen.getByText('Tailwind CSS')).toBeInTheDocument();
    expect(screen.getByText('Phosphor Icons')).toBeInTheDocument();
    expect(screen.getByText('React Heat Map')).toBeInTheDocument();
    expect(screen.getAllByText('Vitest').length).toBeGreaterThan(0);
    expect(screen.getByText('ESLint')).toBeInTheDocument();
    expect(screen.getAllByText('测试与工程工具').length).toBeGreaterThan(0);
    expect(screen.queryByText('Reactour')).not.toBeInTheDocument();
    expect(screen.queryByText('Defuddle')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看致谢名单' }));

    expect(screen.getByRole('button', { name: '查看致谢名单' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('React 18')).not.toBeInTheDocument();
    expect(screen.queryByText('Tailwind CSS')).not.toBeInTheDocument();
  });

  it('loads the third-party notices via fetch in plain web runtime and returns to the list', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => 'DEEPSTUDENT THIRD-PARTY NOTICES\nrs-fsrs@1.2.1',
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<OpenSourceAcknowledgementsSection />);
    await user.click(screen.getByRole('button', { name: '查看致谢名单' }));
    await user.click(screen.getByRole('button', { name: '第三方许可证' }));

    expect(await screen.findByText(/DEEPSTUDENT THIRD-PARTY NOTICES/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('./legal/THIRD_PARTY_NOTICES.txt');
    expect(screen.queryByText('React 18')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '返回致谢名单' }));
    expect(screen.getByText('React 18')).toBeInTheDocument();
  });

  it('reads the single bundled resources copy in the Tauri runtime instead of fetching', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    try {
      render(<OpenSourceAcknowledgementsSection />);
      await user.click(screen.getByRole('button', { name: '查看致谢名单' }));
      await user.click(screen.getByRole('button', { name: '第三方许可证' }));

      expect(await screen.findByText(/RESOURCE THIRD-PARTY NOTICES/)).toBeInTheDocument();

      const { resolveResource } = await import('@tauri-apps/api/path');
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      expect(vi.mocked(resolveResource)).toHaveBeenCalledWith('licenses/THIRD_PARTY_NOTICES.txt');
      expect(vi.mocked(readTextFile)).toHaveBeenCalledWith('/mock/resources/licenses/THIRD_PARTY_NOTICES.txt');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
