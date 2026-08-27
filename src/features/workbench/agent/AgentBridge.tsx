/**
 * ACR AgentBridge 挂载组件 — R1-07
 *
 * 挂载于 App 根部，独立于 WorkbenchDesktop 的按需渲染树，return null。
 * Bridge 全局常驻；StageManager 随实际桌面可用性启停，并同步 workbenchBus。
 *
 * R5（Agent 结合-1）：跨应用结合点（打开笔记锚点 / 打开 PDF 页 / 制卡 /
 * 出题）的唯一合法入口登记在同目录 integrationManifest.ts；本组件不路由
 * 这些结合点，传输层与 StageManager 管道保持不变。
 *
 * 设计：docs/dev/acr/DESIGN.md §2.1 / ROUND1 R1-07；docs/dev/wave2-B-r5-agent.md
 */
import { useEffect, useLayoutEffect } from 'react';
import { setupAgentBridge } from './bridge';
import { stageManager } from './stageManager';
import { workbenchBus } from '../core/workbenchBus';

export interface AgentBridgeProps {
  workbenchActive: boolean;
}

export const AgentBridge: React.FC<AgentBridgeProps> = ({ workbenchActive }) => {
  useLayoutEffect(() => {
    if (!workbenchActive) {
      workbenchBus.setEnabled(false);
      return;
    }

    stageManager.start();
    workbenchBus.setEnabled(true);
    return () => {
      workbenchBus.setEnabled(false);
      stageManager.stop();
    };
  }, [workbenchActive]);

  useEffect(() => {
    let teardown: (() => void) | null = null;
    try {
      teardown = setupAgentBridge();
    } catch (err) {
      console.error('[ACR] AgentBridge setup failed:', err);
    }

    return () => {
      try {
        teardown?.();
      } catch (err) {
        console.warn('[ACR] AgentBridge teardown failed:', err);
      }
    };
  }, []);


  return null;
};
