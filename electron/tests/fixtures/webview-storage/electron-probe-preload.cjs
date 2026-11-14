// WP-045 取证夹具 preload（sandbox）：页面脚本运行前写入待迁移项；目标已有的键保留（target wins）。
const { ipcRenderer } = require('electron');

const pending = ipcRenderer.sendSync('wp045:pending');
if (pending !== null) {
  const written = [];
  const kept = [];
  for (const [key, value] of JSON.parse(pending)) {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, value);
      written.push(key);
    } else {
      kept.push(key);
    }
  }
  ipcRenderer.sendSync('wp045:applied', JSON.stringify({ written, kept }));
}
