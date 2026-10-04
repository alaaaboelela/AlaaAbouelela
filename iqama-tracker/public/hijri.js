// تحويل التاريخ بين الهجري (تقويم أم القرى) والميلادي باستخدام Intl
// يعمل في المتصفح وفي Node.js
(function (root) {
  const DAY = 86400000;
  const HIJRI_EPOCH = Date.UTC(622, 6, 16);
  const formatter = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
    timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
  });

  function toHijri(ms) {
    const parts = {};
    for (const p of formatter.formatToParts(new Date(ms))) parts[p.type] = Number(p.value);
    return { year: parts.year, month: parts.month, day: parts.day };
  }

  function iso(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  // "1448-04-22" (هجري) => "2026-10-03" (ميلادي)، أو null إذا كان التاريخ غير موجود
  function hijriToGregorian(value) {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(value).trim());
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 1350 || y > 1500 || mo < 1 || mo > 12 || d < 1 || d > 30) return null;

    const target = (y * 12 + mo) * 30 + d;
    let t = HIJRI_EPOCH + Math.floor(((y - 1) * 354.367 + (mo - 1) * 29.53 + (d - 1))) * DAY;
    for (let i = 0; i < 6; i++) {
      const h = toHijri(t);
      const diff = target - ((h.year * 12 + h.month) * 30 + h.day);
      if (diff === 0) break;
      t += diff * DAY;
    }
    // تصحيح دقيق حول التقدير (الأشهر 29 أو 30 يوم)
    for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
      const h = toHijri(t + offset * DAY);
      if (h.year === y && h.month === mo && h.day === d) return iso(t + offset * DAY);
    }
    return null;
  }

  // "2026-10-03" => "1448-04-22"
  function gregorianToHijri(value) {
    const ms = Date.parse(String(value) + 'T00:00:00Z');
    if (Number.isNaN(ms)) return null;
    const h = toHijri(ms);
    return `${h.year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`;
  }

  const api = { hijriToGregorian, gregorianToHijri };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hijri = api;
})(this);
