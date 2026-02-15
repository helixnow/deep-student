import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { createPortal } from 'react-dom';
import { ChevronsLeft, ChevronsRight, Pin, PinOff, Beaker, Minus, Square, X, Command, ChevronRight, Home } from 'lucide-react';
import { useFinderStore } from '@/components/learning-hub/stores/finderStore';
import { useCommandPalette } from '@/command-palette';
import { getCurrentWindow } from '@tauri-apps/api/window';
// ★ 文档31清理：SubjectSelectShad 已删除
import { useTranslation } from 'react-i18next';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { createNavItems } from '../../config/navigation';
import { getPlatform } from '../../utils/platform';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import type { CurrentView } from '@/types/navigation';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { Z_INDEX } from '@/config/zIndex';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

interface TopbarProps {
  currentView: CurrentView;
  onNavigate: (view: CurrentView) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

/**
 * 命令面板按钮组件
 * 点击打开命令面板，显示快捷键提示
 */
function CommandPaletteButton() {
  const { open } = useCommandPalette();
  const { t } = useTranslation(['command_palette']);
  const platform = useMemo(() => getPlatform(), []);
  const isMac = platform === 'macos';
  
  return (
    <CommonTooltip content={`${t('command_palette:title', '命令面板')} (${isMac ? '⌘' : 'Ctrl'}+K)`} position="bottom">
      <NotionButton variant="ghost" size="sm" onClick={open} className="h-8 px-2 hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]" aria-label={t('command_palette:title', '命令面板')}>
        <Command className="h-4 w-4" />
        <span className="text-xs font-medium hidden sm:inline">
          {isMac ? '⌘K' : 'Ctrl+K'}
        </span>
      </NotionButton>
    </CommonTooltip>
  );
}

/**
 * 学习资源面包屑导航组件
 * 在顶栏显示当前位置：学习资源 > 全部笔记
 */
function LearningHubBreadcrumb() {
  const { t } = useTranslation(['learningHub', 'finder']);
  const currentPath = useFinderStore(state => state.currentPath);
  const quickAccessNavigate = useFinderStore(state => state.quickAccessNavigate);
  const jumpToBreadcrumb = useFinderStore(state => state.jumpToBreadcrumb);

  // 计算当前视图标题
  const currentTitle = useMemo(() => {
    if (currentPath.folderId === 'root') return undefined;
    if (currentPath.folderId === 'trash') return t('finder:quickAccess.trash', '回收站');
    if (currentPath.folderId === 'recent') return t('finder:quickAccess.recent', '最近');
    if (currentPath.folderId === 'indexStatus') return t('finder:quickAccess.indexStatus', '向量化状态');
    if (currentPath.folderId === 'memory') return t('learningHub:memory.title', '记忆管理');
    if (currentPath.dstuPath === '/@favorites') return t('finder:quickAccess.favorites', '收藏');
    if (currentPath.typeFilter === 'note') return t('finder:quickAccess.notes', '全部笔记');
    if (currentPath.typeFilter === 'textbook') return t('finder:quickAccess.textbooks', '全部教材');
    if (currentPath.typeFilter === 'exam') return t('finder:quickAccess.exams', '全部题目集');
    if (currentPath.typeFilter === 'essay') return t('finder:quickAccess.essays', '全部作文');
    if (currentPath.typeFilter === 'translation') return t('finder:quickAccess.translations', '全部翻译');
    if (currentPath.typeFilter === 'mindmap') return t('finder:quickAccess.mindmaps', '知识导图');
    if (currentPath.typeFilter === 'image') return t('finder:quickAccess.images', '全部图片');
    if (currentPath.typeFilter === 'file') return t('finder:quickAccess.files', '全部文档');
    return undefined;
  }, [currentPath, t]);

  const breadcrumbs = currentPath.breadcrumbs;
  const rootTitle = t('learningHub:title', '学习资源');

  // 根目录：只显示 "学习资源"
  if (!currentTitle && breadcrumbs.length === 0) {
    return (
      <div className="flex items-center gap-1 text-sm" data-no-drag>
        <Home className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium text-foreground">{rootTitle}</span>
      </div>
    );
  }

  // 智能文件夹模式：学习资源 > 全部笔记
  if (currentTitle && breadcrumbs.length === 0) {
    return (
      <div className="flex items-center gap-1 text-sm" data-no-drag>
        <NotionButton variant="ghost" size="sm" onClick={() => quickAccessNavigate('allFiles')} className="!h-auto !p-0 text-muted-foreground hover:text-foreground">
          <Home className="h-4 w-4" />
          <span>{rootTitle}</span>
        </NotionButton>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium text-foreground">{currentTitle}</span>
      </div>
    );
  }

  // 文件夹导航模式：学习资源 > 文件夹1 > 文件夹2
  return (
    <div className="flex items-center gap-1 text-sm overflow-hidden" data-no-drag>
      <NotionButton variant="ghost" size="sm" onClick={() => quickAccessNavigate('allFiles')} className="!h-auto !p-0 text-muted-foreground hover:text-foreground shrink-0">
        <Home className="h-4 w-4" />
        <span className="hidden sm:inline">{rootTitle}</span>
      </NotionButton>
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <React.Fragment key={crumb.id || index}>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            {isLast ? (
              <span className="font-medium text-foreground truncate max-w-[150px]">{crumb.name}</span>
            ) : (
              <NotionButton variant="ghost" size="sm" onClick={() => jumpToBreadcrumb(index)} className="!h-auto !p-0 text-muted-foreground hover:text-foreground truncate max-w-[100px]">
                {crumb.name}
              </NotionButton>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// 严格仿照 study-ui 的顶部栏：结构、交互与视觉（根据本项目视图映射做最小改动）
export default function Topbar({ currentView, onNavigate, sidebarCollapsed, onToggleSidebar }: TopbarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isSmallScreen } = useBreakpoint(); // 后备检测：小屏幕（<768px）
  const platform = useMemo(() => getPlatform(), []);
  
  // 使用统一的导航项配置（与MobileNavDrawer完全一致）
  const navItems = useMemo(() => createNavItems(t), [t]);
  
  // 窗口控制函数（Windows专用）
  const handleMinimize = useCallback(async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (e) {
      console.error('Failed to minimize window:', e);
    }
  }, []);
  
  const handleMaximize = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow();
      const isMaximized = await appWindow.isMaximized();
      if (isMaximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
    } catch (e) {
      console.error('Failed to toggle maximize:', e);
    }
  }, []);
  
  const handleClose = useCallback(async () => {
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error('Failed to close window:', e);
    }
  }, []);
  
