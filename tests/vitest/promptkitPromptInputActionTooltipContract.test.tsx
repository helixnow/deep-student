import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
} from '@/promptkit/prompt-input';

describe('PromptInputAction tooltip contract', () => {
  const promptInputSource = readFileSync(
    resolve(process.cwd(), 'src/promptkit/prompt-input.tsx'),
    'utf-8',
  );

  it('routes action tooltip rendering through CommonTooltip', () => {
    expect(promptInputSource).toContain('@/components/shared/CommonTooltip');
    expect(promptInputSource).not.toContain("from './ui/tooltip'");
  });

  it('preserves the action click handler while preventing prompt container bubbling', async () => {
    const user = userEvent.setup();
    const onActionClick = vi.fn();
    const onOuterClick = vi.fn();

    render(
      <div onClick={onOuterClick}>
        <PromptInput>
          <PromptInputActions>
            <PromptInputAction tooltip="添加附件" side="bottom">
              <button type="button" onClick={onActionClick}>
                添加
              </button>
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: '添加' }));

    expect(onActionClick).toHaveBeenCalledTimes(1);
    expect(onOuterClick).not.toHaveBeenCalled();
  });
});
