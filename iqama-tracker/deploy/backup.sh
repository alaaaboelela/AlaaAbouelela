#!/usr/bin/env bash
# ==========================================================================
# النسخ الاحتياطي اليومي (يشغّله cron كل يوم من /etc/cron.daily/iqama-backup):
#   - قاعدة البيانات (pg_dump) + مجلد المستندات والصور، في /var/backups/iqama
#   - ورفع نفس الملفات خارج السيرفر لو مضبوط (Google Drive / OneDrive / S3 / سيرفر تاني)
#     عن طريق rclone. الضبط مرة واحدة:  sudo bash deploy/setup-offsite-backup.sh
#   - وكتابة حالة آخر نسخة في ملف تقرأه المنصة وتعرضه في الإعدادات
#
# التشغيل يدويًا:  sudo bash /opt/iqama/app/iqama-tracker/deploy/backup.sh
# ==========================================================================
set -uo pipefail

DB_NAME=iqama
BASE=/opt/iqama
BACKUP_DIR=/var/backups/iqama
KEEP_DAYS=14
REMOTE=""
REMOTE_KEEP_DAYS=60
STATUS_FILE=$BASE/backup-status.json
export RCLONE_CONFIG=/etc/iqama/rclone.conf
# shellcheck source=/dev/null
[[ -f /etc/iqama/backup.conf ]] && . /etc/iqama/backup.conf

[[ $EUID -eq 0 ]] || { echo "شغّلي السكربت بـ sudo" >&2; exit 1; }

D=$(date +%F)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
errors=()
local_failed=false

if sudo -u postgres pg_dump "$DB_NAME" | gzip > "$BACKUP_DIR/db-$D.sql.gz.part"; then
  mv -f "$BACKUP_DIR/db-$D.sql.gz.part" "$BACKUP_DIR/db-$D.sql.gz"
else
  rm -f "$BACKUP_DIR/db-$D.sql.gz.part"
  errors+=("فشل نسخ قاعدة البيانات")
  local_failed=true
fi

if [[ -d $BASE/uploads ]]; then
  if tar czf "$BACKUP_DIR/uploads-$D.tgz.part" -C "$BASE" uploads; then
    mv -f "$BACKUP_DIR/uploads-$D.tgz.part" "$BACKUP_DIR/uploads-$D.tgz"
  else
    rm -f "$BACKUP_DIR/uploads-$D.tgz.part"
    errors+=("فشل نسخ المستندات")
    local_failed=true
  fi
fi

find "$BACKUP_DIR" -type f -mtime +"$KEEP_DAYS" -delete

remote_ok=null
if [[ -n $REMOTE ]]; then
  if ! command -v rclone >/dev/null; then
    remote_ok=false
    errors+=("rclone غير مثبّت")
  elif rclone copy "$BACKUP_DIR" "$REMOTE" --include "*-$D.*" --retries 3 --low-level-retries 10; then
    remote_ok=true
    # حذف النسخ القديمة من التخزين الخارجي فقط بعد نجاح رفع نسخة اليوم
    rclone delete "$REMOTE" --min-age "${REMOTE_KEEP_DAYS}d" || true
  else
    remote_ok=false
    errors+=("فشل الرفع على $REMOTE")
  fi
fi

size=$(du -cb "$BACKUP_DIR"/*-"$D".* 2>/dev/null | tail -1 | cut -f1)
ok=true
error=""
if ((${#errors[@]})); then
  ok=false
  error=$(printf '%s، ' "${errors[@]}" | sed 's/، $//' | tr -d '"\\')
fi
printf '{"time":"%s","ok":%s,"size":%s,"remote":"%s","remoteOk":%s,"keepDays":%s,"remoteKeepDays":%s,"error":"%s"}\n' \
  "$(date -Is)" "$ok" "${size:-0}" "${REMOTE//\"/}" "$remote_ok" "$KEEP_DAYS" "$REMOTE_KEEP_DAYS" "$error" > "$STATUS_FILE.tmp"
chmod 644 "$STATUS_FILE.tmp"
mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"

if [[ $ok == false ]]; then
  echo "النسخ الاحتياطي: $error" >&2
  # 1 = النسخة المحلية فشلت، 2 = المحلية تمام والرفع الخارجي بس اللي فشل
  [[ $local_failed == true ]] && exit 1 || exit 2
fi
echo "تم النسخ الاحتياطي: $BACKUP_DIR${REMOTE:+ وعلى $REMOTE}"
