import React from 'react';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 1 },
  registerBackHandler: () => () => {},
}));
vi.mock('../../../MindMapActiveContext', () => ({ useMindMapIsActive: () => true }));

import { BlankActionPopup } from '../BlankActionPopup';

/**
 * 背诵模式「单独挖空」：选中文字后弹出的气泡曾被 .mindmap-container 的
 * position: relative 打回 body 文档流末尾（视口外），按钮看不见、点不到。
 */
describe('BlankActionPopup positioning', () => {
  it('is fixed-positioned inline so stylesheet order cannot push it out of the viewport', () => {
    render(
      <BlankActionPopup x={200} y={300} isAlreadyBlanked={false} onBlank={() => {}} onUnblank={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('toolbar').style.position).toBe('fixed');
  });

  it('keeps .mindmap-container overlays fixed in the stylesheet as well', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/features/mindmap/styles/mindmap.css'), 'utf8');
    const relativeAt = css.indexOf('position: relative;');
    const fixedRuleAt = css.indexOf('.mindmap-container.fixed {');
    expect(fixedRuleAt).toBeGreaterThan(relativeAt);
  });
});
