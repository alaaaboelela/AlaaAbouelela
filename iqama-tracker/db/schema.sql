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

-- ==========================================================================
-- العقود، بطاقات السائقين، السيارات، السلف، العهد، المستندات
-- ==========================================================================

CREATE TABLE IF NOT EXISTS contracts (
  id              BIGSERIAL PRIMARY KEY,
  company_name    TEXT NOT NULL,
  contract_number TEXT NOT NULL DEFAULT '',
  contract_type   TEXT NOT NULL DEFAULT '',
  start_date      DATE,
  end_date        DATE NOT NULL,
  value           NUMERIC(14, 2),
  contact_person  TEXT NOT NULL DEFAULT '',
  contact_phone   TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracts_end_idx ON contracts (end_date);

CREATE TABLE IF NOT EXISTS driver_cards (
  id             BIGSERIAL PRIMARY KEY,
  employee_id    BIGINT NOT NULL REFERENCES residencies (id) ON DELETE CASCADE,
  card_number    TEXT NOT NULL,
  license_number TEXT NOT NULL DEFAULT '',
  issue_date     DATE,
  expiry_date    DATE NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_cards_employee_idx ON driver_cards (employee_id);
CREATE INDEX IF NOT EXISTS driver_cards_expiry_idx ON driver_cards (expiry_date);

CREATE TABLE IF NOT EXISTS cars (
  id                  BIGSERIAL PRIMARY KEY,
  plate_number        TEXT NOT NULL UNIQUE,
  make                TEXT NOT NULL DEFAULT '',
  model               TEXT NOT NULL DEFAULT '',
  year                INT,
  color               TEXT NOT NULL DEFAULT '',
  vin                 TEXT NOT NULL DEFAULT '',
  value               NUMERIC(14, 2),
  purchase_date       DATE,
  driver_id           BIGINT REFERENCES residencies (id) ON DELETE SET NULL,
  registration_expiry DATE,
  insurance_expiry    DATE,
  odometer            INT,
  car_status          TEXT NOT NULL DEFAULT 'في الخدمة',
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cars_driver_idx ON cars (driver_id);

CREATE TABLE IF NOT EXISTS car_events (
  id                BIGSERIAL PRIMARY KEY,
  car_id            BIGINT NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  event_date        DATE NOT NULL,
  event_type        TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  cost              NUMERIC(12, 2),
  odometer          INT,
  next_service_date DATE,
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS car_events_car_idx ON car_events (car_id, event_date DESC);

CREATE TABLE IF NOT EXISTS advances (
  id                  BIGSERIAL PRIMARY KEY,
  employee_id         BIGINT NOT NULL REFERENCES residencies (id) ON DELETE RESTRICT,
  amount              NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  issue_date          DATE NOT NULL,
  monthly_installment NUMERIC(12, 2),
  reason              TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS advances_employee_idx ON advances (employee_id);

CREATE TABLE IF NOT EXISTS advance_payments (
  id         BIGSERIAL PRIMARY KEY,
  advance_id BIGINT NOT NULL REFERENCES advances (id) ON DELETE CASCADE,
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  paid_date  DATE NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS advance_payments_advance_idx ON advance_payments (advance_id);

CREATE TABLE IF NOT EXISTS custody (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   BIGINT NOT NULL REFERENCES residencies (id) ON DELETE RESTRICT,
  item_name     TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  quantity      INT NOT NULL DEFAULT 1,
  value         NUMERIC(12, 2),
  handed_date   DATE NOT NULL,
  returned_date DATE,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custody_employee_idx ON custody (employee_id);

CREATE TABLE IF NOT EXISTS documents (
  id            BIGSERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     BIGINT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL DEFAULT '',
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  uploaded_by   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_entity_idx ON documents (entity_type, entity_id);

-- ==========================================================================
-- تقييمات الموظفين
-- ==========================================================================

CREATE TABLE IF NOT EXISTS evaluations (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     BIGINT NOT NULL REFERENCES residencies (id) ON DELETE CASCADE,
  evaluation_date DATE NOT NULL,
  period          TEXT NOT NULL DEFAULT '',
  evaluator       TEXT NOT NULL DEFAULT '',
  quality         SMALLINT NOT NULL CHECK (quality BETWEEN 1 AND 5),
  commitment      SMALLINT NOT NULL CHECK (commitment BETWEEN 1 AND 5),
  behavior        SMALLINT NOT NULL CHECK (behavior BETWEEN 1 AND 5),
  teamwork        SMALLINT NOT NULL CHECK (teamwork BETWEEN 1 AND 5),
  productivity    SMALLINT NOT NULL CHECK (productivity BETWEEN 1 AND 5),
  recommendation  TEXT NOT NULL DEFAULT '',
  strengths       TEXT NOT NULL DEFAULT '',
  improvements    TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evaluations_employee_idx ON evaluations (employee_id, evaluation_date DESC);

-- ==========================================================================
-- المستخدمين والصلاحيات وسجل العمليات
-- ==========================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_name   TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  details     JSONB,
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- ==========================================================================
-- مستندات الموظف، تأشيرات الخروج والعودة، الإجازات
-- ==========================================================================

ALTER TABLE residencies ADD COLUMN IF NOT EXISTS annual_leave_days INT NOT NULL DEFAULT 21;

CREATE TABLE IF NOT EXISTS employee_docs (
  id          BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES residencies (id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL,
  doc_number  TEXT NOT NULL DEFAULT '',
  issuer      TEXT NOT NULL DEFAULT '',
  issue_date  DATE,
  expiry_date DATE NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employee_docs_employee_idx ON employee_docs (employee_id);
CREATE INDEX IF NOT EXISTS employee_docs_expiry_idx ON employee_docs (expiry_date);

CREATE TABLE IF NOT EXISTS visas (
  id                 BIGSERIAL PRIMARY KEY,
  employee_id        BIGINT NOT NULL REFERENCES residencies (id) ON DELETE CASCADE,
  visa_type          TEXT NOT NULL,
  visa_number        TEXT NOT NULL DEFAULT '',
  issue_date         DATE,
  departure_date     DATE,
  return_deadline    DATE NOT NULL,
  actual_return_date DATE,
  destination        TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visas_employee_idx ON visas (employee_id);
CREATE INDEX IF NOT EXISTS visas_deadline_idx ON visas (return_deadline);

CREATE TABLE IF NOT EXISTS leaves (
  id          BIGSERIAL PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES residencies (id) ON DELETE CASCADE,
  leave_type  TEXT NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  approval    TEXT NOT NULL DEFAULT 'معلقة',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS leaves_employee_idx ON leaves (employee_id, start_date);

-- الفروع / المنشآت
CREATE TABLE IF NOT EXISTS branches (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  city           TEXT NOT NULL DEFAULT '',
  cr_number      TEXT NOT NULL DEFAULT '',
  unified_number TEXT NOT NULL DEFAULT '',
  manager        TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- الموظف والعقد والسيارة تتبع فرعًا؛ باقي الأقسام تتبع فرع الموظف
ALTER TABLE residencies ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches (id) ON DELETE RESTRICT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches (id) ON DELETE RESTRICT;
ALTER TABLE cars ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches (id) ON DELETE RESTRICT;
-- مستخدم مربوط بفرع يرى بيانات فرعه فقط (فارغ = كل الفروع)
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS residencies_branch_idx ON residencies (branch_id, expiry_date);
CREATE INDEX IF NOT EXISTS contracts_branch_idx ON contracts (branch_id);
CREATE INDEX IF NOT EXISTS cars_branch_idx ON cars (branch_id);

-- صورة الموظف (اسم الملف داخل مجلد الرفع)
ALTER TABLE residencies ADD COLUMN IF NOT EXISTS photo TEXT;
