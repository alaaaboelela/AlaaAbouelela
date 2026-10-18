#!/usr/bin/env bash
# تحديث منصة الإقامات لآخر نسخة على GitHub:  sudo bash /opt/iqama/app/iqama-tracker/deploy/update.sh
set -euo pipefail

BRANCH="${BRANCH:-claude/accommodations-expiry-alerts-lbi6qw}"
BASE=/opt/iqama
APP_DIR="$BASE/app/iqama-tracker"

[[ $EUID -eq 0 ]] || { echo "شغّلي السكربت بـ sudo" >&2; exit 1; }

echo "==> نسخة احتياطية قبل التحديث"
# لو الرفع الخارجي بس اللي فشل (كود 2) نكمّل، النسخة المحلية موجودة
/etc/cron.daily/iqama-backup || [[ $? -eq 2 ]]

echo "==> تنزيل آخر نسخة"
git -c safe.directory=$BASE/app -C $BASE/app fetch --depth 1 origin "$BRANCH"
git -c safe.directory=$BASE/app -C $BASE/app reset --hard FETCH_HEAD
chown -R iqama:iqama $BASE/app

# النسخ اليومي يشغّل السكربت اللي جوه البرنامج (للتثبيتات القديمة)
printf '#!/bin/sh\nexec bash %s/deploy/backup.sh\n' "$APP_DIR" > /etc/cron.daily/iqama-backup
chmod 755 /etc/cron.daily/iqama-backup
grep -q '^BACKUP_STATUS_FILE=' "$APP_DIR/.env" || echo "BACKUP_STATUS_FILE=$BASE/backup-status.json" >> "$APP_DIR/.env"

echo "==> تحديث المكتبات والجداول"
cd "$APP_DIR"
sudo -u iqama npm ci --omit=dev --no-audit --no-fund
sudo -u iqama npm run -s migrate

echo "==> إعادة التشغيل"
systemctl restart iqama
sleep 2
systemctl is-active --quiet iqama && echo "تم التحديث بنجاح" || { journalctl -u iqama -n 30 --no-pager; exit 1; }
