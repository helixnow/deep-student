/**
 * 第 05 章「文档阅读与翻译」：教材阅读器打开《机器学习系统》第 3 章（60 页 PDF），
 * 停在第 45 页，预置四色高亮与三个书签，侧栏展开「批注」列表。
 * 划词高亮 / 改色 / 删除、书签增删改、目录与缩略图、搜索、翻页缩放、勾选页面、
 * 划词「翻译」「解释」都能在内存里跑通（./reading-translation/ai 给出预置译文与讲解）。
 */
import type { DemoAppPack } from '../types';
import { chain } from '../shared';
import { createLibraryBackend } from '../data/library/backend';
import { LIBRARY_PDF_ID } from '../data/library/seed';
import { handleReadingAi } from './reading-translation/ai';

const backend = createLibraryBackend();

function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 8000): Promise<T | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const value = probe();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 80);
    };
    tick();
  });
}

const pack: DemoAppPack = {
  title: '文档阅读与翻译',
  load: async () => {
    const [{ createContentWindowComponent }, { withNotifications }] = await Promise.all([
      import('@/features/workbench/apps/content/ContentAppWindow'),
      import('../data/library/withNotifications'),
    ]);
    return withNotifications(createContentWindowComponent('textbook'));
  },
  instanceKey: LIBRARY_PDF_ID,
  handle: chain(backend.handle, handleReadingAi),
  async afterMount(root) {
    // 侧栏切到「批注」：四条高亮按页分组，点击可跳回原文
    const { default: i18n } = await import('@/i18n');
    const label = i18n.t('pdf:toolbar.show_highlights');
    const button = await waitFor(() =>
      root.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`),
    );
    if (button && root.clientWidth >= 700) button.click();
  },
  isReady: (root) =>
    Boolean(root.querySelector('.ds-pdf__highlight-rect')) &&
    (root.clientWidth < 700 || Boolean(root.querySelector('.ds-pdf__sidebar--open'))),
};

export default pack;
