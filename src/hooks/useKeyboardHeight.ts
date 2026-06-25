/**
 * useKeyboardHeight - 移动端软键盘高度检测 Hook
 *
 * 使用 visualViewport API 检测键盘弹出/收起状态。
 * 解决 Android 上 windowSoftInputMode=adjustResize 导致 WebView 被压缩的问题。
 *
 * 返回当前键盘占用的高度（px），键盘收起时返回 0。
 */
import { useState, useEffect, useRef } from 'react';
import { isAndroid } from '@/utils/platform';

// 键盘弹出阈值：viewport 高度变化超过此值视为键盘弹出
const KEYBOARD_THRESHOLD = 150;

export function useKeyboardHeight(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const initialHeightRef = useRef(0);

  useEffect(() => {
    // 只在 Android 上启用
    if (!isAndroid()) return;

    const visualViewport = window.visualViewport;
    if (!visualViewport) return;

    // 记录初始视口高度
    initialHeightRef.current = visualViewport.height;

    const handleResize = () => {
      const heightDiff = initialHeightRef.current - visualViewport.height;
      if (heightDiff > KEYBOARD_THRESHOLD) {
        // 键盘弹出
        setKeyboardHeight(heightDiff);
      } else if (heightDiff < -KEYBOARD_THRESHOLD) {
        // 键盘收起
        setKeyboardHeight(0);
        // 更新初始高度（适配横竖屏切换）
        initialHeightRef.current = visualViewport.height;
      }
    };

    visualViewport.addEventListener('resize', handleResize);

    return () => {
      visualViewport.removeEventListener('resize', handleResize);
    };
  }, []);

  return keyboardHeight;
}

/**
 * useIsKeyboardShown - 键盘是否弹出的快捷 Hook
 */
export function useIsKeyboardShown(): boolean {
  const height = useKeyboardHeight();
  return height > 0;
}

/**
 * useInputFocusGuard - Android 输入框焦点导航守卫
 *
 * 当 Android 键盘弹出时，阻止导航事件被误触发。
 * 解决：键盘弹出时点击 dialog 外部或粘贴操作导致路由跳转的问题。
 */
export function useInputFocusGuard(): {
  isInputFocused: boolean;
  onInputFocus: () => void;
  onInputBlur: () => void;
} {
  const [isInputFocused, setIsInputFocused] = useState(false);
  const isKeyboardShown = useIsKeyboardShown();

  const onInputFocus = () => setIsInputFocused(true);
  const onInputBlur = () => {
    // 键盘弹出时忽略 blur 事件（防止粘贴/切换输入法时误触发）
    if (isKeyboardShown) return;
    setIsInputFocused(false);
  };

  return { isInputFocused, onInputFocus, onInputBlur };
}
