import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import {
  AnkiDebugEntry,
  getAnkiDebugSnapshot,
  publishAnkiDebugLog,
  subscribeAnkiDebugLog,
  clearAnkiDebugLogs,
} from '../ankiDebugChannel';

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

const stringify = (value: unknown) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const MAX_LOGS = 1000;

const AnkiGenerationDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const { t } = useTranslation('common');
  const [logs, setLogs] = React.useState<AnkiDebugEntry[]>(() => getAnkiDebugSnapshot());
  const [keyword, setKeyword] = React.useState('');
  const [level, setLevel] = React.useState<LevelFilter>('all');
  const [autoScroll, setAutoScroll] = React.useState(true);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!isActivated) return undefined;

    // 延迟发布日志，避免在渲染期间更新状态
    const timer = setTimeout(() => {
      publishAnkiDebugLog({ level: 'info', event: 'plugin:anki', message: 'Anki debug plugin activated' });
    }, 0);

    setLogs(getAnkiDebugSnapshot());
    const unsubscribe = subscribeAnkiDebugLog((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > MAX_LOGS) {
          next.splice(0, next.length - MAX_LOGS);
        }
        return next;
      });
    });

    return () => {
      clearTimeout(timer);
      unsubscribe();
      // 延迟发布日志，避免在清理期间更新状态
      setTimeout(() => {
        publishAnkiDebugLog({ level: 'info', event: 'plugin:anki', message: 'Anki debug plugin deactivated' });
      }, 0);
    };
  }, [isActivated]);

  React.useEffect(() => {
    if (!autoScroll) return;
    if (!isActivated) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll, isActivated]);

  if (!isActivated) {
    return null;
  }

  const filtered = React.useMemo(() => {
    return logs.filter((item) => {
      if (level !== 'all' && item.level !== level) return false;
      if (keyword.trim()) {
        const needle = keyword.trim().toLowerCase();
        const hay = `${item.event} ${item.message ?? ''} ${stringify(item.data)}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [logs, level, keyword]);

  return (
    <div className="flex flex-col h-full bg-slate-950/90 text-slate-100">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800/70 text-xs">
        <span className="font-semibold tracking-wide">
          {t('debug_panel.plugin_anki_generation', 'Anki 制卡日志')}
        </span>
        <label className="inline-flex items-center gap-1 text-[10px] text-slate-300">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(ev) => setAutoScroll(ev.target.checked)}
          />
          {t('debug_panel.auto_scroll', '自动滚动')}
        </label>
        <div className="ml-auto flex items-center gap-1">
          <select
            className="bg-slate-900 border border-slate-700 text-[10px] px-2 py-1 rounded"
            value={level}
            onChange={(ev) => setLevel(ev.target.value as LevelFilter)}
          >
            <option value="all">{t('debug_panel.filter_all', '全部')}</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
          </select>
          <input
            className="bg-slate-900 border border-slate-700 text-[10px] px-2 py-1 rounded"
            placeholder={t('debug_panel.search_placeholder', '搜索事件/内容')}
            value={keyword}
            onChange={(ev) => setKeyword(ev.target.value)}
          />
          <button
            type="button"
            className="text-[10px] bg-slate-800 border border-slate-700 rounded px-2 py-1 hover:bg-slate-700"
            onClick={() => {
              clearAnkiDebugLogs();
              setLogs([]);
            }}
          >
            {t('debug_panel.clear_logs', '清空')}
          </button>
        </div>
      </div>
      <div
        ref={listRef}
        className="flex-1 overflow-auto px-3 py-2 space-y-2 text-[11px]"
        style={{ fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace' }}
      >
        {filtered.length === 0 && (
          <div className="text-slate-500 text-[11px]">
            {t('debug_panel.no_logs', '暂无日志记录')}
          </div>
        )}
        {filtered.map((entry) => (
          <div
            key={entry.id}
            className="border border-slate-800 rounded-md px-2 py-1 bg-slate-900/80"
          >
            <div className="flex items-center gap-2 text-[10px] text-slate-400">
              <span>{new Date(entry.ts).toLocaleTimeString()}</span>
              <span className={`uppercase ${entry.level === 'error' ? 'text-rose-400' : entry.level === 'warn' ? 'text-amber-400' : 'text-slate-300'}`}>
                {entry.level}
              </span>
              <span className="text-sky-300 font-medium">{entry.event}</span>
            </div>
            {entry.message && (
              <div className="text-[11px] text-slate-200 mt-1 whitespace-pre-wrap">
                {entry.message}
              </div>
            )}
            {entry.data !== undefined && (
              <pre className="mt-1 text-[10px] text-slate-300 whitespace-pre-wrap break-all">
                {stringify(entry.data)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AnkiGenerationDebugPlugin;
