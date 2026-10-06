// قراءة وكتابة ملفات Excel (xlsx) بدون مكتبات خارجية: ZIP + XML عبر zlib
const zlib = require('zlib');

// ---------- ZIP ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // أسماء UTF-8
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0x00210000, 10); // وقت/تاريخ ثابت (1980-01-01)
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    locals.push(header, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ملف Excel تالف أو غير مدعوم');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ملف Excel تالف');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    // نفك فقط الملفات التي نحتاجها، مع حد للحجم بعد الفك
    files[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 200 * 1024 * 1024 }));
  }
  return files;
}

// ---------- XML ----------

const escXml = (s) => String(s)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unescXml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- الكتابة ----------

/**
 * sheets: [{ name, header: [..], rows: [[..]], widths?: [..] }]
 * القيم الرقمية تُكتب كأرقام، والباقي نصوص. الصف الأول عناوين بخط عريض ومثبّت.
 */
function writeXlsx(sheets) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${escXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0D9488"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
  };

  sheets.forEach((s, i) => {
    const all = [s.header, ...s.rows];
    const widths = s.header.map((h, c) => Math.min(60, Math.max(10,
      ...all.slice(0, 500).map((r) => String(r[c] ?? '').length + 2))));
    const rowsXml = all.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      if (v == null || v === '') return '';
      const ref = `${colName(ci)}${ri + 1}`;
      const style = ri === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0" rightToLeft="${s.rtl === false ? 0 : 1}"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowsXml}</sheetData>
</worksheet>`;
  });
  return zip(files);
}

// ---------- القراءة ----------

const isXlsx = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

/** يقرأ أول ورقة ويرجع مصفوفة صفوف، كل صف مصفوفة قيم (نص أو رقم) */
function readXlsx(buf) {
  const files = unzip(buf);
  const text = (name) => (files[name] ? files[name]().toString('utf8') : '');

  const shared = [];
  for (const si of text('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []) {
    shared.push(unescXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  }

  // مسار أول ورقة من workbook.xml.rels
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const firstSheet = text('xl/workbook.xml').match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (firstSheet) {
    const rel = text('xl/_rels/workbook.xml.rels').match(new RegExp(`<Relationship\\b[^>]*Id="${firstSheet[1]}"[^>]*>`));
    const target = rel?.[0].match(/Target="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = text(sheetPath);
  if (!sheet) throw new Error('لم يتم العثور على ورقة بيانات في الملف');

  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rowMatch[1] || rowMatch[3] || '';
    const rowNum = Number(attrs.match(/\br="(\d+)"/)?.[1]) || rows.length + 1;
    const cells = [];
    for (const c of (rowMatch[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = c[1];
      const ref = a.match(/\br="([A-Z]+)\d+"/)?.[1];
      const idx = ref ? colIndex(ref) : cells.length;
      const type = a.match(/\bt="([^"]+)"/)?.[1];
      const body = c[2] || '';
      let v = null;
      if (type === 'inlineStr') {
        v = unescXml((body.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));
      } else {
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (raw != null) {
          if (type === 's') v = shared[Number(raw)] ?? '';
          else if (type === 'str' || type === 'e') v = unescXml(raw);
          else if (type === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
          else v = Number(raw);
        }
      }
      cells[idx] = v;
    }
    rows[rowNum - 1] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(rows, (r) => r || []);
}

// رقم تسلسلي من Excel إلى تاريخ YYYY-MM-DD
function serialToIso(n) {
  if (!(n > 0 && n < 2958466)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return d.toISOString().slice(0, 10);
}

// يقرأ ملف Excel أو CSV ويرجع الصفوف
function readTable(buf) {
  if (isXlsx(buf)) return readXlsx(buf);
  const { parseCsv } = require('./csv');
  return parseCsv(Buffer.from(buf || '').toString('utf8').replace(/^\uFEFF/, ''));
}

const toLatinDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();

/**
 * يحوّل خلية تاريخ إلى YYYY-MM-DD: رقم Excel، أو 2026-01-31، أو 31/01/2026،
 * أو تاريخ هجري مثل 1448-02-23 (أي سنة أقل من 1600 تعتبر هجرية).
 * يرجع '' للخلية الفارغة، والنص كما هو لو تعذّر فهمه (ليظهر خطأ التحقق).
 */
function parseDateCell(v) {
  if (typeof v === 'number') return serialToIso(v) || String(v);
  const s = toLatinDigits(v).replace(/[هـم]\s*$/u, '').trim();
  if (!s) return '';
  let y; let m; let d;
  let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) [, y, m, d] = match;
  else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) [, d, m, y] = match;
  else if (/^\d{5}(\.\d+)?$/.test(s)) return serialToIso(Number(s)) || s;
  else return s;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (Number(y) < 1600) {
    const { hijriToGregorian } = require('../public/hijri');
    return hijriToGregorian(iso) || s;
  }
  return iso;
}

module.exports = { writeXlsx, readXlsx, readTable, isXlsx, serialToIso, parseDateCell, toLatinDigits, crc32 };
