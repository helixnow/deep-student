/**
 * 第 09 章「作文批改」：作文工作台打开一篇已批改的高考议论文《答案易得，思考难得》（45/60）。
 * 评分卡（条形 / 雷达）、批注总览（删除 / 增加 / 替换 / 批注 / 亮点 / 错误六类标注，点开可「应用修改」）、
 * 逐句详解、润色提升、参考范文、批改历史、错误点入错题本都能看；另有一篇雅思大作文（6.5）可切换。
 * 新的批改要调用模型，提示去桌面版。
 */
import { demoLang, tr } from '../../lang';
import type { DemoAppPack } from '../types';
import { ESSAY_SETTINGS, GAOKAO_SESSION_ID, handleEssay } from './essay/backend';

const BORROWED_STRINGS: Record<string, Record<string, unknown>> = {
  settings: {
    mcp_server_list: { builtinServerName: tr('内置工具', 'Built-in Tools') },
    gradingMode: { badgeBuiltin: tr('预置', 'Built-in'), maxScore: tr('满分 {{score}}', 'Max {{score}}'), menuReset: tr('重置', 'Reset') },
    select_options: { none: tr('（无）', '(None)') },
  },
  mindmap: { placeholder: { root: tr('中心主题', 'Central Topic') } },
  chatV2: { selectionToolbar: { saveAsNotePickFolder: tr('选择保存目录', 'Choose a folder'), appendToNote: tr('追加到已有笔记', 'Append to existing note') } },
  chat_host: { model_panel: { search_placeholder: tr('搜索名称或模型 ID…', 'Search by name or model ID...') } },
};

const pack: DemoAppPack = {
  title: '作文批改',
  load: async () => {
    const [{ createElement: h, Fragment }, { createContentWindowComponent }, { NotificationContainer }] = await Promise.all([
      import('react'),
      import('@/features/workbench/apps/content/ContentAppWindow'),
      import('@/components/NotificationContainer'),
    ]);
    const EssayWindow = createContentWindowComponent('essay');
    // 演示壳不渲染 App 壳的通知宿主：挂一个，「开始批改」的桌面版提示才看得见
    const WithNotifications: typeof EssayWindow = (props) => h(Fragment, null, h(EssayWindow, props), h(NotificationContainer));
    return WithNotifications;
  },
  instanceKey: GAOKAO_SESSION_ID,
  handle: handleEssay,
  settings: ESSAY_SETTINGS,
  namespaces: ['essay_grading', 'workbench', 'learningHub', 'app_menu'],
  async prepare() {
    // 工作台零星借用了几个大命名空间的文案：只补这几条，免得整包下载（settings 150KB、chatV2 110KB…）
    const { default: i18n } = await import('@/i18n');
    for (const [ns, bundle] of Object.entries(BORROWED_STRINGS)) i18n.addResourceBundle(demoLang, ns, bundle, true, false);
  },
  async afterMount(root) {
    // 分项评分切到条形视图：评分卡更紧凑，首屏能看到下面带批注的原文
    const { default: i18n } = await import('@/i18n');
    const label = i18n.t('essay_grading:score.view_bars');
    for (let i = 0; i < 60; i++) {
      const button = root.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`);
      if (button) {
        button.click();
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  },
  isReady: (root) =>
    Boolean(root.querySelector('del, ins, [data-marker-type], .text-destructive')) &&
    [...root.querySelectorAll('button[aria-pressed="true"]')].some((b) => /bar|条形/i.test(b.getAttribute('aria-label') ?? '')) || root.clientWidth < 700,
};

export default pack;
