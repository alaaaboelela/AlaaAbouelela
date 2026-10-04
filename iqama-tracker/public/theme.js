// تطبيق الوضع (فاتح / داكن) قبل رسم الصفحة لتجنب الوميض
(function () {
  let theme = 'system';
  try { theme = localStorage.getItem('theme') || 'system'; } catch { /* تجاهل */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

  window.Theme = {
    get: () => theme,
    isDark: () => (theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : theme === 'dark'),
    set(value) {
      theme = value;
      try { localStorage.setItem('theme', value); } catch { /* تجاهل */ }
      if (value === 'system') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = value;
      document.dispatchEvent(new CustomEvent('themechange'));
    },
    toggle() { this.set(this.isDark() ? 'light' : 'dark'); },
  };
})();
