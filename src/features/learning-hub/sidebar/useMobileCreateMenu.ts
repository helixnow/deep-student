import { useEffect, useRef, useState } from 'react';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

export function useMobileCreateMenu() {
  // 📱 移动端顶部工具栏「新建」菜单：受控 + Android 返回键关闭（契约第 4 条）。
  // AppMenu 是自绘浮层（无 data-state="open"），androidBackCoordinator 的 Radix 兜底匹配不到。
  const [mobileCreateMenuOpen, setMobileCreateMenuOpen] = useState(false);
  // 可见性锚点用触发按钮：菜单内容 portal 到 body，判定不了保活视图的隐藏态
  const mobileCreateMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!mobileCreateMenuOpen) return;
    return registerBackHandler(() => {
      // 视图离屏时（MobileSlidingLayout 给非可见屏加 inert / display:none 隐藏保活视图）
      // 让行给当前活跃层：不吞返回键、也不关用户看不见的菜单（对照 IndexStatusView 守卫）
      const el = mobileCreateMenuTriggerRef.current;
      if (!el || el.closest('[inert]') || el.offsetParent === null) return false;
      setMobileCreateMenuOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [mobileCreateMenuOpen]);
  return { mobileCreateMenuOpen, setMobileCreateMenuOpen, mobileCreateMenuTriggerRef };
}
