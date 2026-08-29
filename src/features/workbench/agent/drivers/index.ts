/**
 * ACR Driver 汇总注册 — R1-16 / R2-06
 *
 * 逐个 registerDriver；并调用 setupNoteBinding（R1-13）。
 * disposeAllDrivers 供 stageManager.stop 退订 noteBinding + 清 userPatch summarizer。
 *
 * 设计：docs/dev/acr/DESIGN.md；任务卡 ROUND1.md R1-16 / ROUND2.md R2-06
 */
import i18n from '@/i18n';
import { setupNoteBinding } from '../noteBinding';
import type { StageManagerApi } from '../types';
import {
  clearUserPatchSummarizersForTests,
  registerUserPatchSummarizer,
} from '../userPatch';
import { registerFinderDriver } from './finderDriver';
import { registerFsrsDriver } from './fsrsDriver';
import { registerMindmapDriver } from './mindmapDriver';
import { registerNoteDriver } from './noteDriver';
import { registerPomodoroDriver } from './pomodoroDriver';
import { registerQbankDriver } from './qbankDriver';
import { registerSandboxDriver } from './sandboxDriver';
import { registerTodoDriver } from './todoDriver';

/** noteBinding 退订；registerAllDrivers 幂等时先清旧订阅 */
let disposeNoteBinding: (() => void) | null = null;
let disposeDomainDrivers: Array<() => void> = [];

/** R2-06：各 driver 的 userPatch diff 概述（缺省回落 DEFAULT_USER_PATCH） */
function registerUserPatchSummarizers(): void {
  registerUserPatchSummarizer('mindmap', () =>
    i18n.t('dstu:agent.user_patch.mindmap', {
      defaultValue: '用户在导图中进行了手动编辑',
    }),
  );
  registerUserPatchSummarizer('note', () =>
    i18n.t('dstu:agent.user_patch.note', {
      defaultValue: '用户在笔记正文中进行了手动编辑',
    }),
  );
  registerUserPatchSummarizer('todo', () =>
    i18n.t('dstu:agent.user_patch.todo', {
      defaultValue: '用户在待办列表中进行了手动编辑',
    }),
  );
  registerUserPatchSummarizer('files', () =>
    i18n.t('dstu:agent.user_patch.files', {
      defaultValue: '用户在文件管理器中进行了手动导航或编辑',
    }),
  );
  registerUserPatchSummarizer('flashcards', () =>
    i18n.t('dstu:agent.user_patch.flashcards', {
      defaultValue: '用户在复习队列中进行了手动操作',
    }),
  );
  registerUserPatchSummarizer('exam', () =>
    i18n.t('dstu:agent.user_patch.exam', {
      defaultValue: '用户在题库中进行了手动编辑',
    }),
  );
  registerUserPatchSummarizer('pomodoro', () =>
    i18n.t('dstu:agent.user_patch.pomodoro', {
      defaultValue: '用户手动操作了番茄钟',
    }),
  );
}

export function registerAllDrivers(stage: StageManagerApi): void {
  disposeAllDrivers();

  registerMindmapDriver(stage);
  registerNoteDriver(stage);
  disposeDomainDrivers = [
    registerTodoDriver(stage),
    registerFinderDriver(stage),
    registerFsrsDriver(stage),
    registerQbankDriver(stage),
  ];
  registerPomodoroDriver(stage);
  registerSandboxDriver(stage);
  registerUserPatchSummarizers();

  disposeNoteBinding = setupNoteBinding();
}

/** 退订 noteBinding 等驱动侧全局订阅；供 stageManager.stop 调用 */
export function disposeAllDrivers(): void {
  for (const dispose of disposeDomainDrivers.splice(0)) {
    dispose();
  }
  disposeNoteBinding?.();
  disposeNoteBinding = null;
  clearUserPatchSummarizersForTests();
}
