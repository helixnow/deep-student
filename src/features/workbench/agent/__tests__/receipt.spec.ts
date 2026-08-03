/**
 * R1-19 — AcrReceipt 构造/校验规格（DESIGN §2.2 冻结回执）
 *
 * 生产层无导出构造器：本文件内 validateReceipt + makeReceipt 作规格断言。
 * partial/cancelled 必带 done/undone；suggestion 模式 suggestionPending:true。
 */
import { describe, expect, it } from 'vitest';
import type { AcrReceipt, AcrReceiptStatus } from '../types';

type ReceiptIssue = string;

/**
 * 规格校验：对照 DESIGN §2.2 / types.ts AcrReceipt。
 * 返回空数组 = 合法。
 */
export function validateReceipt(r: Partial<AcrReceipt> & Pick<AcrReceipt, 'status'>): ReceiptIssue[] {
  const issues: ReceiptIssue[] = [];
  const statuses: AcrReceiptStatus[] = ['completed', 'partial', 'cancelled', 'failed'];
  if (!statuses.includes(r.status)) {
    issues.push(`status 非法: ${String(r.status)}`);
  }

  const modes = ['frontend', 'backend', 'suggestion'] as const;
  if (r.mode == null || !modes.includes(r.mode)) {
    issues.push('mode 必填且为 frontend|backend|suggestion');
  }
  if (typeof r.applied !== 'number') issues.push('applied 必填 number');
  if (typeof r.totalOps !== 'number') issues.push('totalOps 必填 number');
  if (!Array.isArray(r.entityIds)) issues.push('entityIds 必填 string[]');
  if (!Array.isArray(r.done)) issues.push('done 必填 string[]');
  if (!Array.isArray(r.undone)) issues.push('undone 必填 string[]');

  // DESIGN §2.2：partial/cancelled 必带 done/undone（数组存在即可；语义上应非空组合由调用方保证）
  if (r.status === 'partial' || r.status === 'cancelled') {
    if (!Array.isArray(r.done) || !Array.isArray(r.undone)) {
      issues.push(`${r.status} 必带 done[] 与 undone[]`);
    }
  }

  if (r.mode === 'suggestion' && r.suggestionPending !== true) {
    issues.push('suggestion 模式应 suggestionPending:true');
  }

  return issues;
}

function makeReceipt(partial: Partial<AcrReceipt> & Pick<AcrReceipt, 'status'>): AcrReceipt {
  const base: AcrReceipt = {
    status: partial.status,
    mode: partial.mode ?? 'frontend',
    applied: partial.applied ?? 0,
    totalOps: partial.totalOps ?? 0,
    entityIds: partial.entityIds ?? [],
    done: partial.done ?? [],
    undone: partial.undone ?? [],
  };
  if (partial.userPatch !== undefined) base.userPatch = partial.userPatch;
  if (partial.suggestionPending !== undefined) base.suggestionPending = partial.suggestionPending;
  if (partial.message !== undefined) base.message = partial.message;
  // suggestion 默认补 suggestionPending
  if (base.mode === 'suggestion' && base.suggestionPending === undefined) {
    base.suggestionPending = true;
  }
  return { ...base, ...partial, status: partial.status, mode: partial.mode ?? base.mode };
}

describe('ACR receipt — AcrReceipt 字段组合', () => {
  it('completed：全字段合法', () => {
    const r = makeReceipt({
      status: 'completed',
      mode: 'frontend',
      applied: 3,
      totalOps: 3,
      entityIds: ['n1', 'n2'],
      done: ['添加节点 A', '更新节点 B', '移动节点 C'],
      undone: [],
    });
    expect(validateReceipt(r)).toEqual([]);
    expect(r.status).toBe('completed');
    expect(r.done).toHaveLength(3);
    expect(r.undone).toEqual([]);
  });

  it('partial：必有 done/undone，可带 userPatch', () => {
    const r = makeReceipt({
      status: 'partial',
      mode: 'frontend',
      applied: 1,
      totalOps: 3,
      entityIds: ['n1'],
      done: ['已添加节点 A'],
      undone: ['未更新节点 B', '未删除节点 C'],
      userPatch: '用户在标题处插入了新段落',
      message: '用户接管，锚点失效，已返回部分结果',
    });
    expect(validateReceipt(r)).toEqual([]);
    expect(r.done.length + r.undone.length).toBe(3);
    expect(r.userPatch).toBeTruthy();
  });

  it('partial 缺少 done/undone 数组 → 校验失败', () => {
    const bad = {
      status: 'partial' as const,
      mode: 'frontend' as const,
      applied: 0,
      totalOps: 1,
      entityIds: [],
    };
    const issues = validateReceipt(bad);
    expect(issues.some((i) => i.includes('done') || i.includes('undone'))).toBe(true);
  });

  it('cancelled：必有 done/undone', () => {
    const r = makeReceipt({
      status: 'cancelled',
      mode: 'frontend',
      applied: 2,
      totalOps: 5,
      entityIds: ['a', 'b'],
      done: ['步骤1', '步骤2'],
      undone: ['步骤3', '步骤4', '步骤5'],
      message: '桥取消 / chat 停止',
    });
    expect(validateReceipt(r)).toEqual([]);
  });

  it('failed：允许空 done/undone，需 message 指引（规格允许）', () => {
    const r = makeReceipt({
      status: 'failed',
      mode: 'backend',
      applied: 0,
      totalOps: 1,
      entityIds: [],
      done: [],
      undone: ['写入失败'],
      message: 'WORKBENCH_UNAVAILABLE：请改用领域工具',
    });
    expect(validateReceipt(r)).toEqual([]);
  });

  it('suggestion 模式：suggestionPending:true，不阻塞', () => {
    const r = makeReceipt({
      status: 'completed',
      mode: 'suggestion',
      applied: 0,
      totalOps: 1,
      entityIds: [],
      done: [],
      undone: ['replace 待用户确认'],
      suggestionPending: true,
      message: '已提交建议，用户稍后确认',
    });
    expect(validateReceipt(r)).toEqual([]);
    expect(r.suggestionPending).toBe(true);
  });

  it('suggestion 缺 suggestionPending → 校验失败', () => {
    const issues = validateReceipt({
      status: 'completed',
      mode: 'suggestion',
      applied: 0,
      totalOps: 1,
      entityIds: [],
      done: [],
      undone: [],
      suggestionPending: false,
    });
    expect(issues.some((i) => i.includes('suggestionPending'))).toBe(true);
  });

  it('缺 mode / applied 等必填 → 校验失败', () => {
    const issues = validateReceipt({ status: 'completed' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes('mode'))).toBe(true);
  });
});
