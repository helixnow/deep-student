import { Crepe } from '@milkdown/crepe';
import { createSlice, createTimer, type MilkdownPlugin, type TimerType } from '@milkdown/kit/ctx';
import { afterEach, describe, expect, it } from 'vitest';
import { setupMilkdownTimers } from './milkdownTimers';
setupMilkdownTimers();

import { installMilkdownCtxCompat } from '../milkdownCtxCompat';
import { applyCrepePlugins } from '../plugins';

describe('milkdownCtxCompat', () => {
  const roots: HTMLElement[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => root.remove());
  });

  function createForeignSchemaTimerPlugin(onReady: () => void): MilkdownPlugin {
    // 模拟 @milkdown/core 被重复实例化：同名但全新 Symbol 的 SliceType 与 TimerType
    const foreignSchemaTimerCtx = createSlice([] as TimerType[], 'schemaTimer');
    const foreignInitReady = createTimer('InitReady');
    const foreignSchemaReady = createTimer('SchemaReady');
    const foreignNodesCtx = createSlice([] as unknown[], 'nodes');
    const foreignEditorViewCtx = createSlice(null as unknown, 'editorView');
    const customReady = createTimer('ForeignSchemaReady');

    return (ctx) => {
      ctx.record(customReady);
      ctx.update(foreignSchemaTimerCtx, (timers) => [...timers, customReady]);
      return async () => {
        await ctx.wait(foreignInitReady);
        expect(Array.isArray(ctx.get(foreignNodesCtx))).toBe(true);
        ctx.done(customReady);
        await ctx.wait(foreignSchemaReady);
        expect(ctx.isInjected(foreignEditorViewCtx)).toBe(true);
        onReady();
        return () => {
          if (ctx.isInjected(foreignSchemaTimerCtx)) {
            ctx.update(foreignSchemaTimerCtx, (timers) => timers.filter((timer) => timer !== customReady));
          }
          ctx.clearTimer(customReady);
        };
      };
    };
  }

  it('reproduces Context "schemaTimer" not found without the compat bridge', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);

    const crepe = new Crepe({ root, defaultValue: '# 虚拟语气' });
    crepe.editor.use(createForeignSchemaTimerPlugin(() => {}));

    await expect(crepe.create()).rejects.toThrow(/Context "schemaTimer" not found/);
  });

  it('allows Crepe + full plugin stack to initialize when Slice/Timer Symbols come from a duplicate core copy', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);

    let foreignPluginReady = false;
    const crepe = new Crepe({ root, defaultValue: '# 语法笔记_虚拟语气\n\nIf I were you...' });
    installMilkdownCtxCompat(crepe.editor.ctx);
    applyCrepePlugins(crepe);
    crepe.editor.use(createForeignSchemaTimerPlugin(() => {
      foreignPluginReady = true;
    }));

    await crepe.create();

    expect(foreignPluginReady).toBe(true);
    const proseMirror = root.querySelector('.ProseMirror');
    expect(proseMirror).not.toBeNull();
    expect(proseMirror?.textContent).toContain('语法笔记_虚拟语气');
    expect(crepe.getMarkdown()).toContain('If I were you');

    // 不存在的 slice 仍应正常抛错，不能被静默吞掉
    const nonexistent = createSlice(null, 'definitelyDoesNotExist');
    expect(() => crepe.editor.ctx.get(nonexistent)).toThrow(/definitelyDoesNotExist/);

    await crepe.destroy();
  }, 10_000);
});
