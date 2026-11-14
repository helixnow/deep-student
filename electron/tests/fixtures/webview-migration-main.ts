/**
 * 测试入口：真实 `electron/main.ts`，只替换 exit/restart hooks 与迁移失败对话框（按 MIGRATION_PROMPT_CHOICES
 * 依次回答“retry”/“exit”）。选择重试前若设置了 MIGRATION_FIX_FROM/TO，先把正常的源库复制到源位置，
 * 模拟用户处理完问题后再点“重试”。MIGRATION_KILL_BEFORE_MARK=1 时在写 `done` 之前 SIGKILL 自己。
 * 事件（含各页面的 console 输出）逐行写入 MIGRATION_EVENTS。
 */
import { appendFileSync, copyFileSync } from 'node:fs';
import { app, BrowserWindow, session } from 'electron';
import { start } from '../../main.ts';

const eventsFile = process.env.MIGRATION_EVENTS as string;
const record = (entry: Record<string, unknown>) => appendFileSync(eventsFile, `${JSON.stringify(entry)}\n`);
const choices = (process.env.MIGRATION_PROMPT_CHOICES ?? '').split(',').filter((choice) => choice !== '');

app.on('web-contents-created', (_event, contents) => {
  contents.on('did-navigate', (_navigation, url) => record({ event: 'navigate', url }));
  contents.on('console-message', (event) => record({ event: 'console', level: event.level, message: event.message, url: contents.getURL() }));
});

const exit = (code: number) => {
  record({ hook: 'exit', code, windows: BrowserWindow.getAllWindows().length });
  session.defaultSession.flushStorageData();
  setTimeout(() => app.exit(code), 500);
};

void app.whenReady().then(() => start({
  processHooks: { restart: () => record({ hook: 'restart' }), exit },
  ...(process.env.MIGRATION_KILL_BEFORE_MARK === '1'
    ? {
        beforeMigrationComplete: () => {
          record({ hook: 'kill-before-mark' });
          process.kill(process.pid, 'SIGKILL');
        },
      }
    : {}),
  migrationPrompt: async (message, detail) => {
    const choice = choices.shift() === 'retry' ? 'retry' : 'exit';
    if (choice === 'retry' && process.env.MIGRATION_FIX_FROM !== undefined && process.env.MIGRATION_FIX_TO !== undefined) {
      copyFileSync(process.env.MIGRATION_FIX_FROM, process.env.MIGRATION_FIX_TO);
    }
    record({ event: 'prompt', message, detail, choice, windows: BrowserWindow.getAllWindows().length });
    return choice;
  },
})).catch((error: unknown) => {
  record({ hook: 'fatal', error: error instanceof Error ? error.stack ?? error.message : String(error) });
  app.exit(1);
});
