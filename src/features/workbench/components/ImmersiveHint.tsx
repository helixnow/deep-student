/**
 * ImmersiveHint — 沉浸模式（绿灯）进入时的可见退出指引
 * ---------------------------------------------------------------------------
 * 沉浸模式会把菜单栏与 Dock 一起收起，此时「怎么退出」只剩 Esc 这条隐性知识，
 * 触屏设备上甚至无键盘可按。本组件在进入沉浸时于顶缘弹出一条提示条：
 * - 文案给出 Esc（细指针）/ 顶栏绿灯（触控）两条退出路径；
 * - 提示条自带「退出沉浸」按钮，读屏与触屏用户不依赖键盘也能退出；
 * - HINT_VISIBLE_MS 后自动淡出（不长期占顶），指针回到顶缘（菜单栏 reveal
 *   热区）时重新出现，与 StatusBar 的 autohide 心智一致。
 *
 * 只读 core/immersiveMode 的沉浸窗口 id，不改沉浸状态机本身。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowsIn } from '@phosphor-icons/react';
import { exitImmersive, useImmersiveWindowId } from '../core/immersiveMode';
import './ImmersiveHint.css';

/** 提示条自动淡出时间（ms） */
export const IMMERSIVE_HINT_VISIBLE_MS = 4200;

/** 顶缘 reveal 热区高度（与 StatusBar autohide 热区同量级） */
const TOP_REVEAL_ZONE_PX = 6;

function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

const ImmersiveHintComponent: React.FC = () => {
  const { t } = useTranslation('workbench');
  const immersiveWindowId = useImmersiveWindowId();
  const [visible, setVisible] = useState(false);
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    if (!immersiveWindowId) {
      setVisible(false);
      return undefined;
    }
    setCoarse(isCoarsePointer());
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), IMMERSIVE_HINT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [immersiveWindowId]);

  // 淡出后仍可召回：指针贴顶缘（菜单栏 reveal 热区）时重新显示
  useEffect(() => {
    if (!immersiveWindowId) return undefined;
    const onPointerMove = (e: PointerEvent) => {
      if (e.clientY <= TOP_REVEAL_ZONE_PX) setVisible(true);
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [immersiveWindowId]);

  const onExit = useCallback(() => {
    exitImmersive();
  }, []);

  if (!immersiveWindowId) return null;

  return (
    <div
      className="wb-immersive-hint"
      data-testid="wb-immersive-hint"
      data-visible={visible ? 'true' : 'false'}
      role="status"
      aria-live="polite"
    >
      <span className="wb-immersive-hint-text">
        {coarse ? t('immersive.hintTouch') : t('immersive.hint')}
      </span>
      <button
        type="button"
        className="wb-immersive-hint-exit"
        data-testid="wb-immersive-hint-exit"
        onClick={onExit}
      >
        <ArrowsIn size={13} weight="bold" aria-hidden="true" />
        {t('immersive.exit')}
      </button>
    </div>
  );
};

export const ImmersiveHint = React.memo(ImmersiveHintComponent);
ImmersiveHint.displayName = 'ImmersiveHint';

export default ImmersiveHint;
