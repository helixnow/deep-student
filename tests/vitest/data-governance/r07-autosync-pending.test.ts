/**
 * [R07-tests] 自动同步（auto sync）— 等待 R07-autosync 落地的前端占位测试
 *
 * 现状（2026-08，Round 07 盘点）：自动同步尚未落地。
 * - i18n 文案已就绪（sync.json 的 syncConfig.autoSync / syncConfig.syncInterval）；
 * - 后端 `question_sync_service::SyncConfig` 暴露 auto_sync / sync_interval_secs
 *   字段，但代码库中没有任何调度器消费它们（前端也没有 setInterval /
 *   定时触发同步的 hook）。
 *
 * 本文件：
 * 1. 钉住已就绪的 i18n 文案键（防止 R07-autosync 落地前文案被误删，
 *    落地时发现 key 消失）；
 * 2. 用 it.todo 记录调度器落地后必须补上的前端行为断言。
 *    等待 R07-autosync：调度器/设置面板合入后，请把 todo 变为真实测试。
 *
 * 与 src-tauri/tests/sync_r07_autosync_pending_tests.rs（后端占位）互补。
 */
import { describe, expect, it } from 'vitest';

import zhSync from '@/locales/zh-CN/sync.json';
import enSync from '@/locales/en-US/sync.json';

describe('R07-autosync 前置：i18n 文案面已就绪', () => {
  it('zh-CN 与 en-US 均包含 syncConfig.autoSync / syncConfig.syncInterval', () => {
    for (const [locale, bundle] of [
      ['zh-CN', zhSync],
      ['en-US', enSync],
    ] as const) {
      const syncConfig = (bundle as Record<string, unknown>).syncConfig as
        | Record<string, unknown>
        | undefined;
      expect(syncConfig, `${locale}: 缺少 syncConfig 段`).toBeDefined();
      expect(
        typeof syncConfig?.autoSync,
        `${locale}: syncConfig.autoSync 应为字符串文案`,
      ).toBe('string');
      expect(
        typeof syncConfig?.syncInterval,
        `${locale}: syncConfig.syncInterval 应为字符串文案`,
      ).toBe('string');
    }
  });
});

/**
 * 等待 R07-autosync：自动同步调度器落地后，把下列 todo 转为真实测试。
 * （it.todo 会在报告中显示为待办，不会失败——这是有意的文档化跳过。）
 */
describe('R07-autosync 落地后的行为断言（占位，等待 R07-autosync）', () => {
  it.todo('autoSync 关闭时不得注册任何定时同步任务');
  it.todo('autoSync 开启时按 syncInterval 周期触发同步，且与手动同步互斥（共用全局操作锁）');
  it.todo('同步进行中 / 维护模式下调度器暂停，恢复后继续');
  it.todo('错密码 / 明文降级设备的自动同步与手动同步一样 fail-closed（不静默重试风暴）');
  it.todo('应用退出前清理定时器，不留悬挂的 setInterval');
});
