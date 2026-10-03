import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 2026-10-03 方案 F：本文件原先按源码字符串断言「设置页为 DeepSeek 单独渲染
// effort 选择器 + 保存时做 V4/V3.2 家族换算」。统一五档后这些家族分支已删除，
// 契约改为：设置页必须走统一档位控制与合法性归一，且**不得**再做家族特定的
// 档位换算——这是「映射只在后端」的回归闸门。
describe('思考强度设置契约（统一五档）', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/ShadApiEditModal.tsx'),
    'utf-8'
  );

  it('使用统一档位控制对象驱动选择器', () => {
    expect(source).toContain('resolveReasoningControl');
    expect(source).toContain('profileReasoningOptions');
    expect(source).toContain('profileUsesDiscreteEffort');
  });

  it('档位只做合法性归一（coerceReasoningLevel），不做家族换算', () => {
    expect(source).toContain('coerceReasoningLevel');
    // 以下函数已随方案 F 删除：设置页不得再持有家族特定的档位换算
    expect(source).not.toContain('normalizeDeepSeekV4Effort');
    expect(source).not.toContain('deepSeekV32EffortToBudget');
    expect(source).not.toContain('qwenEffortToBudget');
    expect(source).not.toContain('resolveDeepSeekRuntimeReasoningSelection');
  });

  it('保存时保留推理能力标记（关闭思考不丢模型能力）', () => {
    const saveStart = source.indexOf("if (sanitized.modelAdapter === 'deepseek') {");
    expect(saveStart).toBeGreaterThan(-1);
    const saveEnd = source.indexOf('if (!profileReasoningControl.canDisable', saveStart);
    expect(saveEnd).toBeGreaterThan(saveStart);
    const saveBlock = source.slice(saveStart, saveEnd);
    expect(saveBlock).toContain('inferredSupportsReasoning');
    expect(saveBlock).toContain('sanitized.supportsReasoning = true');
  });

  it('强制思考模型（canDisable=false）在保存时被置为开启', () => {
    expect(source).toContain('!profileReasoningControl.canDisable');
    expect(source).toContain('sanitized.enableThinking = true');
  });
});
