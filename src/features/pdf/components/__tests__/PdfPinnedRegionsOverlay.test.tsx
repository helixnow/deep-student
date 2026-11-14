import React, { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { PdfPinnedRegionsOverlay, type PinnedPdfRegion } from '../PdfPinnedRegionsOverlay';

function Harness({
  onJumpToPage = vi.fn(),
  onRemove = vi.fn(),
}: {
  onJumpToPage?: (page: number, label?: string) => void;
  onRemove?: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [regions, setRegions] = useState<PinnedPdfRegion[]>([
    {
      id: 'pin-1',
      page: 3,
      title: 'Attention · 第 3 页对照',
      blob: new Blob(['png'], { type: 'image/png' }),
      imageUrl: 'blob:test-figure-3',
      x: 40,
      y: 20,
      expanded: false,
      collapsed: false,
    },
  ]);

  return (
    <div ref={containerRef} style={{ width: 800, height: 600, position: 'relative' }}>
      <PdfPinnedRegionsOverlay
        containerRef={containerRef}
        regions={regions}
        documentTitle="Attention.pdf"
        onUpdateRegion={(id, patch) =>
          setRegions((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
        }
        onRemoveRegion={(id) => {
          onRemove(id);
          setRegions((prev) => prev.filter((r) => r.id !== id));
        }}
        onJumpToPage={onJumpToPage}
      />
    </div>
  );
}

describe('PdfPinnedRegionsOverlay', () => {
  it('renders floating reference card, toggles collapse/expand, jumps to source page, and closes', () => {
    const onJumpToPage = vi.fn();
    const onRemove = vi.fn();
    render(<Harness onJumpToPage={onJumpToPage} onRemove={onRemove} />);

    expect(screen.getByTestId('pdf-pinned-card')).toBeInTheDocument();
    expect(screen.getByAltText('Attention · 第 3 页对照')).toBeInTheDocument();

    // 跳回原页
    fireEvent.click(screen.getByRole('button', { name: 'pdf:pinned.jump_to_source|{"page":3}' }));
    expect(onJumpToPage).toHaveBeenCalledWith(3, 'Attention · 第 3 页对照');

    // 折叠为胶囊后隐藏图片，展开后恢复
    fireEvent.click(screen.getByRole('button', { name: 'pdf:pinned.collapse_card' }));
    expect(screen.queryByAltText('Attention · 第 3 页对照')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'pdf:pinned.expand_card' }));
    expect(screen.getByAltText('Attention · 第 3 页对照')).toBeInTheDocument();

    // 关闭浮窗
    fireEvent.click(screen.getByRole('button', { name: 'pdf:a11y.close' }));
    expect(onRemove).toHaveBeenCalledWith('pin-1');
    expect(screen.queryByTestId('pdf-pinned-card')).not.toBeInTheDocument();
  });
});
