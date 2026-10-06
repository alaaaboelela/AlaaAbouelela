#!/usr/bin/env bash
# ==========================================================================
# تثبيت منصة الإقامات على سيرفر Ubuntu (22.04 أو 24.04) بأمر واحد:
#
#   curl -fsSL https://raw.githubusercontent.com/alaaaboelela/AlaaAbouelela/claude/accommodations-expiry-alerts-lbi6qw/iqama-tracker/deploy/install.sh | sudo bash
#
# يجهّز: Node.js، PostgreSQL، Nginx، شهادة HTTPS (لو فيه دومين)، تشغيل تلقائي،
# جدار حماية، ونسخ احتياطي يومي. آمن للتشغيل أكثر من مرة.
# ==========================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/alaaaboelela/AlaaAbouelela.git}"
BRANCH="${BRANCH:-claude/accommodations-expiry-alerts-lbi6qw}"
BASE=/opt/iqama
APP_DIR="$BASE/app/iqama-tracker"
UPLOAD_DIR="$BASE/uploads"
BACKUP_DIR=/var/backups/iqama
SERVICE=iqama
APP_USER=iqama
DB_NAME=iqama
DB_USER=iqama
PORT=3000

green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
red() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ask() { local __var=$1 __prompt=$2 __default=${3:-} __reply; read -r -p "$__prompt" __reply </dev/tty; printf -v "$__var" '%s' "${__reply:-$__default}"; }
ask_secret() { local __var=$1 __prompt=$2 __reply; read -r -s -p "$__prompt" __reply </dev/tty; echo; printf -v "$__var" '%s' "$__reply"; }

[[ $EUID -eq 0 ]] || { red "شغّلي السكربت بصلاحيات root (استخدمي sudo)"; exit 1; }
grep -qi ubuntu /etc/os-release || yellow "تنبيه: السكربت مُجرّب على Ubuntu فقط"

# ---------- الأسئلة ----------

step "إعدادات التثبيت"
echo "اتركي الدومين فارغًا لو لسه ما عندكيش دومين (هيشتغل على IP السيرفر)."
ask DOMAIN "الدومين (مثال hr.company.com): "
DOMAIN=${DOMAIN,,}
CERT_EMAIL=""
[[ -n $DOMAIN ]] && ask CERT_EMAIL "إيميلك لشهادة HTTPS: "

