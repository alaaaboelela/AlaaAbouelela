// لغة الواجهة: العربية (الافتراضي) أو الإنجليزية، محفوظة على الجهاز.
// يتحمّل في أول الصفحة عشان الاتجاه يتظبط قبل العرض، والقاموس الإنجليزي بيتحمّل بس لو اللغة إنجليزي.
(function () {
  let lang = 'ar';
  try {
    if (localStorage.getItem('lang') === 'en') lang = 'en';
  } catch { /* التخزين غير متاح */ }
  const en = lang === 'en';
  window.I18N = {
    lang,
    dir: en ? 'ltr' : 'rtl',
    // تنسيق التواريخ الميلادية والهجرية بلغة الواجهة (أرقام لاتينية في الحالتين)
    locale: en ? 'en-GB' : 'ar-SA-u-ca-gregory-nu-latn',
    hijriLocale: en ? 'en-GB-u-ca-islamic-umalqura' : 'ar-SA-u-ca-islamic-umalqura-nu-latn',
    missing: new Set(),
    set(next) {
      try { localStorage.setItem('lang', next); } catch { /* تجاهل */ }
      location.reload();
    },
    toggle() { this.set(en ? 'ar' : 'en'); },
  };
  if (!en) return;
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  // تحميل متزامن أثناء قراءة الصفحة: الترجمة تشتغل قبل ما أي نص يظهر
  document.write('<script src="/lang-en.js"><\/script>');
})();
