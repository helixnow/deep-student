/**
 * Android 真机手册必须与当前云端整包语义对齐：
 * 已配置 E2EE → 加密全保真；未配置 → 便携归档拒绝整槽。
 * 不得再写「即使配了云端密码也补不回密钥 / 永远是便携包」。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const handbook = readFileSync(
  resolve(process.cwd(), 'docs/dev/cloud-sync-sota-b343/ANDROID-HANDBOOK-R11.md'),
  'utf8',
);

describe('ANDROID-HANDBOOK-R11 cloud-backup honesty', () => {
  it('splits configured full-fidelity from unconfigured portable archives', () => {
    expect(handbook).toContain('已配置');
    expect(handbook).toContain('加密全保真');
    expect(handbook).toContain('便携归档');
    expect(handbook).toContain('validate_for_slot_restore');
    expect(handbook).toContain('fail-closed 拒绝导出');
  });

  it('does not claim configured E2EE cloud backups stay portable', () => {
    expect(handbook).not.toContain('即使外层使用云端 E2EE 密码加密');
    expect(handbook).not.toContain('也不会把被便携导出策略剥离的本机密钥材料补回来');
    expect(handbook).not.toMatch(/立即备份到云端.+\n.+便携归档；即使/);
  });

  it('keeps real-device sign-off and SAF as the unverified / fallback path', () => {
    expect(handbook).toContain('真机尚未签字');
    expect(handbook).toContain('不得写“Android WebDAV 可全保真一键换机”');
    expect(handbook).toContain('SAF 加密 ZIP');
  });

  it('splits persistable export CREATE_DOCUMENT from import GET_CONTENT', () => {
    expect(handbook).toContain('ACTION_CREATE_DOCUMENT');
    expect(handbook).toContain('ACTION_GET_CONTENT');
    expect(handbook).toContain('tauri-plugin-dialog');
    expect(handbook).toContain('当次物化仍靠当前进程 grant');
    expect(handbook).toContain('pending_saf_persist/<hash>.uri');
    expect(handbook).toContain('并发导入/导出不得互相覆盖');
    const dashboard = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/DataGovernanceDashboard.tsx'),
      'utf8',
    );
    expect(dashboard).toContain('await save({');
    expect(dashboard).toContain('await open({');
  });
});
