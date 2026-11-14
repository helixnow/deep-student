(function () {
  var root = document.documentElement;
  // 界面字号缩放：设置里持久化的 scale，首帧前先套上，避免启动瞬间字号跳变
  try {
    var rawScale = window.localStorage.getItem('app-font-size-scale');
    if (rawScale) {
      var parsedScale = parseFloat(rawScale);
      if (!Number.isNaN(parsedScale) && parsedScale >= 0.75 && parsedScale <= 1.5) {
        root.style.setProperty('--font-size-scale', String(parsedScale));
      }
    }
  } catch (e) {}
  // 启动前主题预判：桌面 CSP 只允许 self 脚本，因此必须放在外部文件里
  var isDark;
  try {
    var mode =
      window.localStorage.getItem('dstu-theme-mode') ||
      window.localStorage.getItem('aimm-theme-mode') ||
      window.localStorage.getItem('theme') ||
      'auto';
    isDark = mode === 'dark' ? true : mode === 'light' ? false : window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    isDark = true;
  }
  root.setAttribute('data-boot-theme', isDark ? 'dark' : 'light');
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  root.classList.toggle('dark', isDark);
  try {
    root.style.colorScheme = isDark ? 'dark' : 'light';
  } catch (e) {}
})();
