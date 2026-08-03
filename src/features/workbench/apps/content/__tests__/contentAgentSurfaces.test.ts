/**
 * ACR 4.0（A7）— translation/essay/image 内容窗能力补全 + exam 表面动作诚实化
 *
 * - contentAgentSurfaces 注册表：观察投影只在视图挂载期可得；
 * - image manifest：setZoom 走真实表面落点，未挂载诚实失败，成功带 undo；
 * - exam manifest：showSettings/setFocusMode 不再硬拒，经表面 ACK 兑现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getContentAgentSurface,
  registerContentAgentSurface,
} from '../contentAgentSurfaces';
import {
  createExamAgentManifest,
  createResourceContentManifest,
} from '../agentManifests';
import { handleExamActivation } from '../register';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('contentAgentSurfaces 注册表', () => {
  it('注册/注销生命周期，晚到的注销不误删新表面', () => {
    const first = { getSummary: () => ({ ready: true }) };
    const second = { getSummary: () => ({ ready: false }) };
    const disposeFirst = registerContentAgentSurface('image', 'img_1', first);
    expect(getContentAgentSurface('image', 'img_1')).toBe(first);

    const disposeSecond = registerContentAgentSurface('image', 'img_1', second);
    // 旧注册的清理晚到：不得移除新表面
    disposeFirst();
    expect(getContentAgentSurface('image', 'img_1')).toBe(second);
    disposeSecond();
    expect(getContentAgentSurface('image', 'img_1')).toBeNull();
  });
});

describe('image manifest setZoom（真实表面落点）', () => {
  const manifest = createResourceContentManifest(
    'image',
    vi.fn(async () => ({ handled: false as const, code: 'UNSUPPORTED_ACTION' })),
  );
  const ctx = { windowId: 'img-win', typeId: 'image', instanceKey: 'img_1' };

  it('视图未挂载 → observe 无 setZoom 可用动作，execute 诚实失败', async () => {
    const observation = await manifest.observe!(ctx);
    expect(observation.availableActions).not.toContain('setZoom');
    expect(observation.state).not.toHaveProperty('content');

    const result = await manifest.execute!(ctx, { name: 'setZoom', args: { zoom: 150 } });
    expect(result).toMatchObject({ handled: false, code: 'ACTION_UNAVAILABLE' });
  });

  it('视图挂载 → observe 投影缩放态，setZoom 成功并带恢复 undo', async () => {
    const setZoom = vi.fn(() => ({ handled: true, changed: true }));
    cleanups.push(registerContentAgentSurface('image', 'img_1', {
      getSummary: () => ({
        ready: true,
        naturalWidth: 800,
        naturalHeight: 600,
        zoomPercent: 100,
        fitMode: true,
        rotation: 0,
      }),
      getZoomState: () => ({ zoomPercent: 100, fitMode: true }),
      setZoom,
    }));

    const observation = await manifest.observe!(ctx);
    expect(observation.availableActions).toContain('setZoom');
    expect(observation.state).toMatchObject({
      content: { naturalWidth: 800, zoomPercent: 100, fitMode: true },
    });

    const result = await manifest.execute!(ctx, { name: 'setZoom', args: { zoom: 150 } });
    expect(setZoom).toHaveBeenCalledWith(150);
    expect(result).toMatchObject({
      handled: true,
      acknowledged: true,
      changed: true,
      undo: { inverse: { name: 'setZoom', args: { zoom: 'fit' } } },
    });
  });

  it('无效 zoom 参数 → INVALID_ARGS，不触碰表面', async () => {
    const setZoom = vi.fn(() => ({ handled: true }));
    cleanups.push(registerContentAgentSurface('image', 'img_1', {
      getSummary: () => ({ ready: true }),
      setZoom,
    }));
    const result = await manifest.execute!(ctx, { name: 'setZoom', args: { zoom: 'huge' } });
    expect(result).toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("capabilities 声明 setZoom（number 或 'fit'）", () => {
    const capability = manifest.capabilities.find((item) => item.name === 'setZoom');
    expect(capability).toBeDefined();
    expect(capability).toMatchObject({ mutates: true, reversible: true });
  });
});

describe('translation/essay manifest 观察投影', () => {
  it('translation：挂载后 observe 携带字数/段落摘要；无写能力声明', async () => {
    const manifest = createResourceContentManifest(
      'translation',
      vi.fn(async () => ({ handled: false as const })),
    );
    expect(manifest.capabilities).toHaveLength(0);

    cleanups.push(registerContentAgentSurface('translation', 'tr_1', {
      getSummary: () => ({
        ready: true,
        sourceChars: 120,
        translatedChars: 96,
        sourceParagraphs: 3,
        translatedParagraphs: 3,
        saveStatus: 'idle',
      }),
    }));
    const observation = await manifest.observe!({
      windowId: 'tr-win', typeId: 'translation', instanceKey: 'tr_1',
    });
    expect(observation.state).toMatchObject({
      content: { sourceChars: 120, translatedParagraphs: 3 },
    });
  });

  it('essay：摘要随 revision 变化（OCC 能感知内容更新）', async () => {
    const manifest = createResourceContentManifest(
      'essay',
      vi.fn(async () => ({ handled: false as const })),
    );
    let chars = 10;
    cleanups.push(registerContentAgentSurface('essay', 'es_1', {
      getSummary: () => ({ ready: true, inputChars: chars }),
    }));
    const ctx = { windowId: 'es-win', typeId: 'essay', instanceKey: 'es_1' };
    const first = await manifest.observe!(ctx);
    chars = 999;
    const second = await manifest.observe!(ctx);
    expect(first.revision).not.toBe(second.revision);
    expect(second.state).toMatchObject({ content: { inputChars: 999 } });
  });
});

describe('exam manifest 表面动作诚实化（不再硬拒）', () => {
  it('showSettings：视图 ACK 后成功，changed/undo 来自视图报告的前值', async () => {
    const manifest = createExamAgentManifest(handleExamActivation);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{
        open?: boolean;
        acknowledge?: (result: {
          handled: boolean;
          changed?: boolean;
          previousOpen?: boolean;
        }) => void;
      }>).detail;
      detail?.acknowledge?.({ handled: true, changed: true, previousOpen: false });
    };
    window.addEventListener('exam:openSettings', listener);
    try {
      const result = await manifest.execute!(
        { windowId: 'exam-win', typeId: 'exam', instanceKey: 'exam-1' },
        { name: 'showSettings', args: { open: true } },
      );
      expect(result).toMatchObject({
        handled: true,
        acknowledged: true,
        changed: true,
        undo: { inverse: { name: 'showSettings', args: { open: false } } },
      });
      // 内部交接字段不得泄漏进回执
      expect(result).not.toHaveProperty('previousOpen');
    } finally {
      window.removeEventListener('exam:openSettings', listener);
    }
  });

  it('showSettings：视图报告 no-op → handled:true + changed:false（不伪造变化）', async () => {
    const manifest = createExamAgentManifest(handleExamActivation);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{
        acknowledge?: (result: {
          handled: boolean;
          changed?: boolean;
          previousOpen?: boolean;
        }) => void;
      }>).detail;
      detail?.acknowledge?.({ handled: true, changed: false, previousOpen: true });
    };
    window.addEventListener('exam:openSettings', listener);
    try {
      const result = await manifest.execute!(
        { windowId: 'exam-win', typeId: 'exam', instanceKey: 'exam-1' },
        { name: 'showSettings', args: { open: true } },
      );
      expect(result).toMatchObject({ handled: true, changed: false });
      expect(result.undo).toBeUndefined();
    } finally {
      window.removeEventListener('exam:openSettings', listener);
    }
  });

  it('setFocusMode/showSettings：无视图挂载时诚实失败（不再是硬拒 hint）', async () => {
    const manifest = createExamAgentManifest(handleExamActivation);
    for (const action of [
      { name: 'setFocusMode', args: { enabled: true } },
      { name: 'showSettings', args: { open: true } },
    ]) {
      const result = await manifest.execute!(
        { windowId: 'exam-win', typeId: 'exam', instanceKey: 'exam-1' },
        action,
      );
      expect(result).toMatchObject({ handled: false, code: 'WINDOW_NOT_FOUND' });
    }
  });

  it('observe 的可用动作包含 setFocusMode 与 showSettings', async () => {
    const manifest = createExamAgentManifest(handleExamActivation);
    const observation = await manifest.observe!({
      windowId: 'exam-win', typeId: 'exam', instanceKey: 'exam-1',
    });
    expect(observation.availableActions).toEqual(expect.arrayContaining([
      'setFocusMode',
      'showSettings',
    ]));
  });
});
