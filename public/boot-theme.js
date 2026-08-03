(function () {
  var isDark;
  try {
    var mode = window.localStorage.getItem('dstu-theme-mode') || window.localStorage.getItem('aimm-theme-mode') || 'auto';
    isDark = mode === 'dark' ? true : mode === 'light' ? false : window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    isDark = true;
  }
  var root = document.documentElement;
  root.setAttribute('data-boot-theme', isDark ? 'dark' : 'light');
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  root.classList.toggle('dark', isDark);
  try {
    root.style.colorScheme = isDark ? 'dark' : 'light';
  } catch (e) {}
})();
