/**
 * AI 学习仪表盘应用注册（Generative UI Round 13）
 */
import React from 'react';
import { AppIconImage } from '../../icons/appIcons';
import { appRegistry } from '../../core/appRegistry';
import type { AppDefinition } from '../../core/types';
import { aiDashboardAgentManifest, AI_DASHBOARD_TYPE_ID } from './agentManifest';

export const aiDashboardAppDefinition: AppDefinition = {
  typeId: AI_DASHBOARD_TYPE_ID,
  nameKey: 'workbench:apps.aiDashboard',
  icon: <AppIconImage typeId="aiDashboard" className="h-8 w-8" />,
  instanceMode: 'single',
  memoryWeight: 1,
  defaultFrame: { w: 480, h: 620 },
  minSize: { w: 360, h: 440 },
  render: React.lazy(() => import('./AiDashboardAppWindow')),
  agentManifest: aiDashboardAgentManifest,
};

let registered = false;

export function registerAiDashboardApp(): void {
  if (registered) return;
  registered = true;
  appRegistry.register(aiDashboardAppDefinition);
}

registerAiDashboardApp();
