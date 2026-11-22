import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickWebViewFiles } from '../pickWebViewFiles';

describe('pickWebViewFiles', () => {
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let clickedInputs: HTMLInputElement[];

  beforeEach(() => {
    vi.useFakeTimers();
    clickedInputs = [];
    clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      clickedInputs.push(this);
    });
  });

  afterEach(() => {
    clickSpy.mockRestore();
    vi.useRealTimers();
    document.querySelectorAll('input[type="file"]').forEach((el) => el.remove());
  });

  it('resolves selected files on change and cleans up input', async () => {
    const file = new File(['hello'], 'notes.md', { type: 'text/markdown' });
    const promise = pickWebViewFiles(true, '.md');
    const input = clickedInputs[0];
    expect(input).toBeDefined();
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('.md');

    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));

    await expect(promise).resolves.toEqual([file]);
    expect(input.isConnected).toBe(false);
  });

  it('unlocks pickerOpen via window focus fallback when mobile browser omits cancel event', async () => {
    const first = pickWebViewFiles(false, 'image/*');
    expect(clickedInputs).toHaveLength(1);

    // 未结束前并发点击会被去重锁拦住
    await expect(pickWebViewFiles(false, 'image/*')).resolves.toEqual([]);

    // 模拟移动端取消文件选择：只触发 window focus，不触发 input cancel
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(450);

    await expect(first).resolves.toEqual([]);
    expect(clickedInputs[0].isConnected).toBe(false);

    // 锁必须已释放，后续再次打开选择器应正常工作
    const file = new File(['img'], 'photo.png', { type: 'image/png' });
    const second = pickWebViewFiles(false, 'image/*');
    expect(clickedInputs).toHaveLength(2);
    Object.defineProperty(clickedInputs[1], 'files', { value: [file], configurable: true });
    clickedInputs[1].dispatchEvent(new Event('change'));
    await expect(second).resolves.toEqual([file]);
  });

  it('still delivers selected files when focus fires slightly before change', async () => {
    const file = new File(['img'], 'camera.jpg', { type: 'image/jpeg' });
    const promise = pickWebViewFiles(false, 'image/*');
    const input = clickedInputs[0];

    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));

    await expect(promise).resolves.toEqual([file]);
  });
});
