import { describe, expect, it } from 'vitest';
import { clearPluginStoredData, pluginStoredData } from '../PluginDataSection';

function storage(entries: Record<string, string>): Storage {
  const data = new Map(Object.entries(entries));
  return {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
  };
}

describe('F20 「它存了什么 / 清空它的数据」', () => {
  it('lists and clears only the plugin\'s own keys', () => {
    const store = storage({ 'ds:plugin:workshop.plugin-1:tomatoes': '{"v":1,"count":3}', 'ds:plugin:workshop.plugin-1:settings': '{}',
      'ds:plugin:workshop.plugin-2:x': '1', 'theme': 'dark' });
    const data = pluginStoredData('workshop.plugin-1', store);
    expect(data.keys).toEqual(['settings', 'tomatoes']);
    expect(data.bytes).toBeGreaterThan(0);
    expect(clearPluginStoredData('workshop.plugin-1', store)).toBe(2);
    expect(pluginStoredData('workshop.plugin-1', store).keys).toEqual([]);
    expect(store.getItem('ds:plugin:workshop.plugin-2:x')).toBe('1');
    expect(store.getItem('theme')).toBe('dark');
  });
});