ask ADMIN_USER "اسم مستخدم المدير [admin]: " admin
while true; do
  ask_secret ADMIN_PASS "كلمة مرور المدير (8 أحرف على الأقل): "
  ask_secret ADMIN_PASS2 "أعيدي كتابة كلمة المرور: "
  [[ ${#ADMIN_PASS} -ge 8 && $ADMIN_PASS == "$ADMIN_PASS2" ]] && break
  red "كلمتا المرور غير متطابقتين أو أقصر من 8 أحرف، حاولي تاني"
done

echo
echo "تنبيهات الإيميل اليومية (اختياري، اضغطي Enter للتخطي):"
ask ALERT_EMAILS "الإيميلات اللي يوصلها التنبيه (مفصولة بفاصلة): "
SMTP_HOST="" SMTP_PORT=587 SMTP_USER="" SMTP_PASS=""
if [[ -n $ALERT_EMAILS ]]; then
  ask SMTP_HOST "خادم SMTP [smtp.office365.com]: " smtp.office365.com
  ask SMTP_PORT "بورت SMTP [587]: " 587
  ask SMTP_USER "إيميل الإرسال: "
  ask_secret SMTP_PASS "كلمة مرور إيميل الإرسال: "
fi

# ---------- الحزم ----------

step "تثبيت الحزم الأساسية"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git nginx postgresql postgresql-contrib ufw gzip
[[ -n $DOMAIN ]] && apt-get install -y certbot python3-certbot-nginx

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') -lt 20 ]]; then
  step "تثبيت Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
green "Node.js $(node -v)"

# ---------- المستخدم والكود ----------

step "تنزيل البرنامج"
id -u $APP_USER >/dev/null 2>&1 || useradd --system --home $BASE --shell /usr/sbin/nologin $APP_USER
mkdir -p $BASE $UPLOAD_DIR
if [[ -d $BASE/app/.git ]]; then
  git -c safe.directory=$BASE/app -C $BASE/app fetch --depth 1 origin "$BRANCH"
  git -c safe.directory=$BASE/app -C $BASE/app reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" $BASE/app
fi
chown -R $APP_USER:$APP_USER $BASE

# ---------- قاعدة البيانات ----------

step "تجهيز قاعدة البيانات"
systemctl enable --now postgresql
ENV_FILE="$APP_DIR/.env"
if [[ -f $ENV_FILE ]] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  yellow "ملف الإعدادات موجود من تثبيت سابق، سيتم الاحتفاظ بكلمة مرور قاعدة البيانات"
  DB_PASS=$(sed -n 's|^DATABASE_URL=postgres://[^:]*:\([^@]*\)@.*|\1|p' "$ENV_FILE")
else
  DB_PASS=$(openssl rand -hex 24)
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE $DB_USER PASSWORD '$DB_PASS';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O $DB_USER $DB_NAME
sudo -u postgres psql -d $DB_NAME -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# ---------- الإعدادات ----------

step "كتابة ملف الإعدادات"
SESSION_SECRET=$(grep -s '^SESSION_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)
[[ -n $SESSION_SECRET ]] || SESSION_SECRET=$(openssl rand -hex 32)
COOKIE_SECURE=false
[[ -n $DOMAIN ]] && COOKIE_SECURE=true
umask 077
cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=$PORT
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
SESSION_SECRET=$SESSION_SECRET
SESSION_HOURS=12
COOKIE_SECURE=$COOKIE_SECURE
APP_TIMEZONE=Asia/Riyadh
UPLOAD_DIR=$UPLOAD_DIR
MAX_UPLOAD_MB=20
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_SECURE=$([[ $SMTP_PORT == 465 ]] && echo true || echo false)
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
SMTP_FROM=$SMTP_USER
ALERT_EMAILS=$ALERT_EMAILS
ALERT_HOUR=8
ENV
umask 022
chown $APP_USER:$APP_USER "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------- تثبيت وتجهيز البرنامج ----------

step "تثبيت مكتبات البرنامج وتجهيز الجداول"
cd "$APP_DIR"
sudo -u $APP_USER npm ci --omit=dev --no-audit --no-fund
sudo -u $APP_USER npm run -s migrate
sudo -u $APP_USER node scripts/create-user.js "$ADMIN_USER" "$ADMIN_PASS"

# ---------- التشغيل التلقائي ----------

step "تشغيل البرنامج كخدمة"
cat > /etc/systemd/system/$SERVICE.service <<UNIT
[Unit]
Description=منصة الإقامات
After=network.target postgresql.service
Requires=postgresql.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$UPLOAD_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable $SERVICE
systemctl restart $SERVICE

# ---------- Nginx و HTTPS ----------

step "ربط Nginx"
cat > /etc/nginx/sites-available/$SERVICE <<NGINX
server {
    listen 80;
    server_name ${DOMAIN:-_};
    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/$SERVICE /etc/nginx/sites-enabled/$SERVICE
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

step "جدار الحماية"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

if [[ -n $DOMAIN ]]; then
  step "شهادة HTTPS"
  if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERT_EMAIL" --redirect; then
    red "تعذر إصدار الشهادة. تأكدي أن الدومين $DOMAIN موجّه على IP السيرفر ثم شغّلي:"
    red "  sudo certbot --nginx -d $DOMAIN"
    red "مؤقتًا سيعمل البرنامج عبر http"
    sed -i 's/^COOKIE_SECURE=true/COOKIE_SECURE=false/' "$ENV_FILE"
    systemctl restart $SERVICE
  fi
fi

# ---------- النسخ الاحتياطي اليومي ----------

step "النسخ الاحتياطي اليومي"
mkdir -p $BACKUP_DIR
chmod 700 $BACKUP_DIR
cat > /etc/cron.daily/iqama-backup <<BACKUP
#!/bin/sh
set -e
D=\$(date +%F)
sudo -u postgres pg_dump $DB_NAME | gzip > $BACKUP_DIR/db-\$D.sql.gz
tar czf $BACKUP_DIR/uploads-\$D.tgz -C $BASE uploads
find $BACKUP_DIR -type f -mtime +14 -delete
BACKUP
chmod 755 /etc/cron.daily/iqama-backup

# ---------- النتيجة ----------

sleep 2
if systemctl is-active --quiet $SERVICE; then
  URL="http://$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  if [[ -n $DOMAIN ]]; then
    grep -q '^COOKIE_SECURE=true' "$ENV_FILE" && URL="https://$DOMAIN" || URL="http://$DOMAIN"
  fi
  echo
  green "=============================================="
  green " تم التثبيت بنجاح"
  green " افتحي: $URL"
  green " اسم المستخدم: $ADMIN_USER"
  green "=============================================="
  echo "التحديث لاحقًا:   sudo bash $APP_DIR/deploy/update.sh"
  echo "سجل البرنامج:     sudo journalctl -u $SERVICE -f"
  echo "النسخ الاحتياطية: $BACKUP_DIR (يوميًا، آخر 14 يوم)"
else
  red "البرنامج لم يعمل. السجل:"
  journalctl -u $SERVICE -n 30 --no-pager
  exit 1
fi
