import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf-8'));
}

describe('tool permission protected-action copy contract', () => {
  const componentSource = readFileSync(
    resolve(process.cwd(), 'src/features/settings/components/McpToolsSection.tsx'),
    'utf-8'
  );
  const zh = readJson('src/locales/zh-CN/settings.json').tool_permissions;
  const en = readJson('src/locales/en-US/settings.json').tool_permissions;

  it('renders both fast-mode boundaries and the dynamic-risk explanation', () => {
    expect(componentSource).toContain("t('settings:tool_permissions.global_bypass_desc')");
    expect(componentSource).toContain("t('settings:tool_permissions.dynamic_risk_hint')");
  });

  it('does not promise that fast mode bypasses every approval', () => {
    expect(zh.global_bypass_desc).not.toContain('所有工具直接执行');
    expect(en.global_bypass_desc.toLowerCase()).not.toContain('all tools execute directly');

    expect(zh.global_bypass_desc).toContain('受保护操作');
    expect(zh.global_bypass_desc).toContain('命令执行');
    expect(zh.global_bypass_desc).toContain('文件写入');
    expect(en.global_bypass_desc.toLowerCase()).toContain('protected actions');
    expect(en.global_bypass_desc.toLowerCase()).toContain('command execution');
    expect(en.global_bypass_desc.toLowerCase()).toContain('file writes');
  });

  it('states that per-call risk can rise and protected actions remain non-bypassable', () => {
    expect(zh.dynamic_risk_hint).toContain('动态提高风险');
    expect(zh.dynamic_risk_hint).toContain('不会被');
    expect(en.dynamic_risk_hint.toLowerCase()).toContain('raised dynamically');
    expect(en.dynamic_risk_hint.toLowerCase()).toContain('cannot be bypassed');
  });
});
