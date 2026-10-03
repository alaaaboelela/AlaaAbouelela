// قراءة وكتابة CSV (يدعم الحقول بين علامات تنصيص والفواصل داخلها)

function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Excel العربي يحفظ CSV أحيانًا بفاصلة منقوطة
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  return (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
}

function escapeField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  // BOM حتى يفتح Excel الملف بالعربي بشكل صحيح
  return '﻿' + [header, ...rows].map((r) => r.map(escapeField).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parseCsv, toCsv };
