/**
 * UI 半：侧栏导航项 + 视图 + 命令面板命令，文案登记在由插件 id 派生的命名空间 `example.word-of-day`。
 * 视图用设计系统的 `DsButton` / `DsDialog`，收藏夹是插件 store（`createPluginStore` + `persist`），快捷键提示按
 * `usePlatform()` 的系统给出，加载失败经 `ctx.ui.reportError` 计入错误预算。组件只接收派生 props（数据与回调），不直接拿 ctx。
 * 聊天里词典 MCP 工具 `define_word` 的结果下方加一个“收藏”按钮（`chat.toolResults` 槽位），写进同一个收藏夹。
 *
 * 只从 `react` 与 `@deepstudent/ui` 导入：宿主经 import map 只提供 react、react-dom、@deepstudent/ui、i18next
 * 四个共享模块（src/ui-kernel/community.ts），构建时它们都是 external。宿主不提供 `react/jsx-runtime`，
 * 所以 `npm run build:ui`（examples/scripts/build-ui.mjs）按经典 JSX 编译成 `React.createElement`，并且不读外层的
 * tsconfig.json（仓库根的 `"jsx": "react-jsx"` 会盖过经典 JSX 设置，产物里就会出现 `react/jsx-runtime`）。
 */
import React, { useEffect, useState } from 'react';
import {
  createPluginStore, definePlugin, DsButton, DsDialog, usePlatform, usePluginStore, useT, withPluginScope,
  type ChatToolResultProps, type PluginStore, type UiPlatformOs,
} from '@deepstudent/ui';
import type { Word } from './words';

export const PLUGIN_ID = 'example.word-of-day';
/** 槽位贡献 id 由插件 id 派生：`<id>/<localId>`（host/kernel/plugin-id.ts 的 pluginSlotId）。 */
export const VIEW_ID = `${PLUGIN_ID}/today`;
/** 命令 id 沿用命令面板的 `{module}.{action}` 格式，module 用插件 id。 */
export const OPEN_COMMAND_ID = `${PLUGIN_ID}.open`;
/** 收藏夹在插件存储里的键（实际键名加前缀 `ds:plugin:<id>:`）。 */
export const FAVORITES_KEY = 'favorites';
/**
 * 用户在设置里接入的词典 MCP 服务器提供的工具，参数 `{ word }`。外部 MCP 工具在聊天块里的名字带 `mcp_` 前缀
 * （`mcp_define_word`），所以贡献用 `match: 'qualified'`：去掉 `mcp_`、`mcp.tools.`、`<命名空间>.` 前缀后按基础名匹配。
 */
export const DEFINE_WORD_TOOL = 'define_word';
export const TOOL_RESULT_ID = `${PLUGIN_ID}/define-word`;

export const messages = {
  'zh-CN': {
    title: '每日单词', open: '打开每日单词', loading: '加载中…', failed: '加载失败：{{reason}}',
    save: '收藏', saved: '已收藏', savedCount: '收藏夹里有 {{n}} 个单词', example: '例句',
    hint: '也可以在命令面板（{{shortcut}}）里搜索“打开每日单词”',
    saveWord: '收藏“{{word}}”', savedWord: '已收藏“{{word}}”',
  },
  'en-US': {
    title: 'Word of the day', open: 'Open word of the day', loading: 'Loading…', failed: 'Failed to load: {{reason}}',
    save: 'Save', saved: 'Saved', savedCount: 'Saved words: {{n}}', example: 'Example',
    hint: 'You can also search for "Open word of the day" in the command palette ({{shortcut}})',
    saveWord: 'Save "{{word}}"', savedWord: 'Saved "{{word}}"',
  },
};

export interface Favorites {
  words: readonly string[];
}

/** 命令面板的快捷键是 `mod+k`：macOS 上是 ⌘，其他系统是 Ctrl。 */
export const paletteShortcut = (os: UiPlatformOs) => (os === 'macos' ? '⌘K' : 'Ctrl+K');

function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

