// نسبة السعودة: السعودي = رقم هوية يبدأ بـ 1، أو جنسية مسجّلة "سعودي/سعودية"
// للموظفين على رأس العمل فقط، لكل فرع، مع الهدف المحدد في الإعدادات
const { pool, getSetting } = require('./db');

const SAUDI_NAMES = ['سعودي', 'سعودية', 'سعودى', 'السعودية', 'سعودي الجنسية', 'saudi', 'saudi arabian', 'saudi arabia', 'ksa'];

const saudiSql = (alias = 'residencies') => `(${alias}.iqama_number LIKE '1%'
  OR lower(trim(${alias}.nationality)) IN (${SAUDI_NAMES.map((n) => `'${n}'`).join(', ')}))`;

async function getTarget() {
  const v = Number(await getSetting('saudization_target'));
  return Number.isFinite(v) && v > 0 && v < 100 ? v : 0;
}

const ratio = (saudis, total) => (total ? Math.round((saudis / total) * 1000) / 10 : 0);

// عدد السعوديين اللي محتاج يتعينوا عشان النسبة توصل للهدف (التعيين يزوّد الإجمالي كمان)
function needed(saudis, total, target) {
  if (!target || !total) return 0;
  return Math.max(0, Math.ceil((target * total - 100 * saudis) / (100 - target)));
}

async function summary(branch = null) {
  const target = await getTarget();
  const { rows } = await pool.query(
    `SELECT e.branch_id::text AS id, COALESCE(b.name, '') AS name, count(*)::int AS total,
       count(*) FILTER (WHERE ${saudiSql('e')})::int AS saudis
     FROM residencies e LEFT JOIN branches b ON b.id = e.branch_id
     WHERE e.employment_status = 'active' AND ($1::bigint IS NULL OR e.branch_id = $1::bigint)
     GROUP BY 1, 2 ORDER BY count(*) DESC`, [branch]);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const saudis = rows.reduce((s, r) => s + r.saudis, 0);
  return {
    total,
    saudis,
    ratio: ratio(saudis, total),
    target,
    needed: needed(saudis, total, target),
    branches: rows.map((r) => ({
      id: r.id, name: r.name || 'بدون فرع', total: r.total, saudis: r.saudis,
      ratio: ratio(r.saudis, r.total), needed: needed(r.saudis, r.total, target),
    })),
  };
}

async function byNationality(branch = null) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN ${saudiSql('e')} THEN 'سعودي' ELSE COALESCE(NULLIF(trim(e.nationality), ''), 'غير محددة') END AS nationality,
       count(*)::int AS n
     FROM residencies e
     WHERE e.employment_status = 'active' AND ($1::bigint IS NULL OR e.branch_id = $1::bigint)
     GROUP BY 1 ORDER BY 2 DESC, 1`, [branch]);
  return rows;
}

module.exports = { summary, byNationality, saudiSql, needed, ratio, getTarget };
