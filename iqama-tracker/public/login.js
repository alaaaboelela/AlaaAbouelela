const $ = (id) => document.getElementById(id);
const form = $('loginForm');
const submit = $('submit');

$('year').textContent = new Date().getFullYear();

// ---------- الوضع الليلي ----------

function syncThemeIcon() {
  $('themeIcon').setAttribute('href', `icons.svg#i-${Theme.isDark() ? 'sun' : 'moon'}`);
}
$('themeBtn').addEventListener('click', () => Theme.toggle());
document.addEventListener('themechange', syncThemeIcon);
syncThemeIcon();

// ---------- إظهار كلمة المرور و Caps Lock ----------

$('reveal').addEventListener('click', () => {
  const input = $('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('revealIcon').setAttribute('href', `icons.svg#i-${show ? 'eye-off' : 'eye'}`);
  $('reveal').setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
  input.focus();
});

for (const type of ['keydown', 'keyup']) {
  $('password').addEventListener(type, (e) => {
    if (e.getModifierState) $('caps').hidden = !e.getModifierState('CapsLock');
  });
}

// ---------- تسجيل الدخول ----------

// التحقق بخطوتين: بعد كلمة المرور الصحيحة الخادم يرجّع تذكرة مؤقتة ونطلب رمز التطبيق
let ticket = null;

function setLoading(loading) {
  submit.disabled = loading;
  submit.innerHTML = loading ? '<span class="spinner"></span>' : `<span>${ticket ? 'تأكيد' : 'تسجيل الدخول'}</span>`;
}

function showOtpStep(on) {
  ticket = on ? ticket : null;
  for (const el of document.querySelectorAll('.cred')) el.hidden = on;
  $('otpStep').hidden = !on;
  $('caps').hidden = true;
  $('loginTitle').textContent = on ? 'التحقق بخطوتين 🔐' : 'مرحبًا بعودتك 👋';
  $('loginLead').textContent = on ? 'خطوة أمان إضافية لحسابك' : 'سجّل الدخول للوصول إلى لوحة متابعة الإقامات';
  $('otp').value = '';
  setLoading(false);
  (on ? $('otp') : $('password')).focus();
}

$('otpBack').addEventListener('click', () => {
  $('error').hidden = true;
  showOtpStep(false);
});

function done(home = '/') {
  submit.classList.add('success');
  submit.innerHTML = '<svg class="icon"><use href="icons.svg#i-check-plain"/></svg><span>تم تسجيل الدخول</span>';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => $('page').classList.add('leaving'), reduce ? 0 : 450);
  setTimeout(() => location.replace(home), reduce ? 50 : 900);
}

async function submitOtp() {
  const code = $('otp').value.trim();
  if (!code) return showError('اكتب رمز التحقق');
  setLoading(true);
  try {
    const res = await fetch('/api/login/2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.expired) showOtpStep(false);
      else setLoading(false);
      showError(body.error || 'تعذر التحقق');
      $('otp').select();
      return;
    }
    done(body.home);
  } catch {
    setLoading(false);
    showError('تعذر الاتصال بالخادم، حاول مرة أخرى');
  }
}

function showError(message) {
  $('errorText').textContent = message;
  $('error').hidden = false;
  form.classList.remove('shake');
  void form.offsetWidth; // إعادة تشغيل الحركة
  form.classList.add('shake');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').hidden = true;
  if (ticket) {
    await submitOtp();
    return;
  }
  const data = Object.fromEntries(new FormData(form));
  delete data.otp;
  if (!data.username.trim() || !data.password) {
    showError('من فضلك أدخل اسم المستخدم وكلمة المرور');
    return;
  }

  setLoading(true);
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      setLoading(false);
      showError((await res.json().catch(() => ({}))).error || 'تعذر تسجيل الدخول');
      $('password').select();
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (body.twoFactor) {
      ticket = body.ticket;
      showOtpStep(true);
      return;
    }
    done(body.home);
  } catch {
    setLoading(false);
    showError('تعذر الاتصال بالخادم، حاول مرة أخرى');
  }
});
