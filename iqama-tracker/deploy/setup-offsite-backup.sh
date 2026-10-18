#!/usr/bin/env bash
# ==========================================================================
# ضبط النسخ الاحتياطي خارج السيرفر (مرة واحدة):
#
#   sudo bash /opt/iqama/app/iqama-tracker/deploy/setup-offsite-backup.sh
#
# بيربط السيرفر بحساب تخزين (Google Drive أو OneDrive أو Dropbox أو S3 أو سيرفر تاني)
# عن طريق rclone، وبعدها النسخة اليومية بتترفع عليه تلقائيًا. لو السيرفر وقع أو اتمسح،
# البيانات موجودة بره. آمن للتشغيل أكثر من مرة (لتغيير الحساب أو المدة).
# ==========================================================================
set -euo pipefail

APP_DIR=/opt/iqama/app/iqama-tracker
CONF_DIR=/etc/iqama
export RCLONE_CONFIG=$CONF_DIR/rclone.conf

green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
red() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ask() { local __var=$1 __prompt=$2 __default=${3:-} __reply; read -r -p "$__prompt" __reply </dev/tty; printf -v "$__var" '%s' "${__reply:-$__default}"; }

[[ $EUID -eq 0 ]] || { red "شغّلي السكربت بصلاحيات root (استخدمي sudo)"; exit 1; }
mkdir -p $CONF_DIR
chmod 700 $CONF_DIR

step "تثبيت rclone"
if command -v rclone >/dev/null; then
  echo "موجود: $(rclone version | head -1)"
else
  apt-get install -y -qq unzip curl >/dev/null
  curl -fsSL https://rclone.org/install.sh | bash >/dev/null || apt-get install -y -qq rclone >/dev/null
  echo "تم: $(rclone version | head -1)"
fi

step "ربط حساب التخزين"
cat <<'TXT'
هيفتح معالج rclone. لـ Google Drive:
  1) n  (حساب جديد)          ← الاسم: offsite
  2) النوع: اكتبي  drive     ← client_id و client_secret: Enter فاضي
  3) scope: اختاري 1 (Full access)، وباقي الأسئلة Enter
  4) "Use web browser to automatically authenticate?" ← n
     هيظهر أمر يبدأ بـ  rclone authorize "drive" ...
     شغّليه على جهازك اللي فيه متصفح (بعد تثبيت rclone عليه من rclone.org/downloads)،
     سجّلي دخول بحساب Google، وانسخي الكود اللي يطلع والصقيه هنا.
  5) "Configure this as a Shared Drive?" ← n ،  وبعدين y للحفظ ، و q للخروج.

بدائل بنفس الطريقة: onedrive ، dropbox ، s3 (Backblaze / Wasabi / AWS) ، sftp (سيرفر تاني).
TXT
ask START "اضغطي Enter للبدء... "
rclone config </dev/tty

REMOTES=$(rclone listremotes | tr -d ':')
[[ -n $REMOTES ]] || { red "مفيش حساب متربط. شغّلي السكربت تاني وكمّلي خطوات الربط."; exit 1; }
DEFAULT=$(echo "$REMOTES" | grep -x offsite || echo "$REMOTES" | head -1)

step "إعدادات النسخ"
ask NAME "اسم الحساب اللي ربطتيه [$DEFAULT]: " "$DEFAULT"
echo "$REMOTES" | grep -qx -- "$NAME" || { red "الحساب \"$NAME\" مش موجود. الموجود: $(echo $REMOTES)"; exit 1; }
ask FOLDER "اسم المجلد على التخزين [iqama-backups]: " iqama-backups
[[ $FOLDER =~ ^[A-Za-z0-9._/-]+$ ]] || { red "اسم المجلد بالإنجليزي وأرقام بس (بدون مسافات)"; exit 1; }
ask KEEP "النسخ تفضل على التخزين كام يوم؟ [60]: " 60
[[ $KEEP =~ ^[0-9]+$ && $KEEP -ge 7 ]] || { red "المدة رقم 7 أيام أو أكتر"; exit 1; }
REMOTE="$NAME:$FOLDER"

rclone mkdir "$REMOTE"
umask 077
cat > $CONF_DIR/backup.conf <<CONF
# إعدادات النسخ الاحتياطي (يقرأها deploy/backup.sh). للتعديل: شغّلي setup-offsite-backup.sh تاني
REMOTE="$REMOTE"
REMOTE_KEEP_DAYS=$KEEP
KEEP_DAYS=14
CONF
umask 022
chmod 600 $CONF_DIR/backup.conf "$RCLONE_CONFIG"

step "تجربة النسخ والرفع دلوقتي"
if bash "$APP_DIR/deploy/backup.sh"; then
  green "تمام: النسخة اليومية هتترفع على $REMOTE وتفضل $KEEP يوم"
  echo "الملفات على التخزين:"
  rclone lsl "$REMOTE" | sort -k2 | tail -n 4
else
  red "التجربة فشلت. راجعي الرسالة اللي فوق، وشغّلي السكربت تاني."
  exit 1
fi
