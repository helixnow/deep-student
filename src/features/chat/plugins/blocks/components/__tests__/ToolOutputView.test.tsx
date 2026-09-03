import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ToolOutputView } from '../ToolOutputView';

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// 保留模块其余导出（initReactI18next 等）：src/i18n.ts 在模块加载时消费它们，
// 只导出 useTranslation 会让本文件在收集阶段崩溃。t 需跨渲染身份稳定。
vi.mock('react-i18next', async (importOriginal) => {
  const t = (key: string, options?: Record<string, unknown>) => {
    if (options?.ns === 'mcp' && key === 'tools.web_search') return '网络搜索';
    if (options?.ns === 'mcp' && key === 'labels.skill') return '技能';
    return (options?.defaultValue as string | undefined) ?? '';
  };
  return {
    ...(await importOriginal<typeof import('react-i18next')>()),
    useTranslation: () => ({ t }),
  };
});

describe('ToolOutputView load_skills summary', () => {
  it('uses skill provenance so third-party bare names cannot hit builtin labels', () => {
    render(<ToolOutputView output={{
      result: {
        loaded_tools: [
          { name: 'web_search', skill_id: 'community-search' },
          { name: 'builtin-web_search', skill_id: 'knowledge-retrieval' },
        ],
      },
    }} />);

    expect(screen.getByText('community-search · Web Search')).toBeInTheDocument();
    expect(screen.getByText('网络搜索')).toBeInTheDocument();
  });

  it('fails closed for legacy output that has names without source metadata', () => {
    render(<ToolOutputView output={{
      result: {
        loaded_tool_names: ['web_search'],
      },
    }} />);

    expect(screen.getByText('技能 · Web Search')).toBeInTheDocument();
    expect(screen.queryByText('网络搜索')).not.toBeInTheDocument();
  });
});
