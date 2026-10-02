import React from 'react';

/**
 * 启动面（boot surface）。
 *
 * React 接管 `#root` 后的第一帧必须与 index.html 里的静态占位符**视觉完全一致**，
 * 否则用户会看到「logo 微光 → 安全检查卡片 → 应用」这种三段跳。业界通则
 * （Apple HIG 启动屏 / Android SplashScreen API / SSR hydration）都要求启动面
 * 静态、无文案、无进度：进度与状态旁白属于应用内界面。
 *
 * 因此这里只渲染 logo 微光，不渲染任何文字或 spinner：
 * - 启动闸门（preflight / maintenance）照常在后台跑，只有需要用户介入的失败
 *   路径才切到 RecoveryShell / ComponentRecoveryShell——那才是安全检查该出现的地方。
 * - 样式来自 public/boot.css（index.html 以阻塞 <link> 引入同一份），类名与静态
 *   占位符保持一致；不要在这里引入新的 CSS 或设计 token，否则交接会漂移。
 * - 不使用 i18n：data 命名空间是懒加载的，启动期文案会先显示原始 key 再跳成译文。
 *
 * @see tests/vitest/startup/bootSurface.contract.test.ts
 */
export const BootShell: React.FC = () => (
  <div className="boot-loading" role="status" aria-label="Deep Student loading">
    <div className="boot-loading__logo-wrap">
      <img
        className="boot-loading__logo"
        src="/logo-black.svg"
        alt="Deep Student"
        width={60}
        height={60}
      />
      <img
        className="boot-loading__logo boot-loading__logo--shine"
        src="/logo-black.svg"
        alt=""
        aria-hidden="true"
        width={60}
        height={60}
      />
    </div>
  </div>
);

export default BootShell;