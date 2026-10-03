-- مخطط قاعدة البيانات (آمن للتشغيل أكثر من مرة)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS residencies (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  iqama_number VARCHAR(10) NOT NULL UNIQUE,
  expiry_date  DATE NOT NULL,
  nationality  TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  employer     TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- فلترة الحالة والترتيب تعتمد على تاريخ الانتهاء
CREATE INDEX IF NOT EXISTS residencies_expiry_idx ON residencies (expiry_date);
-- البحث الجزئي بالاسم ورقم الإقامة وجهة العمل
CREATE INDEX IF NOT EXISTS residencies_name_trgm_idx ON residencies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS residencies_iqama_trgm_idx ON residencies USING gin (iqama_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS residencies_employer_trgm_idx ON residencies USING gin (employer gin_trgm_ops);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('alert_days', '30') ON CONFLICT DO NOTHING;
