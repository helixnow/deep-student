/**
 * OS 模式跨平台拖拽性能防回归。
 *
 * 这些断言锁定审查结论中的硬约束：一旦有人把 GPU 关掉、恢复全 DOM cursor
 * 通配、或在拖拽 class 下动态切 contain，CI 会立刻失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readRepo(...parts: string[]): string {
  return fs.readFileSync(path.join(root, ...parts), 'utf8');
}

describe('OS mode drag performance anti-regression', () => {
  it('Windows WebView2 不得全局关闭 GPU / GPU 合成', () => {
    const conf = readRepo('src-tauri', 'tauri.windows.conf.json');
    expect(conf).not.toMatch(/--disable-gpu(?!-)/);
    expect(conf).not.toContain('--disable-gpu-compositing');
    // 遮挡计算关闭会让后台页/合成行为异常；OS 模式依赖正常合成路径
    expect(conf).not.toContain('CalculateNativeWinOcclusion');
  });

  it('全局光标锁禁止 :root[data-wb-cursor] * 通配后代', () => {
    const css = readRepo('src', 'features', 'workbench', 'styles', 'a11y-cursor.css');
    // 去掉块注释后再断言，避免文档里的「禁止 `:root[...] *`」字样误伤
    const withoutBlockComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutBlockComments).not.toMatch(/:root\[data-wb-cursor[^\]]*\]\s+\*/);
    expect(css).toMatch(/:root\[data-wb-cursor\]::after/);
  });

  it('拖/缩 class 不得动态增加 contain / content-visibility / isolation', () => {
    const css = readRepo('src', 'features', 'workbench', 'components', 'WindowShell.css');
    expect(css).not.toMatch(
      /\.wb-window\.wb-shell-(?:dragging|resizing)[^{]*\{[^}]*(?:contain|content-visibility|isolation)\s*:/,
    );
    expect(css).toMatch(/不要在拖\/缩 class 下动态增加 contain/);
  });

  it('WindowShell 起拖延后光标盾与 scheduler，禁止 pointerdown 同步抢帧', () => {
    const src = readRepo('src', 'features', 'workbench', 'components', 'WindowShell.tsx');
    expect(src).toContain('enterShellGestureGlobal');
    expect(src).toContain('shellGestureFlags');
    expect(src).not.toMatch(/renewDragSchedulerActivity/);
    expect(src).not.toMatch(/reportSchedulerActivity\(\s*['"]drag['"]/);
    expect(src).not.toMatch(/content\.style\.contain\s*=/);
    expect(src).not.toMatch(/contentVisibility\s*=\s*['"]auto['"]/);
    // 光标锁不得在 begin 同步调用（须 rAF 延后）
    expect(src).toMatch(/requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*?lockWorkbenchCursor/);
    expect(src).toContain('ensureLayoutFrame');
  });

  it('起拖同步挂 data-wb-dragging；flush/scheduler 双 rAF 后且 refreshHints:false', () => {
    const flags = readRepo('src', 'features', 'workbench', 'core', 'shellGestureFlags.ts');
    // 同步挂旗
    expect(flags).toMatch(/setAttr\(DRAGGING_ATTR,\s*true\)/);
    // flush 与 beginSchedulerDragActivity 必须在双 rAF 之后（禁止 pointerdown 同栈）
    expect(flags).toMatch(
      /requestAnimationFrame\([\s\S]*?requestAnimationFrame[\s\S]*?flushHeavyContentPause\(true\)/,
    );
    expect(flags).toMatch(/beginSchedulerDragActivity\(\{\s*refreshHints:\s*false\s*\}\)/);
    // settle 桥接：松手不清旗直到 settle 接手或超时
    expect(flags).toContain('beginShellSettling');
    expect(flags).toContain('SETTLE_BRIDGE_MS');
  });

  it('tileAll 必须批量 setDisplayMode；SnapPreview 同帧只动画一扇', () => {
    const menu = readRepo('src', 'features', 'workbench', 'components', 'DesktopContextMenu.tsx');
    expect(menu).toContain('batchSetDisplayModes');
    const snap = readRepo('src', 'features', 'workbench', 'components', 'SnapPreview.tsx');
    expect(snap).toContain('beginShellSettling');
    expect(snap).toMatch(/只动画最近聚焦/);
  });

  it('内容暂停 CSS 禁止 host * 通配', () => {
    const content = readRepo(
      'src',
      'features',
      'workbench',
      'apps',
      'content',
      'ContentAppWindow.css',
    );
    const files = readRepo('src', 'features', 'workbench', 'apps', 'files', 'FilesAppWindow.css');
    const chat = readRepo('src', 'features', 'workbench', 'apps', 'chat', 'ChatSessionSurface.css');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(strip(content)).not.toMatch(/\[data-wb-render-paused\]\s+\*/);
    expect(strip(files)).not.toMatch(/\[data-wb-render-paused\]\s+\*/);
    expect(strip(chat)).not.toMatch(/\[data-wb-render-paused\]\s+\*/);
  });

  it('流式 smoothing 与 Chat 表面必须在手势期让路', () => {
    const smoothing = readRepo(
      'src',
      'features',
      'chat',
      'components',
      'renderers',
      'streamingSmoothing.ts',
    );
    expect(smoothing).toContain('shouldPauseHeavyContent');
    const chat = readRepo('src', 'features', 'workbench', 'apps', 'chat', 'ChatSessionSurface.tsx');
    expect(chat).toContain('useDragRenderPause');
  });

  it('Settings 窗：活树跟手；禁止截图冻结 / 嵌套抬层 / attr 弄脏', () => {
    const app = readRepo(
      'src',
      'features',
      'workbench',
      'apps',
      'system',
      'SettingsAppWindow.tsx',
    );
    expect(app).toContain('data-wb-settings-host');
    expect(app).toContain('data-wb-settings-layer');
    // 活树路径：禁止截图冻结；也不挂 render-paused（属性翻转弄脏层）
    expect(app).not.toMatch(/import\s*\{[^}]*useDragVisualFreeze/);
    expect(app).not.toMatch(/import\s*\{[^}]*useDragRenderPause/);
    expect(app).not.toContain('@zumer/snapdom');

    const css = readRepo(
      'src',
      'features',
      'workbench',
      'apps',
      'system',
      'SettingsAppWindow.css',
    );
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    // 并入窗壳单层：禁止 settings 自建 contain / translateZ / will-change
    expect(strip(css)).not.toMatch(/contain\s*:/);
    expect(strip(css)).not.toMatch(/translateZ\(/);
    expect(strip(css)).not.toMatch(/will-change\s*:\s*transform/);
    expect(strip(css)).not.toMatch(/display:\s*none\s*!important/);
    expect(strip(css)).not.toContain('data-wb-drag-frozen');
    expect(strip(css)).not.toContain('data-wb-drag-snap-surface');
    expect(strip(css)).not.toMatch(/\[data-wb-settings-host\][^{]*\*/);

    // 跟手期清窗内 blur（直接属性；禁止窗根翻转继承变量逼整树 recalc）
    const wb = readRepo('src', 'features', 'workbench', 'styles', 'workbench.css');
    expect(wb).toMatch(
      /\.wb-window\.wb-shell-dragging[\s\S]*?backdrop-filter:\s*none\s*!important/,
    );
    expect(wb).not.toMatch(
      /\.wb-window\.wb-shell-dragging[^{]*\{[^}]*--wb-glass-blur:\s*none/,
    );

    // 跟手期 inert+aria-hidden：剪 AX 树，内容仍可见
    const shell = readRepo('src', 'features', 'workbench', 'components', 'WindowShell.tsx');
    expect(shell).toContain("setAttribute('aria-hidden', 'true')");
    expect(shell).toContain('content.inert = true');
    expect(shell).toContain('timeInteractionPhase');
    expect(shell).toContain('layoutAnchor');
    expect(shell).toContain('shellClass');
    expect(shell).toContain("markInteraction('armed')");

    const trace = readRepo('src', 'features', 'workbench', 'core', 'interactionTrace.ts');
    expect(trace).toContain('timeInteractionPhase');
    expect(trace).toContain('schema: \'interactionTrace.v2\'');
    expect(trace).toContain('buckets');

    // settings 故意不进 heavy flush：跟手期不得对其 setAttribute
    const flags = readRepo('src', 'features', 'workbench', 'core', 'shellGestureFlags.ts');
    expect(flags).not.toMatch(/HEAVY_HOST_SELECTOR[\s\S]*?\[data-wb-settings-host\]/);
  });

  it('桌面偏移通过 ref 快照提供，禁止手势 provider 内 getBoundingClientRect', () => {
    const src = readRepo('src', 'features', 'workbench', 'components', 'WorkbenchDesktop.tsx');
    expect(src).toContain('desktopOffsetRef');
    expect(src).toMatch(/setWorkbenchDesktopOffsetProvider\(\s*\(\)\s*=>\s*desktopOffsetRef\.current/);
    const providerBlock = src.slice(
      src.indexOf('setWorkbenchDesktopOffsetProvider'),
      src.indexOf('setWorkbenchDesktopOffsetProvider') + 280,
    );
    expect(providerBlock).not.toContain('getBoundingClientRect');
    // 平铺中缝也必须走缓存快照，禁止本地 querySelector+getBoundingClientRect
    expect(src).toContain('getDesktopOffset: getWorkbenchDesktopOffset');
  });

  it('StageManager 不得在 start() 无条件启动 perfMonitor', () => {
    const src = readRepo('src', 'features', 'workbench', 'agent', 'stageManager.ts');
    expect(src).toContain('acquirePerfMonitor');
    expect(src).toContain('syncPerfMonitorForActiveRuns');
    // 空闲桌面常驻 rAF 会拖慢拖拽；只允许活跃 run / DevPanel 持有
    expect(src).not.toMatch(/start\(\)\s*\{[\s\S]*?startPerfMonitor\s*\(/);
  });

  it('重内容窗必须消费 renderThrottleMs（Chat / Content / Mindmap）', () => {
    const chat = readRepo('src', 'features', 'workbench', 'apps', 'chat', 'ChatSessionSurface.tsx');
    expect(chat).toContain('useDeferredStreamPreset(isVisible, renderThrottleMs)');

    const content = readRepo(
      'src',
      'features',
      'workbench',
      'apps',
      'content',
      'ContentAppWindow.tsx',
    );
    expect(content).toContain('useDragRenderPause');
    expect(content).toContain('renderThrottleMs');
    // 内容窗禁止因 throttle 翻转 isActive（试卷秒表 / 笔记键盘）
    expect(content).not.toMatch(/isActive\s*&&\s*renderThrottleMs\s*<=\s*0/);
    expect(content).toMatch(/isActive=\{isActive\}/);

    const mindmap = readRepo(
      'src',
      'features',
      'workbench',
      'apps',
      'mindmap',
      'MindmapAppWindow.tsx',
    );
    expect(mindmap).toContain('useDragRenderPause');
    // 导图禁止因 throttle 翻转 isActive（会同步 saveDraftSync）
    expect(mindmap).not.toMatch(/isActive\s*&&\s*renderThrottleMs\s*<=\s*0/);
    expect(mindmap).toMatch(/isActive=\{isActive\}/);
  });

  it('lib.rs 保留 WebView2 GPU 防回归注释', () => {
    const src = readRepo('src-tauri', 'src', 'lib.rs');
    expect(src).toMatch(/ANTI-REGRESSION[\s\S]*disable-gpu/);
  });

  // 2026-07-10 OS 模式整层错位事故：WebView2 GPU 合成下「containment 边界 +
  // 视差 transform + 子树大量 transform/backdrop-filter」触发 DComp 脏区错算，
  // 桌面整体垂直错位（顶部黑条、Dock 画出窗框）。以下断言锁定修复。
  it('OS 模式桌面级合成链禁止残留 containment（WebView2 脏区错位防回归）', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
    // 壁纸根：禁止一切 contain（paint 也不行；裁切由 wb-wallpaper-frame overflow 承担）
    const wallpaper = readRepo(
      'src',
      'features',
      'workbench',
      'components',
      'WallpaperLayer.css',
    );
    expect(strip(wallpaper)).not.toMatch(/contain\s*:/);
    // content-body 在 workbench 模式最多允许 style containment（禁 layout/paint）
    const app = readRepo('src', 'shared', 'styles', 'app.css');
    const workbenchRule = app.match(
      /\.content-body\.content-body--workbench\s*\{[^}]*\}/,
    )?.[0];
    expect(workbenchRule).toBeTruthy();
    expect(workbenchRule).not.toMatch(/contain\s*:\s*[^;]*(layout|paint|content|strict)/);
  });

  it('Windows WebView2 呈现自愈两层接线存在（宿主 Notify + 前端 nudge）', () => {
    // 宿主侧：Focused/Resized/ScaleFactorChanged → NotifyParentWindowPositionChanged
    const librs = readRepo('src-tauri', 'src', 'lib.rs');
    expect(librs).toContain('NotifyParentWindowPositionChanged');
    expect(librs).toMatch(/WindowEvent::Focused\(true\)[\s\S]*?ScaleFactorChanged/);
    // 页面侧：桌面根整面重绘 nudge 挂载在 WorkbenchDesktop
    const desktop = readRepo(
      'src',
      'features',
      'workbench',
      'components',
      'WorkbenchDesktop.tsx',
    );
    expect(desktop).toContain('useCompositorNudge(rootRef)');
    const hook = readRepo('src', 'features', 'workbench', 'hooks', 'useCompositorNudge.ts');
    // nudge 必须尊重拖拽热路径（不与跟手 transform 抢帧）
    expect(hook).toContain('data-wb-dragging');
    expect(hook).toContain('isShellGestureActive');
    expect(hook).toContain("translateZ(0)");
  });

  it('交互延迟时间线接线存在（interactionTrace + DevPanel + 落盘）', () => {
    const trace = readRepo('src', 'features', 'workbench', 'core', 'interactionTrace.ts');
    expect(trace).toContain('__WB_INTERACTION_TRACE__');
    expect(trace).toContain('.tmp/wb-interaction-trace.json');
    expect(trace).toContain('/__wb_interaction_trace');

    const shell = readRepo('src', 'features', 'workbench', 'components', 'WindowShell.tsx');
    expect(shell).toContain('beginInteraction');
    expect(shell).toContain('markInteraction');
    expect(shell).toContain('endInteraction');

    const snap = readRepo('src', 'features', 'workbench', 'components', 'SnapPreview.tsx');
    expect(snap).toContain("kind: 'snap.settle'");

    const hud = readRepo('src', 'features', 'workbench', 'components', 'WorkbenchDevPanel.tsx');
    expect(hud).toContain('wb-hud-interactions');
    expect(hud).toContain('acquireInteractionTrace');

    const vite = readRepo('vite.config.ts');
    expect(vite).toContain('workbenchInteractionTracePlugin');
    expect(vite).toContain('/__wb_interaction_trace');
  });
});
