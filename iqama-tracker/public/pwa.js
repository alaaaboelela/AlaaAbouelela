// تسجيل الـ Service Worker وزرار "تثبيت التطبيق"
const PWA = (() => {
  let deferred = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if ('serviceWorker' in navigator && window.isSecureContext) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    document.dispatchEvent(new Event('pwachange'));
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    document.dispatchEvent(new Event('pwachange'));
  });

  return {
    // installed | prompt (المتصفح يدعم زرار التثبيت) | ios (من قائمة المشاركة) | manual (من قائمة المتصفح) | insecure
    state() {
      if (isStandalone()) return 'installed';
      if (deferred) return 'prompt';
      if (isIos()) return 'ios';
      return window.isSecureContext ? 'manual' : 'insecure';
    },
    async install() {
      if (!deferred) return false;
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      document.dispatchEvent(new Event('pwachange'));
      return outcome === 'accepted';
    },
  };
})();
