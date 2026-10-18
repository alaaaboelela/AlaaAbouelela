// النسخ الاحتياطي: ملف ZIP واحد فيه كل الجداول (JSON) وكل المستندات والصور،
// يتنزّل من الإعدادات ويتحفظ خارج السيرفر، ويُستعاد بـ npm run restore
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { pool, getSetting, setSetting } = require('./db');
const { UPLOAD_DIR } = require('./crud');
const { crc32: slowCrc32, unzip } = require('./xlsx');
const audit = require('./audit');

const FORMAT = 1;
const crc32 = zlib.crc32 || slowCrc32;
const STATUS_FILE = process.env.BACKUP_STATUS_FILE || '';
// صيغ مضغوطة أصلًا: تُخزّن بدون ضغط لتوفير وقت المعالج
const STORED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.docx', '.xlsx', '.zip', '.gz']);

// ---------- كتابة ZIP على دفعات (ملف ملف) بدون تحميل الكل في الذاكرة ----------

function zipWriter(out) {
  const centrals = [];
  let offset = 0;
  let count = 0;
  const write = (buf) => new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('انقطع الاتصال أثناء التنزيل'));
    offset += buf.length;
    if (out.write(buf)) return resolve();
    const done = (err) => {
      out.off('drain', done);
      out.off('close', closed);
      if (err) reject(err);
      else resolve();
    };
    const closed = () => done(new Error('انقطع الاتصال أثناء التنزيل'));
    out.on('drain', done);
    out.on('close', closed);
  });
  const dosTime = (d) => {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return ((date << 16) | time) >>> 0;
  };

  return {
    async add(name, data, mtime = new Date()) {
      if (typeof data === 'string') data = Buffer.from(data, 'utf8');
      let packed = STORED.has(path.extname(name).toLowerCase()) ? data : zlib.deflateRawSync(data);
      let method = 8;
      if (packed === data || packed.length >= data.length) { packed = data; method = 0; }
      if (offset + packed.length > 0xfffffff0) throw new Error('حجم النسخة تجاوز 4 جيجا، نزّليها بدون المستندات');
      const nameBuf = Buffer.from(name, 'utf8');
      const crc = crc32(data);
      const stamp = dosTime(mtime);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt32LE(stamp, 10);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(packed.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt32LE(stamp, 12);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(packed.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      count++;

      await write(Buffer.concat([header, nameBuf]));
      await write(packed);
    },
    async finish() {
      const centralBuf = Buffer.concat(centrals);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(count, 8);
      end.writeUInt16LE(count, 10);
      end.writeUInt32LE(centralBuf.length, 12);
      end.writeUInt32LE(offset, 16);
      await write(Buffer.concat([centralBuf, end]));
    },
  };
}

// ---------- الجداول ----------

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function listTables(db = pool) {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`);
  return rows.map((r) => r.table_name);
}

// ترتيب الجداول بحيث يأتي الجدول قبل أي جدول يشير إليه (للاستعادة بدون أخطاء المفاتيح)
async function orderedTables(db = pool) {
  const tables = await listTables(db);
  const { rows } = await db.query(
    `SELECT c.relname AS child, p.relname AS parent
     FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid
     JOIN pg_class p ON p.oid = k.confrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE k.contype = 'f' AND n.nspname = current_schema()`);
  const parents = new Map(tables.map((t) => [t, new Set()]));
  for (const r of rows) if (r.child !== r.parent) parents.get(r.child)?.add(r.parent);
  const out = [];
  const seen = new Set();
  const visit = (t) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of parents.get(t) || []) visit(p);
    out.push(t);
  };
  tables.forEach(visit);
  return out;
}

async function tableColumns(db, table) {
  const { rows } = await db.query(
    `SELECT column_name, data_type, column_default, is_identity FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows;
}

// ---------- الحالة ----------

// حجم وعدد ملفات المستندات والصور
function walkUploads(dir = UPLOAD_DIR, base = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(dir, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkUploads(dir, rel));
    else if (e.isFile()) {
      const st = fs.statSync(path.join(dir, rel));
      out.push({ rel, size: st.size, mtime: st.mtime });
    }
  }
  return out;
}

