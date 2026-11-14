/**
 * Host 半：提供 exampleWordOfDay 服务，并通过 meta.remote 只开放 today / history 两个方法给 UI 半。
 * 社区插件的服务名由插件 id 派生（host/kernel/plugin-id.ts 的 pluginServiceName）：
 * example.word-of-day → exampleWordOfDay；不在这个名字空间里的服务名会让插件以 SERVICE_NAME_INVALID 降级。
 * meta.id、meta.version 必须与 package.json 的 deepStudent.id、version 一致。
 */
import { definePlugin } from '../../../host/kernel/api.ts';
import { wordForDate, type Word } from './words.ts';

export interface ExampleWordOfDayService {
  today(date: string): Word;
  history(dates: readonly string[]): Word[];
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    exampleWordOfDay: ExampleWordOfDayService;
  }
}

export default definePlugin({
  meta: {
    id: 'example.word-of-day',
    version: '1.0.0',
    platforms: ['desktop'],
    provides: ['exampleWordOfDay'],
    ui: './dist/ui.js',
    remote: { exampleWordOfDay: ['today', 'history'] },
  },
  apply(ctx) {
    const log = ctx.get('log')?.logger('example.word-of-day');
    const service: ExampleWordOfDayService = {
      today: (date) => wordForDate(date),
      history: (dates) => dates.map((d) => wordForDate(d)),
    };
    ctx.provide('exampleWordOfDay', service);
    log?.info('word-of-day service ready');
  },
});
