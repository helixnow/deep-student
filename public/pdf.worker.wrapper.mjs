// Worker 入口包装：pdfjs-dist v5 依赖 Promise.withResolvers，而 Worker 有独立的
// 全局作用域，主线程 polyfill（src/polyfills/promiseWithResolvers.ts）不生效。
// 旧 WebView（iOS < 17.4 / Android Chromium < 119）必须经此包装加载 worker。
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;

    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { promise, resolve, reject };
  };
}

import './pdf.worker.min.mjs';