  // Portal 到 body，绕过局部 stacking context，确保永远置顶可点
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    try {
      const el = document.createElement('div');
      el.id = 'dstu-topbar-portal';
      // 维持轻量：不设置 pointer-events:none，避免阻断内部交互
      // 固定层级交给子元素的 z-index 控制
      document.body.appendChild(el);
      setPortalEl(el);
      return () => { try { document.body.removeChild(el); } catch { /* element may already be removed during cleanup */ } };
    } catch (e) { console.warn('Failed to create topbar portal element:', e); }
  }, []);
  const [scrolled, setScrolled] = useState(false);
  const [mounted, setMounted] = useState(false);
  const navRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ x: number; y: number; w: number; h: number; visible: boolean }>({ x: 0, y: 0, w: 0, h: 0, visible: false });
  const outerRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{ dragging: boolean; startX: number; startY: number; baseLeft: number; baseTop: number }>({ dragging: false, startX: 0, startY: 0, baseLeft: 0, baseTop: 0 });
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const collapsibleRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('topbarCollapsed.v1') === '1'; } catch { return false; }
  });
  const [pinned, setPinned] = useState<boolean>(() => {
    try { return localStorage.getItem('topbarPinned.v1') === '1'; } catch { return false; }
  });
  // Easter egg: click logo 5 times quickly => confetti + spiral flight
  const logoRef = useRef<HTMLImageElement | null>(null);
  const clickCounter = useRef<{ count: number; timer: number | null }>({ count: 0, timer: null });
  // Track mouse position globally for trajectory follow
  const lastMouse = useRef<{ x: number; y: number }>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  useEffect(() => {
    const onMove = (e: MouseEvent) => { lastMouse.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // Inject keyframes/styles once
  useEffect(() => {
    const id = 'dstu-easter-egg-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      @keyframes dstu-confetti-fall { to { transform: translate(var(--dx, 0px), var(--dy, 600px)) rotate(var(--rot, 720deg)); opacity: 0; } }
      /* Firework-like spark burst */
      @keyframes dstu-spark {
        0% { transform: translate(-50%, -50%) translate(0, 0) scale(1); opacity: 0.95; filter: blur(0px); }
        80% { opacity: 0.5; }
        100% { transform: translate(-50%, -50%) translate(var(--dx, 0px), var(--dy, 0px)) scale(0.6); opacity: 0; filter: blur(1px); }
      }
      /* Letter jet trail */
      @keyframes dstu-letter-jet {
        0% { transform: translate(-50%, -50%) translate(0,0) rotate(var(--rot, 0rad)) scale(1); opacity: 1; filter: blur(0px); }
        100% { transform: translate(-50%, -50%) translate(var(--dx, 0px), var(--dy, 0px)) rotate(var(--rot, 0rad)) scale(0.92); opacity: 0; filter: blur(0.5px); }
      }
      .dstu-no-drag { -webkit-user-drag: none; user-drag: none; user-select: none; }
    `;
    document.head.appendChild(style);
  }, []);

  const triggerConfetti = (x: number, y: number) => {
    // Intentional decorative colors: confetti particles for easter egg animation
    const colors = ['#FF6B6B', '#F7B801', '#6BCB77', '#4D96FF', '#B37FEB', '#FF8E72'];
    const pieces = 80;
    for (let i = 0; i < pieces; i++) {
      const el = document.createElement('div');
      const size = 6 + Math.random() * 6;
      const dx = (Math.random() - 0.5) * 600; // horizontal spread
      const dy = 300 + Math.random() * 500;   // fall distance
      const rot = (Math.random() * 1440 - 720) + 'deg';
      el.style.cssText = [
        'position:fixed',
        `left:${x}px`,
        `top:${y}px`,
        `width:${size}px`,
        `height:${size * 1.8}px`,
        `background:${colors[i % colors.length]}`,
        'transform: translate(0,0)',
        'opacity:1',
        'z-index:2147483647',
        'pointer-events:none',
        'border-radius:2px',
        `animation: dstu-confetti-fall ${900 + Math.random() * 700}ms ease-out forwards`,
        `--dx:${dx}px`,
        `--dy:${dy}px`,
        `--rot:${rot}`,
      ].join(';');
      document.body.appendChild(el);
      setTimeout(() => { try { document.body.removeChild(el); } catch { /* confetti element may already be removed */ } }, 1800);
    }
  };

  const spiralLogoFlight = async () => {
    const img = logoRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    triggerConfetti(cx, cy);
    // Clone the logo and animate
    const clone = img.cloneNode(true) as HTMLImageElement;
    clone.style.position = 'fixed';
    clone.style.left = cx + 'px';
    clone.style.top = cy + 'px';
    clone.style.width = rect.width + 'px';
    clone.style.height = rect.height + 'px';
    clone.style.transform = 'translate(-50%, -50%)';
    clone.style.zIndex = '2147483647';
    clone.style.pointerEvents = 'none';
    document.body.appendChild(clone);
    const launchMs = 600;      // 火箭加速飞出阶段
    const followMs = 5200;     // 跟随鼠标轨迹 5.2s
    const returnMs = 2000;     // 脱离控制后缓缓飞回
    const launchDist = 220;    // 初始加速距离
    let rafId = 0;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const start = now();
    img.style.visibility = 'hidden';
    // 阶段一：火箭加速飞出（朝向当前鼠标方向）
    const m0 = lastMouse.current;
    const dir0x = m0.x - cx;
    const dir0y = m0.y - cy;
    const len0 = Math.hypot(dir0x, dir0y) || 1;
    const ux = dir0x / len0;
    const uy = dir0y / len0;
    const launchStart = now();
    let lastSparkSpawn = 0;
    const spawnSparkTrail = (x: number, y: number, ang: number, nowTs: number, opts?: { interval?: number; minMs?: number; maxMs?: number }) => {
      // 可调节的节流（默认 60ms 生成一簇烟花状粒子）
      const interval = opts?.interval ?? 60;
      const minMs = opts?.minMs ?? 500;
      const maxMs = opts?.maxMs ?? 1000;
      if (nowTs - lastSparkSpawn < interval) return;
      lastSparkSpawn = nowTs;
      // Intentional decorative colors: sparkle trail particles for easter egg animation
      const colors = ['#FFF59D', '#FFD54F', '#FF8A65', '#4FC3F7', '#BA68C8'];
      const backOffset = 14 + Math.random() * 8;
      const ox = x - Math.cos(ang) * backOffset;
      const oy = y - Math.sin(ang) * backOffset;
      const count = 6 + Math.floor(Math.random() * 5); // 6-10 颗
      for (let i = 0; i < count; i++) {
        const el = document.createElement('div');
        const size = 3 + Math.random() * 3;
        const spread = 60 + Math.random() * 80; // 爆散距离
        const theta = (Math.random() * Math.PI * 2);
        const dx = Math.cos(theta) * spread;
        const dy = Math.sin(theta) * spread;
        const color = colors[i % colors.length];
        el.style.cssText = [
          'position:fixed',
          `left:${cx + ox}px`,
          `top:${cy + oy}px`,
          `width:${size}px`,
          `height:${size}px`,
          'border-radius:9999px',
          'pointer-events:none',
          'z-index:2147483647',
          `background:${color}`,
          'transform: translate(-50%, -50%)',
          `--dx:${dx}px`,
          `--dy:${dy}px`,
          `animation: dstu-spark ${minMs + Math.random() * (maxMs - minMs)}ms ease-out forwards`,
          'box-shadow: 0 0 8px hsl(0 0% 100% / 0.6)', /* decorative glow for spark particles */
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => { try { document.body.removeChild(el); } catch { /* spark particle may already be removed */ } }, 1100);
      }
    };

    // 循环的字母尾焰
    const letters = Array.from('DeepStudent');
    const letterIdx = { i: 0 };
    let lastLetterSpawn = 0;
    const spawnLetterJet = (x: number, y: number, ang: number, nowTs: number) => {
      // 每 45ms 喷射一个字母
      if (nowTs - lastLetterSpawn < 45) return;
      lastLetterSpawn = nowTs;
      const letter = letters[letterIdx.i % letters.length];
      letterIdx.i++;
      const backOffset = 16 + Math.random() * 10;
      const ox = x - Math.cos(ang) * backOffset;
      const oy = y - Math.sin(ang) * backOffset;
      // 再沿着反方向漂移一段距离
      const drift = 80 + Math.random() * 70;
      const dx = -Math.cos(ang) * drift;
      const dy = -Math.sin(ang) * drift;
      const el = document.createElement('div');
      el.textContent = letter;
      el.style.cssText = [
        'position:fixed',
        `left:${cx + ox}px`,
        `top:${cy + oy}px`,
        'pointer-events:none',
        'z-index:2147483647',
        'font-weight: 800',
        'font-size: 12px',
        'color: hsl(var(--primary))', /* theme-aware: was #1d4ed8 */
        'text-shadow: 0 0 6px hsl(var(--primary) / 0.5), 0 0 12px hsl(var(--primary) / 0.35)',
        'transform: translate(-50%, -50%)',
        `--dx:${dx}px`,
        `--dy:${dy}px`,
        `--rot:${ang}rad`,
        'animation: dstu-letter-jet 820ms ease-out forwards',
      ].join(';');
      document.body.appendChild(el);
      setTimeout(() => { try { document.body.removeChild(el); } catch { /* letter jet element may already be removed */ } }, 1100);
    };

    const animateLaunch = (tms: number) => {
      const t = Math.min(1, (tms - launchStart) / launchMs);
      const tt = easeOutCubic(t);
      const x = ux * launchDist * tt;
      const y = uy * launchDist * tt;
      const ang = Math.atan2(uy, ux);
      clone.style.transform = `translate(${x - rect.width / 2}px, ${y - rect.height / 2}px) rotate(${ang}rad)`;
      // 启动阶段：烟花频率降低、动画更慢；并叠加字母尾焰
      spawnSparkTrail(x, y, ang, tms, { interval: 140, minMs: 800, maxMs: 1400 });
      spawnLetterJet(x, y, ang, tms);
      if (t < 1) rafId = requestAnimationFrame(animateLaunch);
      else {
        // 阶段二：跟随鼠标 3s（平滑追踪）
        const followStart = now();
        let px = x, py = y, pa = ang;
        const follow = (tm: number) => {
          const elapsed = tm - followStart;
          const alpha = 0.18; // 跟随平滑系数
          const target = lastMouse.current;
          const tx = target.x - cx;
          const ty = target.y - cy;
          const dx = tx - px;
          const dy = ty - py;
          px += dx * alpha;
          py += dy * alpha;
          pa = Math.atan2(dy, dx);
          clone.style.transform = `translate(${px - rect.width / 2}px, ${py - rect.height / 2}px) rotate(${pa}rad)`;
          // 跟随阶段：仅保留字母尾焰
          spawnLetterJet(px, py, pa, tm);
          if (elapsed < followMs) requestAnimationFrame(follow);
          else {
            // 阶段三：慢慢飞回
            const backStart = now();
            const sx = px, sy = py, sa = pa;
            const back = (tbm: number) => {
              const tb = Math.min(1, (tbm - backStart) / returnMs);
              const ttb = easeInOut(tb);
              const bx = sx + (0 - sx) * ttb;
              const by = sy + (0 - sy) * ttb;
              const ba = sa * (1 - ttb);
              clone.style.transform = `translate(${bx - rect.width / 2}px, ${by - rect.height / 2}px) rotate(${ba}rad)`;
              // 返回阶段：仅保留字母尾焰
              spawnLetterJet(bx, by, ba, tbm);
              if (tb < 1) requestAnimationFrame(back);
              else {
                try { document.body.removeChild(clone); } catch { /* clone may already be removed */ }
                img.style.visibility = '';
              }
            };
            requestAnimationFrame(back);
          }
        };
        requestAnimationFrame(follow);
      }
    };
    rafId = requestAnimationFrame(animateLaunch);
    // Safety cleanup
    setTimeout(() => { try { cancelAnimationFrame(rafId); } catch { /* animation may already be completed */ } }, launchMs + followMs + returnMs + 800);
  };

  const onLogoClick = () => {
    const now = Date.now();
    const state = clickCounter.current;
    state.count += 1;
    if (state.timer) clearTimeout(state.timer as unknown as number);
    state.timer = window.setTimeout(() => { state.count = 0; state.timer = null; }, 1200);
    if (state.count >= 6) {
      state.count = 0;
      if (state.timer) { clearTimeout(state.timer as unknown as number); state.timer = null; }
      spiralLogoFlight();
    }
  };
  const storageKey = 'topbarPos.v1';
  const SNAP_BREAKPOINT = 768; // 窄屏阈值（含移动端）
  const MARGIN = 8;
  // 统一的指示器重算函数，供多处调用
  const recalcIndicator = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const active = el.querySelector('button[data-active="true"]') as HTMLElement | null;
    if (!active) {
      setIndicator((s) => ({ ...s, visible: false }));
      return;
    }
    if ((active as any).dataset.skipIndicator === 'true') {
      setIndicator((s) => ({ ...s, visible: false }));
      return;
    }
    const navRect = el.getBoundingClientRect();
    const btnRect = active.getBoundingClientRect();
    // 选中框稍微内缩一点点，左右各1px，上下各1px，保持视觉平衡
    const inset = { x: 1, y: 1 };
    const x = btnRect.left - navRect.left + el.scrollLeft + inset.x;
    const y = btnRect.top - navRect.top + el.scrollTop + inset.y;
    const w = btnRect.width - inset.x * 2;
    const h = btnRect.height - inset.y * 2;
    setIndicator({ x, y, w, h, visible: true });
  }, [navRef]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 6);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => setMounted(true), []);

  // 初始化折叠区尺寸（避免首次闪动）：仅在挂载时运行一次
  useEffect(() => {
    const el = collapsibleRef.current;
    if (!el) return;
    el.style.overflow = 'hidden';
    if (collapsed) {
      el.style.width = '0px';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    } else {
      // 先用 auto 计算真实宽度，再回填，避免初次布局错误
      const prev = el.style.width;
      el.style.width = 'auto';
      const w = el.getBoundingClientRect().width;
      el.style.width = prev;
      el.style.width = `${w}px`;
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // 折叠/展开非线性动画 + 持久化
  useEffect(() => {
    const el = collapsibleRef.current;
    try { localStorage.setItem('topbarCollapsed.v1', collapsed ? '1' : '0'); } catch (e) { console.warn('Failed to persist topbar collapsed state:', e); }
    if (!el) return;
    el.style.overflow = 'hidden';
    // 使用GPU加速和更优的动画曲线
    el.style.willChange = 'transform, width, opacity';
    el.style.transition = 'width 280ms cubic-bezier(0.33, 1, 0.68, 1), opacity 160ms ease-out';
    el.style.backfaceVisibility = 'hidden';
    el.style.transform = 'translateZ(0)';
    el.style.contain = 'layout paint';  // 减少重绘区域
    const current = el.getBoundingClientRect().width;
    let target = 0;
    if (collapsed) {
      target = 0;
      // 折叠时隐藏指示器
      setIndicator((s) => ({ ...s, visible: false }));
    } else {
      const prev = el.style.width;
      el.style.width = 'auto';
      target = el.getBoundingClientRect().width;
      el.style.width = prev;
    }
    // 若靠近右侧边缘，展开前先左移以保证完整显示
    try {
      const outer = outerRef.current;
      if (outer && !collapsed) {
        const outerRect = outer.getBoundingClientRect();
        const staticWidth = Math.max(0, outerRect.width - current);
        const expandedWidth = staticWidth + target;
        const candidateLeft = pos ? pos.left : outerRect.left;
        const maxLeft = Math.max(MARGIN, window.innerWidth - expandedWidth - MARGIN);
        const desiredLeft = Math.min(Math.max(candidateLeft, MARGIN), maxLeft);
        if (!pos || Math.abs(desiredLeft - pos.left) > 1) {
          setPos({ left: desiredLeft, top: pos ? pos.top : outerRect.top });
        }
      }
    } catch (e) { console.warn('Failed to adjust topbar position before expand:', e); }
    // 定义过渡结束处理函数（放在外层作用域）
    const handleTransitionEnd = (ev: TransitionEvent) => {
      if (ev.propertyName === 'width') {
        if (!collapsed) {
          el.style.width = 'auto';
          // 单帧重算指示器，减少重排次数
          requestAnimationFrame(recalcIndicator);
        }
        el.removeEventListener('transitionend', handleTransitionEnd as any);
      }
    };
    
    // 使用 RAF 批处理所有样式更改，减少布局抖动
    requestAnimationFrame(() => {
      // 先固定到当前宽度
      el.style.width = `${current}px`;
      
      // 强制重排，确保当前宽度已应用
      void el.offsetWidth;
      
      // 添加过渡结束监听
      el.addEventListener('transitionend', handleTransitionEnd as any);
      
      // 应用目标宽度和其他样式
      el.style.width = `${target}px`;
      el.style.opacity = collapsed ? '0' : '1';
      el.style.pointerEvents = collapsed ? 'none' : 'auto';
    });
    
    // 清理函数
    return () => {
      el.removeEventListener('transitionend', handleTransitionEnd as any);
    };
  }, [collapsed, recalcIndicator]);

  // 位置计算与持久化
  const clampToViewport = (left: number, top: number) => {
    const el = outerRef.current;
    const rect = el ? el.getBoundingClientRect() : ({ width: 320, height: 56 } as any);
    const minLeft = MARGIN;
    const minTop = MARGIN;
    const maxLeft = Math.max(minLeft, window.innerWidth - rect.width - MARGIN);
    const maxTop = Math.max(minTop, window.innerHeight - rect.height - MARGIN);
    return { left: Math.min(Math.max(left, minLeft), maxLeft), top: Math.min(Math.max(top, minTop), maxTop) };
  };

  // 在窄屏时将 Topbar 靠左/靠右吸附
  const snapIfNarrow = (left: number, top: number) => {
    if (window.innerWidth > SNAP_BREAKPOINT) return { left, top };
    const el = outerRef.current;
    const rect = el ? el.getBoundingClientRect() : ({ width: 320 } as any);
    const mid = window.innerWidth / 2;
    const snapLeft = MARGIN;
    const snapRight = Math.max(MARGIN, window.innerWidth - (rect.width || 320) - MARGIN);
    const snappedLeft = left + (rect.width || 320) / 2 < mid ? snapLeft : snapRight;
    return { left: snappedLeft, top };
  };

  // 初始化定位：优先使用本地存储；否则居中靠上
  useEffect(() => {
    const init = () => {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { left: number; top: number };
          const clamped = clampToViewport(parsed.left, parsed.top);
          setPos(clamped);
          return;
        } catch (e) { console.warn('Failed to parse saved topbar position:', e); }
      }
      const el = outerRef.current;
      const rect = el ? el.getBoundingClientRect() : ({ width: 640 } as any);
      const left = Math.max(MARGIN, (window.innerWidth - (rect.width || 640)) / 2);
      const top = 24;
      const clamped = clampToViewport(left, top);
      const snapped = snapIfNarrow(clamped.left, clamped.top);
      setPos(snapped);
    };
    // 等一帧确保宽度已渲染
    requestAnimationFrame(init);
    const onResize = () => setPos((p) => {
      if (!p) return p;
      const clamped = clampToViewport(p.left, p.top);
      return snapIfNarrow(clamped.left, clamped.top);
    });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 拖拽：在页面内移动 Topbar（鼠标与触摸）
  useEffect(() => {
    let rafId: number | null = null;
    let lastMouseX = 0;
    let lastMouseY = 0;
    const scheduleMove = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!dragState.current.dragging || !outerRef.current) return;
        const el = outerRef.current;
        const rect = el.getBoundingClientRect();
        const dx = lastMouseX - dragState.current.startX;
        const dy = lastMouseY - dragState.current.startY;
        const newLeft = Math.min(Math.max(MARGIN, dragState.current.baseLeft + dx), Math.max(MARGIN, window.innerWidth - rect.width - MARGIN));
        const newTop = Math.min(Math.max(MARGIN, dragState.current.baseTop + dy), Math.max(MARGIN, window.innerHeight - rect.height - MARGIN));
        setPos({ left: newLeft, top: newTop });
      });
    };
    const onMove = (e: MouseEvent) => {
      if (!dragState.current.dragging) return;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      scheduleMove();
    };
    const onUp = () => {
      if (dragState.current.dragging) {
        dragState.current.dragging = false;
        // 吸边并保存
        setPos((p) => {
          if (!p) return p;
          const clamped = clampToViewport(p.left, p.top);
          const snapped = snapIfNarrow(clamped.left, clamped.top);
          try { localStorage.setItem(storageKey, JSON.stringify(snapped)); } catch (e) { console.warn('Failed to persist topbar position:', e); }
          return snapped;
        });
      }
    };
    // 触摸事件
    let lastTouchX = 0;
    let lastTouchY = 0;
    const onTouchMove = (e: TouchEvent) => {
      if (!dragState.current.dragging) return;
      const t = e.touches[0];
      if (!t) return;
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      // Reuse the same rAF scheduler
      lastMouseX = lastTouchX;
      lastMouseY = lastTouchY;
      scheduleMove();
    };
    const onTouchEnd = () => onUp();
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onUp, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMove as any);
      window.removeEventListener('mouseup', onUp as any);
      window.removeEventListener('touchmove', onTouchMove as any);
      window.removeEventListener('touchend', onTouchEnd as any);
    };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    // 避免在交互元素上触发拖拽
    const target = (e.target as HTMLElement).closest('button, a, input, select, textarea');
    if (target) return;
    if (!outerRef.current || !pos) return;
    dragState.current.dragging = true;
    dragState.current.startX = e.clientX;
    dragState.current.startY = e.clientY;
    dragState.current.baseLeft = pos.left;
    dragState.current.baseTop = pos.top;
    e.preventDefault();
  };

  const startTouchDrag = (e: React.TouchEvent) => {
    const target = (e.target as HTMLElement).closest('button, a, input, select, textarea');
    if (target) return;
    if (!outerRef.current || !pos) return;
    const t = e.touches[0];
    if (!t) return;
    dragState.current.dragging = true;
    dragState.current.startX = t.clientX;
    dragState.current.startY = t.clientY;
    dragState.current.baseLeft = pos.left;
    dragState.current.baseTop = pos.top;
  };

  // 计算并更新滑动指示器位置（根据当前激活项）- 使用 rAF 节流，减少同步重排
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    let rafId: number | null = null;
    const schedule = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        recalcIndicator();
      });
    };
    // 初始计算
    schedule();
    const onResize = () => schedule();
    const onScroll = () => schedule();
    window.addEventListener('resize', onResize, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize as any);
      el.removeEventListener('scroll', onScroll as any);
    };
  }, [currentView, mounted, recalcIndicator]);

  // 横向滑动优化：将垂直滚轮转为水平滑动（被动监听，避免 scroll-blocking 警告）
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        // 不调用 preventDefault，使用被动监听以提升流畅度
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel as any);
  }, [navRef]);

  const primary = useMemo(() => navItems, []);
  const activeIndex = useMemo(() => primary.findIndex((it) => it.view === currentView), [primary, currentView]);

  const itemBase =
    'relative z-10 inline-flex items-center justify-center gap-2 px-4 min-w-[44px] h-11 select-none touch-manipulation icon-ghost-btn' +
    ' transition-[opacity,colors] duration-200 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background';
  const itemText = 'text-sm font-medium';
  const activeStyles = 'text-[hsl(var(--primary))]';
  const inactiveStyles = 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]';

  const safeScrolled = mounted ? scrolled : false;
  // Apple 风格：容器 12px 圆角
  const wrapperRadius = 'rounded-[12px]';
  const wrapperShadow = safeScrolled
    ? 'shadow-[0_6px_16px_hsl(var(--foreground)_/_0.08)]'
    : 'shadow-[0_8px_20px_hsl(var(--foreground)_/_0.06)]';
  // 顶部栏高度固定，展开/收起只改变宽度
  const barHeight = 'h-12';
  
  // 动态溢出检测：检查Topbar是否在当前窗口宽度下会溢出
  const [isOverflowing, setIsOverflowing] = useState(false);
  
  // 仅使用固定断点检测，禁用动态溢出检测（避免误判）
  const shouldHideTopbar = isSmallScreen;

  // 小屏幕时：隐藏Topbar，让旧版ModernSidebar显示
  if (shouldHideTopbar) {
    return null;
  }

  // 桌面模式：显示虚拟标题栏
  const content = (
    <div
      ref={outerRef}
      data-tauri-drag-region
      className="dstu-virtual-titlebar fixed top-0 left-0 right-0 h-10 flex items-center select-none bg-[hsl(var(--nav-background))] border-b border-border"
      style={{ zIndex: Z_INDEX.systemTitlebar }}
      onMouseDown={(e) => {
        // 在标记了 data-no-drag 的区域不触发拖拽
        const target = (e.target as HTMLElement).closest('[data-no-drag]');
        if (target) return;
        // 默认允许拖拽窗口
        e.preventDefault();
        try { void getCurrentWindow().startDragging(); } catch (e) { console.warn('Failed to start window dragging:', e); }
      }}
    >
      {/* macOS 红绿灯留白区域 */}
      {platform === 'macos' && (
        <div className="flex-shrink-0 w-[78px] h-full" data-tauri-drag-region />
      )}
      
      {/* 左侧：侧边栏折叠按钮 */}
      <div className="flex-shrink-0 flex items-center gap-2 pl-3" data-no-drag>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onToggleSidebar} className="hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]" style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, flexShrink: 0 }} title={sidebarCollapsed ? t('sidebar:expand', '展开侧边栏') : t('sidebar:collapse', '收起侧边栏')} aria-label={sidebarCollapsed ? t('sidebar:expand', '展开侧边栏') : t('sidebar:collapse', '收起侧边栏')}>
          {sidebarCollapsed ? (
            <ChevronsRight style={{ width: 16, height: 16, minWidth: 16, minHeight: 16 }} />
          ) : (
            <ChevronsLeft style={{ width: 16, height: 16, minWidth: 16, minHeight: 16 }} />
          )}
        </NotionButton>
      </div>
      
      {/* 中间：应用标题/面包屑导航 */}
      <div className="flex-1 flex items-center justify-center px-4" data-tauri-drag-region>
        {currentView === 'learning-hub' ? (
          <LearningHubBreadcrumb />
        ) : (
          <span className="text-sm font-medium text-[hsl(var(--foreground))]">
            Deep Student
          </span>
        )}
      </div>
      
      {/* 右侧：命令面板 + Windows窗口控制 */}
      <div className="flex-shrink-0 flex items-center gap-1 pr-3" data-no-drag>
        {/* 命令面板按钮 */}
        <CommandPaletteButton />
        
        {platform === 'windows' && (
          <div className="flex items-center ml-2">
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleMinimize} className="!h-8 !w-10 !rounded-none hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]" title={t('common:topbar.minimize')} aria-label={t('common:topbar.minimize')}>
              <Minus className="h-3.5 w-3.5" />
            </NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleMaximize} className="!h-8 !w-10 !rounded-none hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]" title={t('common:topbar.maximize_restore')} aria-label={t('common:topbar.maximize_restore')}>
              <Square className="h-3.5 w-3.5" />
            </NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleClose} className="!h-8 !w-10 !rounded-none hover:bg-red-500 hover:text-white text-[hsl(var(--foreground))]" title={t('common:topbar.close')} aria-label={t('common:topbar.close')}>
              <X className="h-3.5 w-3.5" />
            </NotionButton>
          </div>
        )}
      </div>
    </div>
  );

  return content;
}