export function WordOfDayView({ loadToday, favorites, onError }: {
  loadToday: () => Promise<Word>;
  favorites: PluginStore<Favorites>;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const { os } = usePlatform();
  const saved = usePluginStore(favorites, (state) => state.words);
  const [word, setWord] = useState<Word | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExample, setShowExample] = useState(false);
  useEffect(() => {
    // 卸载后到达的结果不再处理：插件此时可能已卸载，ctx.ui.reportError 会抛错。
    let mounted = true;
    loadToday().then(
      (w) => mounted && setWord(w),
      (e: unknown) => {
        if (!mounted) return;
        setError(reasonOf(e));
        onError(e);
      },
    );
    return () => {
      mounted = false;
    };
  }, [loadToday, onError]);
  if (error) return <p role="alert">{t('failed', { reason: error })}</p>;
  if (!word) return <p>{t('loading')}</p>;
  const isSaved = saved.includes(word.word);
  const toggleSaved = () => favorites.setState({ words: isSaved ? saved.filter((w) => w !== word.word) : [...saved, word.word] });
  return (
    <article>
      <h2>{word.word}</h2>
      <p>{word.meaning}</p>
      <DsButton variant="ghost" aria-pressed={isSaved} onClick={toggleSaved}>{t(isSaved ? 'saved' : 'save')}</DsButton>
      <DsButton variant="outline" onClick={() => setShowExample(true)}>{t('example')}</DsButton>
      <DsDialog open={showExample} onOpenChange={setShowExample} aria-label={t('example')}>
        <blockquote style={{ margin: 0, padding: 24 }}>{word.example}</blockquote>
      </DsDialog>
      <p>{t('savedCount', { n: saved.length })}</p>
      <p>{t('hint', { shortcut: paletteShortcut(os) })}</p>
    </article>
  );
}

/** 模型调用 `define_word` 时传的单词；不是非空字符串时 `when` 返回 false，聊天照常只显示通用结果。 */
export function definedWord({ toolInput }: Pick<ChatToolResultProps, 'toolInput'>): string | undefined {
  const word = toolInput.word;
  return typeof word === 'string' && word.trim() !== '' ? word.trim() : undefined;
}

export function SaveWordAction({ word, favorites }: { word: string; favorites: PluginStore<Favorites> }) {
  const t = useT();
  const saved = usePluginStore(favorites, (state) => state.words);
  const isSaved = saved.includes(word);
  const toggleSaved = () => favorites.setState({ words: isSaved ? saved.filter((w) => w !== word) : [...saved, word] });
  return (
    <DsButton variant="ghost" aria-pressed={isSaved} onClick={toggleSaved}>
      {t(isSaved ? 'savedWord' : 'saveWord', { word })}
    </DsButton>
  );
}

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default definePlugin({
  meta: { id: 'example.word-of-day', version: '1.0.0', host: true },
  apply(ctx) {
    ctx.ui.i18n.addBundles(messages);
    const ns = ctx.ui.i18n.namespace;
    const loadToday = () => ctx.ui.host.exampleWordOfDay!.today!(localDate()) as Promise<Word>;
    // 插件卸载时 store 重置、订阅断开；persist 把状态写进插件存储，重新安装时读回。
    const favorites = createPluginStore<Favorites>(ctx, { words: [] }, { persist: { key: FAVORITES_KEY } });
    // Host 半拒绝时给的是可序列化的值，不是 Error；错误记录只保留 Error 的 message，其他值记成 String(value)。
    const reportLoadError = (error: unknown) =>
      ctx.ui.reportError(error instanceof Error ? error : new Error(reasonOf(error)), { slot: 'views', entryId: VIEW_ID });
    // 视图由外壳渲染（不经 <SlotOutlet>），用 withPluginScope 让组件里的 useT 找到本插件。
    const View = withPluginScope(ctx, () => <WordOfDayView loadToday={loadToday} favorites={favorites} onError={reportLoadError} />);
    ctx.ui.views.register({ id: VIEW_ID, titleKey: `${ns}:title`, component: View });
    ctx.ui.nav.register({ id: VIEW_ID, viewId: VIEW_ID, labelKey: `${ns}:title`, order: 900 });
    ctx.ui.commands.register({ id: OPEN_COMMAND_ID, name: `${ns}:open`, category: 'navigation', execute: () => ctx.ui.navigate(VIEW_ID) });
    // 聊天的工具块同样不经 <SlotOutlet> 渲染贡献的组件。placement 'actions' 追加在成功态的通用输出下方，输出照常显示。
    const SaveAction = withPluginScope<ChatToolResultProps>(ctx, (props) => <SaveWordAction word={definedWord(props)!} favorites={favorites} />);
    ctx.ui.contribute('chat.toolResults', {
      id: TOOL_RESULT_ID,
      key: DEFINE_WORD_TOOL,
      value: { placement: 'actions', match: 'qualified', when: (props) => definedWord(props) !== undefined, component: SaveAction },
    });
  },
});
