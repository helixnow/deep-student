import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AnkiTemplateCardFace } from '../AnkiTemplateCardFace';
import { CARD_FACE_STAGE_CSS } from '../utils/cardFaceStyles';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

// 复刻 design-architect 的关键结构：max-width + margin:0 auto 的「纸张」容器
const template = {
  id: 'design-architect',
  name: 'The Architect',
  note_type: 'Basic',
  fields: ['Front', 'Back'],
  front_template: '<div class="arch-card"><div class="arch-q">{{Front}}</div></div>',
  back_template: '<div class="arch-card flipped"><div class="arch-q">{{Back}}</div></div>',
  css_style: '.card { padding: 20px; } .arch-card { max-width: 400px; margin: 0 auto; overflow: hidden; }',
} as unknown as CustomAnkiTemplate;

const card = {
  front: '罗尔定理的条件与结论是什么？',
  back: '连续、可导、端点相等 ⇒ 存在驻点',
  text: '',
  tags: [],
  images: [],
} as unknown as AnkiCard;

function srcDocOf(container: HTMLElement): string {
  const iframe = container.querySelector('iframe');
  expect(iframe).not.toBeNull();
  return iframe!.getAttribute('srcdoc') ?? '';
}

describe('AnkiTemplateCardFace 舞台模式', () => {
  it('stageHeight 下注入块级舞台样式（body 不再是 flex 列，模板纸张按 max-width 取自然宽度）', () => {
    const { container } = render(
      <AnkiTemplateCardFace card={card} template={template} side="front" compact={false} stageHeight={670} />,
    );
    const doc = srcDocOf(container);
    expect(doc).toContain('class="arch-card"');
    expect(doc).toContain(CARD_FACE_STAGE_CSS.trim());
    expect(doc).not.toMatch(/body\s*\{[^}]*display\s*:\s*flex/);
    // 舞台 iframe 至少撑满舞台高度
    expect(container.querySelector('iframe')!.style.height).toBe('670px');
  });

  it('非舞台（预览/列表）不注入舞台样式', () => {
    const { container } = render(
      <AnkiTemplateCardFace card={card} template={template} side="front" compact />,
    );
    expect(srcDocOf(container)).not.toContain('align-content: safe center');
  });
});
