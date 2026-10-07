/**
 * 第 19 章「音视频」：音视频应用窗口，库里是一门 B 站分 P 课（线性代数第五讲，已建分组，P4 看到一半）、
 * 一段本地课堂录音、一个未转写的实验视频和一节英语听力。
 *
 * 能玩的：筛选 / 搜索 / 按分组显示 / 多选与新建分组、点开任一条进学习页（播放 + 字幕跟随高亮 +
 * 点字幕跳转 + 断点续播）、给实验视频转写（逐段出字幕）、导出字幕（浏览器下载）、
 * 从 B 站链接导入（解析出虚构课程，可多选分 P 导入）、一键生成图文讲义（生产流水线真跑，模型回答是剧本）、
 * 问答 / 制卡 / 出题 / 截帧提问（分区内就地展示带时间引用的剧本回答）。
 * 选本地文件、扫码登录 B 站需要桌面环境。
 */
import { demoLang, tr } from '../../lang';
import type { DemoAppPack } from '../types';
import { getDemoMedia, handleDemoMedia } from './media/backend';

interface TauriInternals {
  convertFileSrc?: (path: string, protocol?: string) => string;
}

const pack: DemoAppPack = {
  title: '音视频',
  load: () => import('@/features/workbench/apps/system/MediaStudioAppWindow').then((m) => m.default),
  handle: handleDemoMedia,
  namespaces: ['mediaStudio', 'learningHub', 'common', 'workbench', 'sidebar', 'dstu', 'app_menu'],
  localStorage: {
    'mediaStudio.library.view': 'grouped',
  },
  async prepare() {
    // 内置 MCP 服务器显示名借自 settings 命名空间：只补这一条，免得下整个 settings 文案包
    const { default: i18n } = await import('@/i18n');
    i18n.addResourceBundle(demoLang, 'settings', { mcp_server_list: { builtinServerName: tr('内置工具', 'Built-in Tools') } }, true, false);
    // 播放地址：filestream://demo-media/<id> 与 bilistream://<id> 都接到演示视频资源
    const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
    internals.convertFileSrc = (path: string) => {
      const id = path.replace(/^demo-media\//, '');
      return getDemoMedia(id)?.src ?? path;
    };
  },
  async afterMount(root) {
    const [{ installMediaCompanion }, { showGlobalNotification }, { default: i18n }] = await Promise.all([
      import('./media/companion'),
      import('@/components/UnifiedNotification'),
      import('@/i18n'),
    ]);
    installMediaCompanion(
      root,
      (type, message) => showGlobalNotification(type, message),
      [i18n.t('learningHub:mediaTranscript.captureFrame')],
    );
  },
};

export default pack;
