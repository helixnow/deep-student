/**
 * ACR AgentBridge 挂载组件 — R1-07
 *
 * 挂载于 App 根部，独立于 WorkbenchDesktop 的按需渲染树，return null。
 * Bridge 全局常驻；StageManager 随实际桌面可用性启停，并同步 workbenchBus。
 *
 * 设计：docs/dev/acr/DESIGN.md §2.1 / ROUND1 R1-07
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
