/**
 * useDeferredStreamPreset — 非焦点窗流式降频的视觉平滑（O16）
 *
 * P7 的实现是 isVisible 翻转即切 preset（balanced ⇄ silky），
 * 拖拽遮挡 / 焦点快速切换等瞬时不可见会造成流式打字「骤停骤起」。
 *
 * 策略：
 * - 可见 → 不可见：延迟 STREAM_PRESET_DOWNSHIFT_DELAY_MS 才下档到 silky——
 *   瞬时遮挡（拖窗掠过、切换动画）期间保持 balanced 全速，不产生视觉停顿；
 *   持续不可见才真正降频省资源；
 * - 不可见 → 可见：立即回 balanced（无延迟），缓冲 token 以全速档的
 *   charsPerSecond + backlogBoost 平滑补渲，而非瞬间整段跳出；
 * - 挂载即不可见（后台恢复的窗口）：直接从 silky 起步，无需平滑；
 * - 可选 throttleMs（scheduler 渲染提示）：可见但非焦点 / 拖拽活动期
 *   立即 silky，把帧预算让给跟手路径（不走不可见宽限，避免拖窗时底下仍全速刷）。
 * - `<html data-wb-dragging|settling>`：不依赖 hint 刷新，起拖同步挂旗后
 *   下一帧降 silky（避免 pointerdown 同步 setState 抢首个 translate）。
 *
 * 不改 legacy streamingSmoothing / StreamPreferences，仅在适配层调度档位。
 */
import { useEffect, useState } from 'react';
import { shouldPauseHeavyContent } from '../../core/shellGestureFlags';

/** 失去可见性后维持全速档的宽限时长（ms） */
export const STREAM_PRESET_DOWNSHIFT_DELAY_MS = 800;

export type WbChatStreamPreset = 'balanced' | 'silky';

const WB_DRAGGING_ATTR = 'data-wb-dragging';
const WB_SETTLING_ATTR = 'data-wb-settling';

export function useDeferredStreamPreset(
  isVisible: boolean,
  /** scheduler 建议节流；>0 时可见窗也降 silky（焦点窗为 0） */
  throttleMs = 0,
): WbChatStreamPreset {
  const activityDownshift = isVisible && throttleMs > 0;
  const [preset, setPreset] = useState<WbChatStreamPreset>(() =>
    !isVisible || activityDownshift || shouldPauseHeavyContent() ? 'silky' : 'balanced',
  );

  useEffect(() => {
    if (!isVisible) {
      const timer = window.setTimeout(() => {
        setPreset('silky');
      }, STREAM_PRESET_DOWNSHIFT_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (activityDownshift || shouldPauseHeavyContent()) {
      // 拖拽 / settle / 非焦点可见：立即降频，不走不可见宽限
      setPreset('silky');
      return;
    }
    setPreset('balanced');
  }, [isVisible, activityDownshift]);

  // 壳层旗变化：延后一帧 setState，避免与首个 translate3d 同帧抢 React 提交
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let raf = 0;
    const sync = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!isVisible) return;
        if (shouldPauseHeavyContent() || activityDownshift) {
          setPreset('silky');
        } else {
          setPreset('balanced');
        }
      });
    };
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [WB_DRAGGING_ATTR, WB_SETTLING_ATTR],
    });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isVisible, activityDownshift]);

  return preset;
}
