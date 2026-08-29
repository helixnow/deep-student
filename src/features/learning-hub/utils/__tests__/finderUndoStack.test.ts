/**
 * Finder 最近操作撤销栈（移动 / 重命名）测试
 */
import { describe, expect, it } from 'vitest';
import {
  createFinderUndoStack,
  FINDER_UNDO_STACK_LIMIT,
  type FinderMoveUndoOp,
  type FinderRenameUndoOp,
} from '../finderUndoStack';

function renameOp(id: string): FinderRenameUndoOp {
  return {
    kind: 'rename',
    targetType: 'resource',
    id,
    path: `/${id}`,
    oldName: `old-${id}`,
    newName: `new-${id}`,
  };
}

function moveOp(id: string): FinderMoveUndoOp {
  return {
    kind: 'move',
    entries: [{ id, isFolder: false, itemType: 'note', fromFolderId: 'fld_src' }],
    toFolderId: 'fld_dst',
  };
}

describe('finderUndoStack', () => {
  it('LIFO：后入先出', () => {
    const stack = createFinderUndoStack();
    stack.push(renameOp('a'));
    stack.push(moveOp('b'));
    expect(stack.size()).toBe(2);

    const first = stack.pop();
    expect(first?.kind).toBe('move');
    const second = stack.pop();
    expect(second?.kind).toBe('rename');
    expect(stack.pop()).toBeNull();
    expect(stack.size()).toBe(0);
  });

  it('超过上限时丢弃最旧记录', () => {
    const stack = createFinderUndoStack(3);
    for (let i = 0; i < 5; i++) {
      stack.push(renameOp(`op-${i}`));
    }
    expect(stack.size()).toBe(3);
    // 栈顶是最新的 op-4；最旧的 op-0/op-1 被淘汰
    expect((stack.pop() as FinderRenameUndoOp).id).toBe('op-4');
    expect((stack.pop() as FinderRenameUndoOp).id).toBe('op-3');
    expect((stack.pop() as FinderRenameUndoOp).id).toBe('op-2');
    expect(stack.pop()).toBeNull();
  });

  it('clear 清空全部记录', () => {
    const stack = createFinderUndoStack();
    stack.push(renameOp('a'));
    stack.push(renameOp('b'));
    stack.clear();
    expect(stack.size()).toBe(0);
    expect(stack.pop()).toBeNull();
  });

  it('默认上限为 FINDER_UNDO_STACK_LIMIT', () => {
    const stack = createFinderUndoStack();
    for (let i = 0; i < FINDER_UNDO_STACK_LIMIT + 5; i++) {
      stack.push(renameOp(`op-${i}`));
    }
    expect(stack.size()).toBe(FINDER_UNDO_STACK_LIMIT);
  });

  it('撤销失败可将操作塞回栈顶重试（push-back 语义）', () => {
    const stack = createFinderUndoStack();
    stack.push(renameOp('a'));
    const op = stack.pop();
    expect(op).not.toBeNull();
    stack.push(op!);
    expect(stack.size()).toBe(1);
    expect((stack.pop() as FinderRenameUndoOp).id).toBe('a');
  });
});
