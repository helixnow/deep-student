/**
 * 第 04 章「资源库」：资源库窗口，一学期的资料按课程分文件夹（教材 PDF、笔记、题目集、
 * 思维导图、翻译、图片、音视频、Office 文档），知识库索引大多已就绪、一份教材正在索引，
 * 回收站里有两条可恢复的旧资料。
 * 新建 / 重命名 / 移动 / 收藏 / 删除与撤销 / 回收站 / 搜索 / 知识库索引页都走
 * ../data/library 的内存后端。
 */
import type { DemoAppPack } from '../types';
import { createLibraryBackend } from '../data/library/backend';

const backend = createLibraryBackend();

const LIST_VIEW = JSON.stringify({
  state: { viewMode: 'list', sortBy: 'updatedAt', sortOrder: 'desc', quickAccessCollapsed: false },
  version: 0,
});

const pack: DemoAppPack = {
  title: '资源库',
  load: () => import('@/features/workbench/apps/files/FilesAppWindow').then((m) => m.default),
  handle: backend.handle,
  // 海报用列表视图：名称 / 修改日期 / 类型一眼看全（访客切回网格后本次访问内保持）
  localStorage: Object.fromEntries(
    ['learning-hub-finder', 'learning-hub-finder:files'].map((key) => [key, LIST_VIEW]),
  ),
};

export default pack;
