import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

  it('opens the full acknowledgements list in a dialog only after the user clicks the trigger', async () => {
    const user = userEvent.setup();

    render(<OpenSourceAcknowledgementsSection />);

    expect(screen.getByRole('button', { name: '查看致谢名单' })).toBeInTheDocument();
    expect(screen.queryByText('Tailwind CSS')).not.toBeInTheDocument();
    expect(screen.queryByText('ESLint')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看致谢名单' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: '关闭' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
