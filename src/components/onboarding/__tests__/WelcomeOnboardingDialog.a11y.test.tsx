/**
 * WelcomeOnboardingDialog a11y 契约
 *
 * 锁定可达性语义，不锁文案（common.json 归属其他 PR）、不改流程逻辑：
 * - role="dialog" + aria-modal，aria-labelledby 指向 h1 标题
 * - 副标题 <p> 有稳定 id，dialog 通过 aria-describedby 指向它
 * - 可访问名称/描述与实际渲染的标题/副标题文本一致
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WelcomeOnboardingDialog } from '../WelcomeOnboardingDialog';

describe('WelcomeOnboardingDialog a11y 契约', () => {
  it('dialog 通过 aria-labelledby / aria-describedby 暴露标题与副标题', () => {
    render(<WelcomeOnboardingDialog onConfigure={vi.fn()} onSkip={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'welcome-onboarding-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'welcome-onboarding-subtitle');

    const title = document.getElementById('welcome-onboarding-title');
    const subtitle = document.getElementById('welcome-onboarding-subtitle');
    expect(title).not.toBeNull();
    expect(subtitle).not.toBeNull();
    expect(title?.textContent).toBeTruthy();
    expect(subtitle?.textContent).toBeTruthy();

    expect(dialog).toHaveAccessibleName(title!.textContent!.trim());
    expect(dialog).toHaveAccessibleDescription(subtitle!.textContent!.trim());
  });

  it('副标题 id 稳定且唯一，指向真实渲染的 <p>', () => {
    render(<WelcomeOnboardingDialog onConfigure={vi.fn()} onSkip={vi.fn()} />);
    const subtitles = document.querySelectorAll('#welcome-onboarding-subtitle');
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0].tagName).toBe('P');
  });
});
