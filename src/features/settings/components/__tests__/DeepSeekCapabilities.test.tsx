import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ApiConfig, ModelProfile, VendorConfig } from '@/types';
import messages from '@/locales/zh-CN/settings.json';
import { DeepSeekCapabilities, type DeepSeekCapabilitySettings } from '../DeepSeekCapabilities';

const { invoke, saveSetting, getSetting } = vi.hoisted(() => ({ invoke: vi.fn(), saveSetting: vi.fn(), getSetting: vi.fn().mockResolvedValue('bing_rss,tavily') }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/utils/settingsApi', () => ({ saveSetting, getSetting }));
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => {
  const translated = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], messages);
  return String(translated ?? key).replace(/{{(\w+)}}/g, (_, name: string) => values?.[name] ?? '');
} }) }));

const vendor: VendorConfig = { id: 'builtin-deepseek', name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '***' };
const config: DeepSeekCapabilitySettings['config'] = {
  webSearchDeepseekKey: '', webSearchDeepseekFetchEnabled: false, voice_input_asr_model_config_id: '',
};

it('keeps independently saved settings and probe results separate on the rendered page', async () => {
  let finishTest!: (value: number) => void;
  invoke.mockImplementation((command, args) => command === 'get_available_ocr_models' ? Promise.resolve([])
    : args.capability === 'chat_read_url' ? new Promise(resolve => { finishTest = resolve; }) : Promise.reject(new Error('HTTP 401')));
  saveSetting.mockResolvedValue(undefined);
  function SettingsPage() {
    const [state, setState] = React.useState(config);
    return <DeepSeekCapabilities vendor={vendor} models={[]} settings={{ config: state,
      changeConfig: updates => setState(prev => ({ ...prev, ...updates })), assignAsr: vi.fn(), enableModel: vi.fn() }} />;
  }
  render(<SettingsPage />);
  expect(screen.getAllByRole('button', { name: /^测试/ })).toHaveLength(9);
  const search = within(screen.getByTestId('deepseek-capability-chat_search'));
  const links = within(screen.getByTestId('deepseek-capability-chat_read_url'));
  fireEvent.click(links.getByRole('switch', { name: '对话读链接' }));
  await waitFor(() => expect(links.getByRole('switch')).toBeChecked());
  expect(search.getByRole('switch')).not.toBeChecked();
  expect(saveSetting).toHaveBeenCalledWith('deepseek.chat.read_url', 'true');
  expect(links.getByText('未测试')).toBeVisible();
  fireEvent.click(links.getByRole('button', { name: '测试对话读链接' }));
  expect(links.getByText('正在测试…')).toBeVisible();
  finishTest(178);
  expect(await links.findByText('测试通过 · 178 毫秒')).toBeVisible();
  fireEvent.click(search.getByRole('button', { name: '测试对话联网搜索' }));
  expect(await search.findByText(/测试未通过.*HTTP 401/)).toBeVisible();
  expect(search.getByRole('switch')).not.toBeChecked();
  expect(invoke).toHaveBeenCalledWith('test_deepseek_capability', { capability: 'chat_read_url' });
  const external = screen.getByRole('switch', { name: 'Search 网页搜索' });
  fireEvent.click(external);
  await waitFor(() => expect(external).toBeChecked());
  expect(saveSetting).toHaveBeenCalledWith('session.selected_search_engines', 'bing_rss,tavily,deepseek');
  fireEvent.click(external);
  await waitFor(() => expect(external).not.toBeChecked());
  expect(saveSetting).toHaveBeenLastCalledWith('session.selected_search_engines', 'bing_rss,tavily');
});

it('enables only the selected OCR engine and uses the existing ASR assignment', async () => {
  const engineRows = [{ configId: 'system', enabled: true }, { configId: 'ocr', enabled: false }];
  invoke.mockImplementation(async (command, args) => {
    if (command === 'get_available_ocr_models') return engineRows;
    if (command === 'update_ocr_engine_priority') { engineRows[1]!.enabled = args.engineList[1].enabled; return true; }
    throw new Error(command);
  });
  const models = [
    { profile: { id: 'ocr' } as ModelProfile, api: { id: 'ocr', model: 'deepseek-ocr', enabled: true } as ApiConfig },
    { profile: { id: 'asr' } as ModelProfile, api: { id: 'asr', model: 'deepseek-asr', enabled: false } as ApiConfig },
  ];
  const enableModel = vi.fn().mockResolvedValue(undefined);
  const assignAsr = vi.fn().mockResolvedValue(undefined);
  render(<DeepSeekCapabilities vendor={vendor} models={models} settings={{ config, enableModel, assignAsr, changeConfig: vi.fn() }} />);
  const ocr = screen.getByRole('switch', { name: 'OCR 文字识别' });
  await waitFor(() => expect(ocr).toBeEnabled());
  fireEvent.click(ocr);
  await waitFor(() => expect(ocr).toBeChecked());
  expect(invoke).toHaveBeenCalledWith('update_ocr_engine_priority', { engineList: [
    { configId: 'system', enabled: true }, { configId: 'ocr', enabled: true },
  ] });
  fireEvent.click(screen.getByRole('switch', { name: 'ASR 语音识别' }));
  await waitFor(() => expect(assignAsr).toHaveBeenCalledWith('asr'));
  expect(enableModel).toHaveBeenCalledWith(models[1]!.profile);
});
