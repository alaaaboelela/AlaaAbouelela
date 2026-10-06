#!/usr/bin/env bash
# تحديث منصة الإقامات لآخر نسخة على GitHub:  sudo bash /opt/iqama/app/iqama-tracker/deploy/update.sh
set -euo pipefail

BRANCH="${BRANCH:-claude/accommodations-expiry-alerts-lbi6qw}"
BASE=/opt/iqama
APP_DIR="$BASE/app/iqama-tracker"

[[ $EUID -eq 0 ]] || { echo "شغّلي السكربت بـ sudo" >&2; exit 1; }

echo "==> نسخة احتياطية قبل التحديث"
/etc/cron.daily/iqama-backup

echo "==> تنزيل آخر نسخة"
git -c safe.directory=$BASE/app -C $BASE/app fetch --depth 1 origin "$BRANCH"
git -c safe.directory=$BASE/app -C $BASE/app reset --hard FETCH_HEAD
chown -R iqama:iqama $BASE/app

echo "==> تحديث المكتبات والجداول"
cd "$APP_DIR"
sudo -u iqama npm ci --omit=dev --no-audit --no-fund
sudo -u iqama npm run -s migrate

echo "==> إعادة التشغيل"
systemctl restart iqama
sleep 2
systemctl is-active --quiet iqama && echo "تم التحديث بنجاح" || { journalctl -u iqama -n 30 --no-pager; exit 1; }
