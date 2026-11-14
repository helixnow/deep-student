// 最早的全局错误过滤器 - 过滤 Tauri HTTP 插件的已知 bug。
// 必须是外链文件：渲染进程的 CSP 为 script-src 'self'，内联脚本会被拦截
// （X1 真实 dist 证据：index.html 原内联版本触发 Executing inline script violates script-src）。
(function () {
  window.addEventListener(
    'unhandledrejection',
    function (event) {
      var reason = event.reason;
      var message = '';
      if (reason instanceof Error) {
        message = reason.message || '';
      } else if (typeof reason === 'string') {
        message = reason;
      } else if (reason && typeof reason === 'object' && reason.message) {
        message = String(reason.message);
      }
      // 过滤 Tauri HTTP 插件的 fetch_cancel_body 错误
      if (message.indexOf('fetch_cancel_body') !== -1 || message.indexOf('http.fetch_cancel_body') !== -1) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
})();
