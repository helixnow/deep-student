import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { InputBarUI } from '@/features/chat/components/input-bar/InputBarUI';
import { createDefaultPanelStates } from '@/features/chat/core/types/common';

test('opens attachment launcher at the trigger position on the first visible frame', async ({ mount, page }) => {
  const component = await mount(
    <div style={{ width: 720, minHeight: 360, padding: 40 }}>
      <InputBarUI
        inputValue=""
        canSend={false}
        canAbort={false}
        isStreaming={false}
        attachments={[]}
        panelStates={createDefaultPanelStates()}
        onInputChange={() => undefined}
        onSend={() => undefined}
        onAbort={() => undefined}
        onAddAttachment={() => undefined}
        onUpdateAttachment={() => undefined}
        onRemoveAttachment={() => undefined}
        onClearAttachments={() => undefined}
        onSetPanelState={() => undefined}
        placeholder="输入消息"
      />
    </div>
  );

  await component.evaluate(() => {
    (window as any).__attachmentMenuRects = [];

    const sample = (label: string) => {
      const el = document.querySelector<HTMLElement>('.app-menu-content');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      (window as any).__attachmentMenuRects.push({
        label,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    const observer = new MutationObserver(() => {
      if (!document.querySelector('.app-menu-content')) return;
      sample('mutation');
      let frame = 0;
      const tick = () => {
        sample(`raf-${frame}`);
        frame += 1;
        if (frame < 4) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  await component.locator('[data-testid="btn-toggle-attachments"]').click();
  await page.waitForTimeout(150);

  const rects = await component.evaluate(() => (window as any).__attachmentMenuRects);
  expect(rects.length).toBeGreaterThan(0);
  expect(rects).not.toContainEqual(
    expect.objectContaining({
      top: 0,
      left: 0,
    })
  );
});
