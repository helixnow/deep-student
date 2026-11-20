/**
 * Deep Student WebUI Service Worker (App-Shell PWA).
 *
 * 缓存策略：
 * 1. 永不拦截 `/api/*`（WebSocket RPC、HTTP 206 Range 流、暂存/导出、鉴权）
 *    与 Vite 开发/HMR 端点（`/@vite`、`/@fs`、`/src/`、`/node_modules/`）。
 * 2. 内容哈希产物 `/assets/` → Cache-First（`CACHE_NAME`）：文件名带 hash，可以永久缓存；
 *    只缓存 200 且非 HTML 的响应，避免把错误页/登录闸门当成静态资源。
 * 3. 非哈希静态资源（`/cmaps/`、`/standard_fonts/`、`/wasm/`、`/fonts/`、`pdf.worker.min.mjs`）
 *    → Stale-While-Revalidate（`STATIC_CACHE_NAME`）：先给缓存，后台换新，PDF.js 首屏零等待。
 * 4. 导航与 App-Shell 根资源 → Network-First，失败回退缓存/离线页。
 */
const SHELL_CACHE_PREFIX = 'ds-webui-shell-v1';
const BUILD_HASH = '__DS_WEB_BUILD_HASH__';
const CACHE_NAME = BUILD_HASH.startsWith('__') ? SHELL_CACHE_PREFIX : `${SHELL_CACHE_PREFIX}-${BUILD_HASH}`;
const STATIC_CACHE_NAME = BUILD_HASH.startsWith('__') ? 'ds-webui-static-v1' : `ds-webui-static-v1-${BUILD_HASH}`;
const SHELL_NETWORK_TIMEOUT_MS = 5000;

const APP_SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/boot.css',
  '/boot-theme.js',
  '/error-filter.js',
  '/app-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/logo-black.svg',
  '/deepstudent-logo.svg',
];

/** 内容哈希产物：文件名一变就是新 URL，直接缓存到底。 */
const HASHED_ASSET_PREFIXES = ['/assets/'];

/** 非哈希静态资源：同名 URL 会原地更新，用 stale-while-revalidate。 */
const STATIC_ASSET_PREFIXES = ['/cmaps/', '/standard_fonts/', '/wasm/', '/fonts/'];
const STATIC_ASSET_FILES = ['/pdf.worker.min.mjs'];

const BYPASS_PREFIXES = [
  '/api/',
  '/@vite',
  '/@react-refresh',
  '/@id/',
  '/@fs/',
  '/src/',
  '/web/',
  '/electron/',
  '/host/',
  '/node_modules/',
  '/__wb_interaction_trace',
];

const VALID_PWA_SHORTCUTS = new Set(['chat', 'library', 'review']);
const PENDING_SHORTCUT_STORAGE_KEY = 'ds_webui_pending_shortcut';

