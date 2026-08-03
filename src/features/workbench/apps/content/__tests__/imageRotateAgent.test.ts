/**
 * A45-5（docs/dev/acr/ACR-4.5.md）— image 内容窗 rotate 能力测试
 *
 * - capabilities 声明 rotate（90/180/270 顺时针，低风险、可逆、非幂等）；
 * - observe 只在视图表面真实挂载 rotate 落点时上报可用动作；
 * - execute：未挂载/未加载诚实失败；成功带反向旋转 undo 与前后角度 details；
 * - activation 通道不承载 rotate/setZoom（指路回执，不假成功）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerContentAgentSurface } from '../contentAgentSurfaces';
import { createResourceContentManifest } from '../agentManifests';
import { CONTENT_APP_DEFINITIONS } from '../register';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const manifest = createResourceContentManifest(
  'image',
  vi.fn(async () => ({ handled: false as const, code: 'UNSUPPORTED_ACTION' })),
);
const ctx = { windowId: 'img-win', typeId: 'image', instanceKey: 'img_rot' };

describe('image manifest rotate 能力声明（A45-5）', () => {
  it('capabilities 声明 rotate：degrees 枚举 90/180/270，低风险可逆非幂等', () => {
    const capability = manifest.capabilities.find((item) => item.name === 'rotate');
    expect(capability).toBeDefined();
    expect(capability).toMatchObject({
      risk: 'low',
      mutates: true,
      reversible: true,
      idempotent: false,
    });
    expect(capability?.inputSchema.properties?.degrees?.enum).toEqual([90, 180, 270]);
    expect(capability?.inputSchema.required).toContain('degrees');
  });

  it('非 image 类型不声明 rotate', () => {
    const translation = createResourceContentManifest(
      'translation',
      vi.fn(async () => ({ handled: false as const })),
    );
    expect(translation.capabilities.find((item) => item.name === 'rotate')).toBeUndefined();
  });
});

describe('image manifest rotate 执行（真实表面落点）', () => {
  it('视图未挂载 → observe 不上报 rotate，execute 诚实失败', async () => {
    const observation = await manifest.observe!(ctx);
    expect(observation.availableActions).not.toContain('rotate');

    const result = await manifest.execute!(ctx, { name: 'rotate', args: { degrees: 90 } });
    expect(result).toMatchObject({
      handled: false,
      changed: false,
      code: 'ACTION_UNAVAILABLE',
    });
  });

  it('挂载后 rotate 成功：changed:true、反向旋转 undo、前后角度 details', async () => {
    const rotate = vi.fn(() => ({ handled: true, changed: true }));
    cleanups.push(registerContentAgentSurface('image', 'img_rot', {
      getSummary: () => ({ ready: true, rotation: 90 }),
      rotate,
      getRotation: () => 90,
    }));

    const observation = await manifest.observe!(ctx);
    expect(observation.availableActions).toContain('rotate');

    const result = await manifest.execute!(ctx, { name: 'rotate', args: { degrees: 90 } });
    expect(rotate).toHaveBeenCalledWith(90);
    expect(result).toMatchObject({
      handled: true,
      acknowledged: true,
      changed: true,
      details: { previousRotation: 90, rotation: 180 },
      undo: { inverse: { name: 'rotate', args: { degrees: 270 } }, label: '恢复图片旋转' },
    });
  });

  it('rotate 180 的 undo 反向仍是 180（枚举内自反）', async () => {
    cleanups.push(registerContentAgentSurface('image', 'img_rot', {
      getSummary: () => ({ ready: true }),
      rotate: vi.fn(() => ({ handled: true, changed: true })),
      getRotation: () => 0,
    }));
    const result = await manifest.execute!(ctx, { name: 'rotate', args: { degrees: 180 } });
    expect(result.undo?.inverse).toMatchObject({ name: 'rotate', args: { degrees: 180 } });
  });

  it('无效 degrees → INVALID_ARGS，不触碰表面', async () => {
    const rotate = vi.fn(() => ({ handled: true }));
    cleanups.push(registerContentAgentSurface('image', 'img_rot', {
      getSummary: () => ({ ready: true }),
      rotate,
    }));
    for (const degrees of [45, -90, 'clockwise', null]) {
      const result = await manifest.execute!(ctx, { name: 'rotate', args: { degrees } });
      expect(result).toMatchObject({ handled: false, code: 'INVALID_ARGS' });
    }
    expect(rotate).not.toHaveBeenCalled();
  });

  it('表面拒绝（图片未加载完成）→ 透传表面 code/hint，无 undo', async () => {
    cleanups.push(registerContentAgentSurface('image', 'img_rot', {
      getSummary: () => ({ ready: false }),
      rotate: vi.fn(() => ({
        handled: false,
        code: 'ACTION_UNAVAILABLE',
        hint: '图片尚未加载完成，无法旋转',
      })),
      getRotation: () => 0,
    }));
    const result = await manifest.execute!(ctx, { name: 'rotate', args: { degrees: 90 } });
    expect(result).toMatchObject({
      handled: false,
      changed: false,
      code: 'ACTION_UNAVAILABLE',
      hint: '图片尚未加载完成，无法旋转',
    });
    expect(result.undo).toBeUndefined();
  });
});

describe('image activation 通道不承载 setZoom/rotate（A45-5 指路回执）', () => {
  it('rotate/setZoom 从 activation 进来时返回 UNSUPPORTED_ACTION + 指路 hint', async () => {
    const imageDef = CONTENT_APP_DEFINITIONS.find((def) => def.typeId === 'image');
    expect(imageDef?.onActivation).toBeTypeOf('function');
    for (const action of ['rotate', 'setZoom']) {
      const result = await imageDef!.onActivation!({
        windowId: 'img-win',
        instanceKey: 'img_rot',
        action,
        payload: {},
      });
      expect(result).toMatchObject({ handled: false, code: 'UNSUPPORTED_ACTION' });
      expect((result as { hint?: string }).hint).toContain('act');
    }
  });
});