// حالة النسخ التلقائي على السيرفر (يكتبها deploy/backup.sh)
function serverStatus() {
  if (!STATUS_FILE) return null;
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ---------- إنشاء النسخة ----------

async function writeBackup(out, { files = true, user = '' } = {}) {
  const zipOut = zipWriter(out);
  const tables = await orderedTables();
  const counts = {};
  for (const table of tables) {
    const cols = (await tableColumns(pool, table)).map((c) => c.column_name);
    const { rows } = await pool.query(`SELECT * FROM ${q(table)} ORDER BY 1`);
    counts[table] = rows.length;
    await zipOut.add(`data/${table}.json`, JSON.stringify({ table, columns: cols, rows: rows.map((r) => cols.map((c) => r[c])) }));
  }
  const uploads = files ? walkUploads() : [];
  for (const f of uploads) {
    await zipOut.add(`uploads/${f.rel}`, fs.readFileSync(path.join(UPLOAD_DIR, f.rel)), f.mtime);
  }
  const manifest = {
    app: 'iqama-tracker',
    format: FORMAT,
    createdAt: new Date().toISOString(),
    createdBy: user,
    database: pool.embedded ? 'pglite' : 'postgres',
    order: tables,
    tables: counts,
    files: uploads.length,
    includesFiles: files,
  };
  await zipOut.add('manifest.json', JSON.stringify(manifest, null, 2));
  await zipOut.add('اقرأني.txt', [
    'نسخة احتياطية من منصة الإقامات',
    `التاريخ: ${manifest.createdAt}`,
    '',
    'للاستعادة على نفس السيرفر أو سيرفر جديد (بعد تثبيت المنصة):',
    '  1) أوقفي البرنامج:   sudo systemctl stop iqama',
    '  2) من مجلد البرنامج:  npm run restore -- /path/to/this-file.zip',
    '  3) شغّليه تاني:      sudo systemctl start iqama',
    '',
    'الاستعادة بتمسح البيانات الحالية وتحط مكانها بيانات النسخة.',
  ].join('\r\n'));
  await zipOut.finish();
  return manifest;
}

// ---------- الاستعادة ----------

async function restoreBackup(buffer, { files = true, uploadDir = UPLOAD_DIR } = {}) {
  const entries = unzip(buffer);
  if (!entries['manifest.json']) throw new Error('الملف ليس نسخة احتياطية من المنصة (لا يوجد manifest.json)');
  const manifest = JSON.parse(entries['manifest.json']().toString('utf8'));
  if (manifest.app !== 'iqama-tracker') throw new Error('الملف ليس نسخة احتياطية من المنصة');
  if (manifest.format > FORMAT) throw new Error('النسخة من إصدار أحدث من البرنامج، حدّثي البرنامج أولًا');

  const current = await orderedTables();
  const restored = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // كل جداول البرنامج تتفرغ، حتى اللي مش في النسخة (نسخة أقدم)، عشان ما يفضلش بيانات قديمة
    await client.query(`TRUNCATE ${current.map(q).join(', ')} RESTART IDENTITY CASCADE`);
    for (const table of current) {
      const entry = entries[`data/${table}.json`];
      if (!entry) continue;
      const data = JSON.parse(entry().toString('utf8'));
      const info = await tableColumns(client, table);
      const known = new Map(info.map((c) => [c.column_name, c]));
      // أعمدة موجودة في النسخة وفي الجدول الحالي فقط (تحمّل اختلاف الإصدارات)
      const idx = data.columns.map((c, i) => [c, i]).filter(([c]) => known.has(c));
      if (idx.length && data.rows.length) {
        const isJson = idx.map(([c]) => ['json', 'jsonb'].includes(known.get(c).data_type));
        const batch = Math.max(1, Math.min(1000, Math.floor(30000 / idx.length)));
        for (let start = 0; start < data.rows.length; start += batch) {
          const chunk = data.rows.slice(start, start + batch);
          const params = [];
          const values = chunk.map((row) => `(${idx.map(([, i], k) => {
            const v = row[i];
            params.push(v != null && isJson[k] ? JSON.stringify(v) : v);
            return `$${params.length}`;
          }).join(', ')})`);
          await client.query(`INSERT INTO ${q(table)} (${idx.map(([c]) => q(c)).join(', ')}) VALUES ${values.join(', ')}`, params);
        }
      }
      // العدّاد التلقائي يكمل بعد أكبر رقم
      for (const c of info.filter((x) => x.is_identity === 'YES' || String(x.column_default || '').startsWith('nextval('))) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX(${q(c.column_name)}), 0) + 1, false) FROM ${q(table)}`,
          [table, c.column_name]);
      }
      restored[table] = data.rows.length;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let restoredFiles = 0;
  if (files) {
    const root = path.resolve(uploadDir);
    for (const [name, read] of Object.entries(entries)) {
      if (!name.startsWith('uploads/') || name.endsWith('/')) continue;
      const target = path.resolve(root, name.slice('uploads/'.length));
      if (!target.startsWith(root + path.sep)) continue; // حماية من المسارات الخارجة عن المجلد
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read());
      restoredFiles++;
    }
  }
  return { manifest, tables: restored, files: restoredFiles };
}

// ---------- المسارات (مدير النظام فقط، وبدون تقييد بفرع) ----------

const router = express.Router();

function fullAdmin(req, res, next) {
  if (req.user.role !== 'admin' || req.branchLocked) {
    return res.status(403).json({ error: 'النسخ الاحتياطي متاح لمدير النظام فقط' });
  }
  return next();
}

router.get('/backup', fullAdmin, async (req, res) => {
  const uploads = walkUploads();
  let last = null;
  try {
    last = JSON.parse((await getSetting('last_backup_download')) || 'null');
  } catch { /* تجاهل */ }
  res.json({
    server: serverStatus(),
    serverConfigured: Boolean(STATUS_FILE),
    lastDownload: last,
    files: uploads.length,
    filesSize: uploads.reduce((s, f) => s + f.size, 0),
  });
});

router.get('/backup/download', fullAdmin, async (req, res) => {
  const files = req.query.files !== '0';
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="iqama-backup-${stamp}.zip"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const manifest = await writeBackup(res, { files, user: req.user.name });
    res.end();
    await setSetting('last_backup_download', JSON.stringify({ at: manifest.createdAt, user: req.user.name, files }));
    const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
    audit.log(req, 'backup', 'backup', '', `تنزيل نسخة احتياطية (${rows} سجل${files ? `، ${manifest.files} ملف` : '، بدون المستندات'})`);
  } catch (err) {
    console.error('تعذر إنشاء النسخة الاحتياطية:', err.message);
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      res.status(500).json({ error: 'تعذر إنشاء النسخة الاحتياطية' });
    }
    else res.destroy(err);
  }
});

module.exports = { router, writeBackup, restoreBackup, orderedTables, serverStatus, zipWriter };
