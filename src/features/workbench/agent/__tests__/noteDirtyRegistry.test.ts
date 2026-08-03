/**
 * R1-13 — dirty checker 注册/注销（NotesCrepeEditor → contentDirtyRegistry 契约）
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetContentDirtyRegistry,
  isContentDirty,
  registerContentDirtyChecker,
} from '@/features/workbench/apps/content/contentDirtyRegistry';

describe('note contentDirtyRegistry (R1-13)', () => {
  afterEach(() => {
    __resetContentDirtyRegistry();
  });

  it('注册后 isContentDirty 反映 checker 返回值', () => {
    let dirty = false;
    const unregister = registerContentDirtyChecker('note', 'note-r113', () => dirty);

    expect(isContentDirty('note', 'note-r113')).toBe(false);
    dirty = true;
    expect(isContentDirty('note', 'note-r113')).toBe(true);

    unregister();
  });

  it('注销后视为干净；换 checker 后旧注销不误删新注册', () => {
    const unregA = registerContentDirtyChecker('note', 'note-swap', () => true);
    expect(isContentDirty('note', 'note-swap')).toBe(true);

    const unregB = registerContentDirtyChecker('note', 'note-swap', () => false);
    // 旧注销函数不应清掉新 checker（registry 按函数引用比对）
    unregA();
    expect(isContentDirty('note', 'note-swap')).toBe(false);

    unregB();
    expect(isContentDirty('note', 'note-swap')).toBe(false);
  });

  it('未注册 instance 视为干净', () => {
    expect(isContentDirty('note', 'never-registered')).toBe(false);
  });
});
