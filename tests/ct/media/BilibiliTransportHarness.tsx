import React from 'react';
import { setCtInvokeHandlers } from '../mocks/tauri-core-mock';
import { BilibiliTransportPanel } from '@/features/learning-hub/apps/views/media/BilibiliTransportPanel';

export function BilibiliTransportHarness({ state = 'awaiting_approval', media = false }: { state?: string; media?: boolean }) {
  const settings = { mode: 'auto', proxyUrl: null, proxyInAuto: false };
  setCtInvokeHandlers({
    media_bilibili_transport_status: () => ({ settings, bridge: { state, connectionId: 'fixture', scriptVersion: '1.0.0', parsing: state === 'ready', media, generation: 1, account: { loggedIn: true, mid: 7, uname: 'Browser account' } } }),
    media_bilibili_bridge_approve: () => undefined,
    media_bilibili_bridge_disconnect: () => undefined,
  });
  return <main style={{ padding: 16, maxWidth: 600, background: 'white', color: '#222' }}><BilibiliTransportPanel /></main>;
}
