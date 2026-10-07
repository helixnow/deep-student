/**
 * 第 16 章「数据管理与云同步」：设置窗口的「数据治理 → 备份」页，开场滚到备份列表
 * （近一周的五个本地备份，含一个分层的部分归档）与自动备份策略。概览、同步（WebDAV 已配置、
 * 53 条变更待同步、无冲突）、审计日志都有数据；验证备份、改备份策略、删除备份在内存里生效，
 * 真正的备份 / 恢复 / 同步 / ZIP 导入导出提示去桌面版。
 */
import type { DemoAppPack } from '../types';
import { chain } from '../shared';
import { handleDemoModelSettings } from '../data/settings/models';
import { handleDemoSettingsShell } from '../data/settings/common';
import { handleDemoGovernance } from '../data/settings/governance';

const backupList = (root: HTMLElement) =>
  [...root.querySelectorAll('h2,h3,h4')].find((h) => /备份列表|Backup list/i.test(h.textContent ?? ''));

const pack: DemoAppPack = {
  title: '数据管理与云同步',
  load: () => import('../data/settings/SettingsWindow').then((m) => m.default),
  handle: chain(handleDemoGovernance, handleDemoModelSettings, handleDemoSettingsShell),
  namespaces: ['settings', 'workbench', 'forms', 'data', 'cloudStorage', 'sync', 'chat_host', 'app_menu'],
  async prepare() {
    const { useSettingsShellStore } = await import('@/stores/settingsShellStore');
    useSettingsShellStore.getState().applySettingsRoute({ tab: 'data-governance', dataGovernanceTab: 'backup' });
  },
  async afterMount(root) {
    for (let i = 0; i < 50 && !backupList(root); i++) await new Promise((r) => setTimeout(r, 100));
    // 备份列表在页面下半部：滚到让列表落在视口底部，上面还能看到自动备份策略
    const section = backupList(root)?.closest('section, [data-settings-section]') ?? backupList(root)?.parentElement?.parentElement;
    section?.scrollIntoView({ block: 'end' });
  },
  isReady: (root) => Boolean(backupList(root)) && root.querySelectorAll('button[aria-label="验证"], button[aria-label="Verify"]').length > 0,
};

export default pack;