const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover" />
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fdfcfb" />
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121212" />
  <title>Deep Student — 离线提示</title>
  <style>
    :root {
      color-scheme: dark;
      --background: 0 0% 7%;
      --foreground: 0 0% 96%;
      --card: 0 0% 9.8%;
      --muted-foreground: 0 0% 60%;
      --border: 0 0% 18%;
      --ring: 214 58% 68%;
      --status-paused: 38 65% 50%;
      --button-primary-surface: hsl(0 0% 96% / 0.12);
      --button-primary-surface-hover: hsl(0 0% 96% / 0.18);
      --button-primary-fg: hsl(0 0% 96%);
    }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --background: 40 20% 99%;
        --foreground: 220 9% 18%;
        --card: 0 0% 99%;
        --muted-foreground: 220 6% 42%;
        --border: 0 0% 88%;
        --ring: 214 62% 50%;
        --status-paused: 38 70% 45%;
        --button-primary-surface: hsl(220 9% 18% / 0.9);
        --button-primary-surface-hover: hsl(220 9% 18% / 0.82);
        --button-primary-fg: hsl(0 0% 100%);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding:
        max(24px, env(safe-area-inset-top))
        max(24px, env(safe-area-inset-right))
        max(24px, env(safe-area-inset-bottom))
        max(24px, env(safe-area-inset-left));
      overflow-y: auto;
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif;
    }
    .card {
      width: 100%;
      max-width: 420px;
      padding: 24px;
      border-radius: 12px;
      background: hsl(var(--card));
      border: 1px solid hsl(var(--border) / 0.35);
    }
    .status-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: hsl(var(--muted-foreground));
      margin-bottom: 12px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 9999px;
      background: hsl(var(--status-paused));
      flex-shrink: 0;
    }
    .divider {
      height: 1px;
      background: hsl(var(--border) / 0.35);
      margin: 12px 0 16px;
      border: 0;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 16px;
      font-weight: 600;
      line-height: 1.4;
    }
    p {
      margin: 0 0 14px;
      font-size: 14px;
      color: hsl(var(--muted-foreground));
      line-height: 1.55;
    }
    .tips {
      margin: 0 0 18px;
      padding: 12px 14px 12px 28px;
      border-radius: 8px;
      border: 1px solid hsl(var(--border) / 0.35);
      background: hsl(var(--background) / 0.45);
      color: hsl(var(--muted-foreground));
      font-size: 13px;
      line-height: 1.55;
    }
    .tips li + li {
      margin-top: 6px;
    }
    button {
      width: 100%;
      min-height: 44px;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid hsl(var(--border) / 0.35);
      background: var(--button-primary-surface);
      color: var(--button-primary-fg);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover:not(:disabled) {
      background: var(--button-primary-surface-hover);
    }
    button:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    button:focus-visible {
      outline: 2px solid hsl(var(--ring));
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <main class="card" role="main">
    <div class="status-row">
      <span class="status-dot" aria-hidden="true"></span>
      <span>Deep Student 网页工作台</span>
    </div>
    <hr class="divider" />
    <h1>当前无法连接 Deep Student 宿主服务</h1>
    <p>请按以下步骤快速检查连接状态，网络恢复在线后将自动重连：</p>
    <ul class="tips" data-testid="ds-sw-offline-tips">
      <li>确认电脑端 Deep Student 桌面服务已开启并保持运行（电脑未休眠）</li>
      <li>确认手机或平板与电脑连接在同一 Wi-Fi / 局域网下</li>
      <li>若刚切换热点或路由器，请重新核对电脑端显示的访问地址</li>
    </ul>
    <button id="ds-sw-offline-retry" type="button">立即重试</button>
  </main>
  <script>
    (function () {
      function persistShortcut() {
        try {
          var s = new URLSearchParams(window.location.search).get('shortcut');
          if (s === 'chat' || s === 'library' || s === 'review') {
            window.sessionStorage.setItem('${PENDING_SHORTCUT_STORAGE_KEY}', s);
          }
        } catch (e) {}
      }
      persistShortcut();
      var retrying = false;
      var btn = document.getElementById('ds-sw-offline-retry');
      function retryNow() {
        if (retrying) return;
        retrying = true;
        persistShortcut();
        if (btn) {
          btn.disabled = true;
          btn.textContent = '正在重试连接…';
        }
        window.location.reload();
      }
      if (btn) {
        btn.addEventListener('click', retryNow);
      }
      window.addEventListener('online', function () {
        persistShortcut();
        fetch('/api/health', { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
          .then(function () { retryNow(); })
          .catch(function () { retryNow(); });
      });
    })();
  </script>
</body>
</html>`;

function readValidShortcutFromUrl(url) {
  const raw = (url.searchParams.get('shortcut') || '').trim().toLowerCase();
  return VALID_PWA_SHORTCUTS.has(raw) ? raw : null;
}

/**
 * 导航请求命中服务端 401 登录闸门且携带合法 PWA 快捷入口（`?shortcut=chat|library|review`）时，
 * 注入轻量渐进增强脚本：先将 shortcut 存入 sessionStorage，并优先通过同源 JSON 会话接口认证后
 * 原地进入目标快捷入口，避免服务端表单 `303 -> /` 跳转丢失 `?shortcut=`。
 */
async function preserveShortcutThroughLoginGate(response, shortcut) {
  if (
    !shortcut ||
    !response ||
    response.status !== 401 ||
    !/\btext\/html\b/i.test(response.headers.get('content-type') || '')
  ) {
    return response;
  }
  const html = await response.text();
  if (!html.includes('</body>')) {
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const injectedScript = `<script>(function(){try{window.sessionStorage.setItem(${JSON.stringify(PENDING_SHORTCUT_STORAGE_KEY)},${JSON.stringify(shortcut)});}catch(e){}var form=document.getElementById('ds-web-token-form');var input=document.getElementById('ds-token-input');var btn=document.getElementById('ds-web-token-submit');var err=document.getElementById('ds-web-token-error');if(!form||!input||typeof window.fetch!=='function')return;form.addEventListener('submit',function(ev){ev.preventDefault();ev.stopImmediatePropagation();var token=(input.value||'').trim();if(!token){if(err)err.textContent='访问令牌无效，请核对后重试';input.focus();return;}if(btn){btn.disabled=true;btn.textContent='正在验证…';}input.disabled=true;if(err)err.textContent='';window.fetch('/api/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:token})}).then(function(res){if(res.ok){var next=new URL(window.location.href);next.searchParams.delete('token');next.searchParams.set('shortcut',${JSON.stringify(shortcut)});window.location.replace(next.pathname+next.search+next.hash);return;}if(err)err.textContent=res.status===429?'尝试次数过多，请稍后再试':'访问令牌无效，请核对后重试';}).catch(function(){if(err)err.textContent='无法连接桌面服务，请检查电脑端服务与同一 Wi-Fi 后重试';}).finally(function(){if(btn){btn.disabled=false;btn.textContent='验证并进入';}input.disabled=false;});},true);})();</script>`;
  const nextHtml = html.replace('</body>', `${injectedScript}</body>`);
  const responseHeaders = {
    'Content-Type': response.headers.get('content-type') || 'text/html; charset=utf-8',
    'Cache-Control': response.headers.get('cache-control') || 'no-store',
  };
  return new Response(nextHtml, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/** 只缓存完整、非 HTML 的 200 响应（导航请求本身除外）：登录闸门/错误页冒充静态资源被缓存会让应用彻底打不开。 */
function isCacheableResponse(response, navigation = false) {
  if (!response || response.status !== 200 || response.redirected) return false;
  if (/\bno-store\b/i.test(response.headers.get('cache-control') || '')) return false;
  if (navigation) return true;
  return !/\btext\/html\b/i.test(response.headers.get('content-type') || '');
}

function cacheResponse(event, cache, key, response) {
  // Quota/磁盘错误不能让成功的网络请求失败，也不能变成未处理的 rejection。
  event.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
}

function isStaticAssetPath(pathname) {
  return (
    STATIC_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    STATIC_ASSET_FILES.includes(pathname)
  );
}

/** 弱网连接可能一直不返回响应头，不能无限阻塞离线壳回退。 */
async function fetchShell(request) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(request, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('App shell network timeout'));
        }, SHELL_NETWORK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(
      // addAll 是原子操作：一个图标失败就会连成功下载的 HTML/CSS 一起丢弃。
      APP_SHELL_URLS.map(async (url) => {
        try {
          const response = await fetchShell(url);
          if (isCacheableResponse(response, url === '/')) {
            await cache.put(url, response);
          }
        } catch {
          // 预缓存尽力而为，单个资源失败不阻止其他资源入缓存。
        }
      }),
    )).catch(() => undefined),
  );
  // 已有 controller 时不自作主张接管：等用户在更新提示里点「刷新启用」（SKIP_WAITING）。
  if (!self.registration.active) {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) =>
            key === CACHE_NAME || key === STATIC_CACHE_NAME ||
              (!key.startsWith('ds-webui-shell-') && !key.startsWith('ds-webui-static-'))
              ? Promise.resolve(false)
              : caches.delete(key),
          ),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || request.headers.get('upgrade')?.toLowerCase() === 'websocket') return;

  for (const prefix of BYPASS_PREFIXES) {
    if (url.pathname.startsWith(prefix)) return;
  }

  // 1) 内容哈希产物：Cache-First
  if (HASHED_ASSET_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (isCacheableResponse(response)) {
          cacheResponse(event, cache, request, response);
        }
        return response;
      }),
    );
    return;
  }

  // 2) 非哈希静态资源：Stale-While-Revalidate
  if (isStaticAssetPath(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        const revalidate = fetch(request)
          .then(async (response) => {
            if (isCacheableResponse(response)) {
              await cache.put(request, response.clone()).catch(() => undefined);
            }
            return response;
          })
          .catch(() => undefined);
        // A cache hit settles respondWith immediately; keep the worker alive for refresh.
        event.waitUntil(revalidate);
        if (cached) {
          return cached;
        }
        const response = await revalidate;
        if (response) return response;
        throw new Error('Static asset unavailable');
      }),
    );
    return;
  }

  // 3) 导航与 App-Shell：Network-First + 缓存回退
  if (request.mode === 'navigate' || APP_SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          // 优先用浏览器预热的导航响应；没有时走带超时的 fetchShell。
          const response = (await event.preloadResponse?.catch(() => undefined)) || await fetchShell(request);
          // 导航响应就是 App-Shell 本身（HTML），必须缓存，否则离线打不开
          if (isCacheableResponse(response, request.mode === 'navigate')) {
            const cacheKey = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')
              ? '/' : request;
            cacheResponse(event, cache, cacheKey, response);
          } else if (request.mode === 'navigate') {
            const shortcut = readValidShortcutFromUrl(url);
            if (shortcut) {
              return await preserveShortcutThroughLoginGate(response, shortcut);
            }
          }
          return response;
        } catch (err) {
          const fallback =
            (await cache.match(request)) ||
            (request.mode === 'navigate'
              ? (await cache.match('/index.html')) || (await cache.match('/'))
              : undefined);
          if (fallback) return fallback;
          if (request.mode === 'navigate') {
            return new Response(OFFLINE_FALLBACK_HTML, {
              status: 503,
              statusText: 'Service Unavailable',
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
              },
            });
          }
          throw err;
        }
      })(),
    );
  }
});
