// หน้าสมาชิก: login.html / signup.html / forgot.html / reset.html (ลิงก์จากอีเมล + เปลี่ยนรหัสผ่าน)
// โหลดหลัง config.js, common.js, pile.js — ค่าที่มาจากผู้ใช้ทุกตัวผ่าน esc() ก่อนใส่ HTML
(function () {
  const PAGE = document.body.dataset.page;
  const params = new URLSearchParams(location.search);
  const app = $('#app');
  let cfg = {};

  // บน GitHub Pages (API คนละโดเมน) cookie ไปไม่ถึง → ใช้หน้าเดียวกันบนเว็บหลักแทน
  if (memberSite.remote) {
    location.replace(memberSite.url(location.pathname.split('/').pop() + location.search + location.hash));
    return;
  }

  const nextUrl = () => safeNext(params.get('next')) || 'account.html';
  const keepNext = (page) => page + (params.get('next') ? '?next=' + encodeURIComponent(params.get('next')) : '');
  const shop = () => esc(cfg.shopName || 'Koinz');
  const lineUrl = () => (/^https?:\/\//.test(cfg.shopLineUrl || '') ? cfg.shopLineUrl : '');

  // ---------- ส่วนประกอบ ----------
  // back: ปลายทางปุ่มย้อนกลับบนมือถือ (ไม่ใส่ = ไม่มีปุ่ม)
  function topHtml(back) {
    return `
      <header class="auth-top${back ? '' : ' no-back'}">
        ${back ? `<a class="back-round m-only" href="${esc(back.href)}" aria-label="${esc(back.label)}">${ICON.back()}</a>` : ''}
        <a class="logo" href="./"><span data-shop>${shop()}</span></a>
        <nav class="navlinks d-only" aria-label="เมนูหลัก"><a href="./">กลับไปเติมเกม</a></nav>
      </header>`;
  }

  const check = ICON.check(18, 2.4);
  const perksHtml = () => `
    <section class="auth-perks d-only" aria-label="สิทธิ์ของสมาชิก">
      <svg class="pile" id="pile" viewBox="-96 -112 192 212"></svg>
      <h2>เติมครั้งต่อไป<br>ไม่ต้องกรอกอะไรใหม่</h2>
      <ul>
        <li>${check}บันทึก UID ทุกเกมไว้ในบัญชี</li>
        <li>${check}ดูประวัติออเดอร์ได้จากมือถือและคอม</li>
        <li>${check}ไม่สมัครก็สั่งซื้อได้เหมือนเดิม</li>
      </ul>
    </section>`;

  function shell(back, cardHtml) {
    app.innerHTML = topHtml(back) + `<main class="auth-main">${perksHtml()}<section class="auth-card" id="card">${cardHtml}</section></main>`;
    renderPile($('#pile'), 4, null);
    $('#pile').setAttribute('aria-label', `กองเหรียญ ${cfg.shopName || 'Koinz'}`);
  }

  function inputHtml({ id, label, type = 'text', autocomplete, value = '', placeholder = '', describedby = 'err', extra = '' }) {
    const toggle = type === 'password';
    const field = `
      <div class="capsule stacked tall${toggle ? ' has-toggle' : ''}">
        <label class="mini" for="${id}">${esc(label)}</label>
        <input id="${id}" name="${id}" type="${type}" autocomplete="${autocomplete}" value="${esc(value)}"
          ${placeholder ? `placeholder="${esc(placeholder)}"` : ''} aria-describedby="${describedby}" maxlength="${type === 'email' ? 254 : 1024}"
          ${type === 'email' ? 'inputmode="email" autocapitalize="none" spellcheck="false"' : ''} ${extra}>
      </div>`;
    if (!toggle) return field;
    return `<div class="pw-wrap">${field}
        <button type="button" class="pw-toggle" data-for="${id}" aria-label="แสดงรหัสผ่าน" aria-pressed="false">${ICON.eye(false)}</button>
      </div>`;
  }

  // ปุ่มแสดง/ซ่อนรหัส: aria-label บอกสิ่งที่จะเกิดเมื่อกด
  function bindToggles(root = document) {
    root.querySelectorAll('.pw-toggle').forEach((b) => b.addEventListener('click', () => {
      const input = $('#' + b.dataset.for);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.setAttribute('aria-pressed', String(show));
      b.setAttribute('aria-label', show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
      b.innerHTML = ICON.eye(show);
    }));
  }

  // กล่อง error (role="alert" อยู่ในหน้าตั้งแต่แรก screen reader จึงอ่านทันทีที่ใส่ข้อความ)
  const errBox = () => '<div class="alert-box" id="err" role="alert"></div>';
  function showError(msg, field, { html = false } = {}) {
    const box = $('#err');
    if (html) box.innerHTML = msg; else box.textContent = msg;
    document.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
      el.removeAttribute('aria-invalid');
      el.closest('.capsule') && el.closest('.capsule').classList.remove('invalid');
    });
    for (const el of [].concat(field || [])) {
      el.setAttribute('aria-invalid', 'true');
      if (el.closest('.capsule')) el.closest('.capsule').classList.add('invalid');
    }
    const first = [].concat(field || [])[0];
    if (first) first.focus();
  }
  const clearError = () => showError('');
  // แก้ช่องแล้ว error เก่าหายไป (ไม่ค้างข้อความที่ไม่จริงแล้ว)
  const clearOnInput = (form) => form.addEventListener('input', () => { if ($('#err').textContent) clearError(); });

  function busy(btn, text) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
  }
  function idle(btn) {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }

  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  // นับถอยหลังบนปุ่ม (ปุ่มกดไม่ได้จนครบเวลา)
  function countdown(btn, seconds, label, done) {
    clearInterval(btn._timer);
    let left = Math.max(1, Math.ceil(seconds));
    btn.disabled = true;
    const paint = () => (btn.textContent = label(mmss(left)));
    paint();
    btn._timer = setInterval(() => {
      left -= 1;
      if (left > 0) return paint();
      clearInterval(btn._timer);
      btn.disabled = false;
      done();
    }, 1000);
  }

  // ---------- นโยบายรหัสผ่าน (ตรงกับฝั่งเซิร์ฟเวอร์ src/auth/password.js) ----------
  let COMMON = new Set();
  let MIN = 10, MAX = 128;
  const policyLoaded = fetch(apiUrl('/api/password-policy'))
    .then((r) => r.json())
    .then((p) => { COMMON = new Set(p.common); MIN = p.minLength; MAX = p.maxLength; })
    .catch(() => { /* ไม่ได้ก็ไม่เป็นไร เซิร์ฟเวอร์ตรวจซ้ำอีกที */ });

  const LEVELS = ['ยังไม่ได้ตั้งรหัสผ่าน', 'ยังใช้ไม่ได้', 'พอใช้', 'ดี', 'ดีมาก'];
  const POLICY_MSG = {
    tooShort: `รหัสผ่านต้องยาวอย่างน้อย ${MIN} ตัว`,
    tooLong: `รหัสผ่านยาวได้ไม่เกิน ${MAX} ตัว`,
    common: 'รหัสผ่านนี้คนใช้กันบ่อย เดาง่าย ลองตั้งรหัสอื่น',
    hasEmail: 'รหัสผ่านต้องไม่มีชื่ออีเมลอยู่ในรหัส',
  };

  function evaluate(pw, email) {
    const norm = String(pw || '').normalize('NFKC');
    const n = [...norm].length;
    const lower = norm.toLowerCase();
    const local = String(email || '').trim().toLowerCase().split('@')[0].normalize('NFKC');
    const okLen = n >= MIN && n <= MAX;
    const okCommon = n > 0 && !COMMON.has(lower);
    const okEmail = n > 0 && !([...local].length >= 3 && lower.includes(local));
    const valid = okLen && okCommon && okEmail;
    const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(norm)).length;
    let score = n ? 1 : 0;
    if (valid) score = 2 + (variety >= 3 ? 1 : 0) + (n >= 14 ? 1 : 0);
    const problem = !n || n < MIN ? 'tooShort' : n > MAX ? 'tooLong' : !okCommon ? 'common' : !okEmail ? 'hasEmail' : null;
    return { okLen, okCommon, okEmail, valid, score, problem };
  }

  const RULES = [
    ['okLen', `ยาวอย่างน้อย ${MIN} ตัว`],
    ['okCommon', 'ไม่ใช่รหัสที่คนใช้กันบ่อย'],
    ['okEmail', 'ไม่มีชื่ออีเมลอยู่ในรหัส'],
  ];
  function meterHtml(withRules) {
    return `
      <div class="pw-meter" id="pw-meter" data-score="0" aria-live="polite">
        <div class="bars" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <p class="pw-level">ความปลอดภัย: ${LEVELS[0]}</p>
        ${withRules
          ? `<ul class="pw-rules">${RULES.map(([k, t]) => `<li data-rule="${k}"><span class="mark">${ICON.check(12, 3)}</span>${t}<span class="sr-only"> (ยังไม่ผ่าน)</span></li>`).join('')}</ul>`
          : '<p class="pw-hint">ยาว 10 ตัวขึ้นไป · ไม่ใช่รหัสยอดนิยม · ไม่มีชื่ออีเมล</p>'}
      </div>`;
  }
  function paintMeter(r) {
    const m = $('#pw-meter');
    m.dataset.score = String(r.score);
    m.querySelectorAll('.bars span').forEach((s, i) => s.classList.toggle('on', i < r.score));
    const level = `ความปลอดภัย: ${LEVELS[r.score]}`;
    const p = m.querySelector('.pw-level');
    if (p.textContent !== level) p.textContent = level;
    m.querySelectorAll('[data-rule]').forEach((li) => {
      const ok = !!r[li.dataset.rule];
      li.classList.toggle('ok', ok);
      const sr = li.querySelector('.sr-only');
      const text = ok ? ' (ผ่าน)' : ' (ยังไม่ผ่าน)';
      if (sr.textContent !== text) sr.textContent = text;
    });
  }

  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  // =====================================================================
  // เข้าสู่ระบบ / สมัครสมาชิก (คอม: แท็บสลับได้โดยไม่โหลดใหม่)
  // =====================================================================
  function authTabs(mode) {
    const tab = (m, label) => `<button type="button" role="tab" class="auth-tab" id="tab-${m}" data-mode="${m}"
        aria-selected="${m === mode}" aria-controls="panel" tabindex="${m === mode ? 0 : -1}">${label}</button>`;
    return `<div class="auth-tabs d-only" role="tablist" aria-label="เลือกวิธี">${tab('login', 'เข้าสู่ระบบ')}${tab('signup', 'สมัครสมาชิก')}</div>`;
  }

  function loginPanel(email) {
    const forgot = cfg.passwordResetEnabled
      ? `<a href="${esc(keepNext('forgot.html'))}">ลืมรหัสผ่าน?</a>`
      : lineUrl()
        ? `<a href="${esc(lineUrl())}" target="_blank" rel="noopener">ลืมรหัสผ่าน? ติดต่อร้านทาง LINE</a>`
        : '<span>ลืมรหัสผ่าน? ติดต่อร้านทาง LINE</span>';
    return `
      <div class="auth-head tabbed">
        <h1>เข้าสู่ระบบ</h1>
        <p>ดูออเดอร์และ UID ที่บันทึกไว้ได้จากทุกเครื่อง</p>
      </div>
      <form id="form" novalidate>
        ${errBox()}
        ${inputHtml({ id: 'email', label: 'อีเมล', type: 'email', autocomplete: 'email', value: email })}
        ${inputHtml({ id: 'password', label: 'รหัสผ่าน', type: 'password', autocomplete: 'current-password' })}
        <div class="right-link">${forgot}</div>
        <button class="btn btn-red btn-lg" type="submit" id="go">เข้าสู่ระบบ</button>
      </form>
      <div class="auth-foot">
        <p class="m-only">ยังไม่มีบัญชี? <a class="strong-link" href="${esc(keepNext('signup.html'))}">สมัครสมาชิก</a></p>
        <a class="quiet-link" href="./">สั่งซื้อโดยไม่ต้องสมัครก็ได้</a>
      </div>`;
  }

  function signupPanel(email) {
    return `
      <div class="auth-head tabbed">
        <h1>สมัครสมาชิก</h1>
        <ul class="auth-perks-m">
          <li>${ICON.check(16, 2.4)}ดูประวัติออเดอร์ได้จากทุกเครื่อง</li>
          <li>${ICON.check(16, 2.4)}บันทึก UID ทุกเกม ไม่ต้องพิมพ์ใหม่</li>
        </ul>
      </div>
      <form id="form" novalidate>
        ${errBox()}
        ${inputHtml({ id: 'email', label: 'อีเมล', type: 'email', autocomplete: 'email', value: email, placeholder: 'you@example.com' })}
        ${inputHtml({ id: 'password', label: 'ตั้งรหัสผ่าน', type: 'password', autocomplete: 'new-password', placeholder: `อย่างน้อย ${MIN} ตัว`, describedby: 'pw-meter err' })}
        ${meterHtml(true)}
        <label class="check-row">
          <input type="checkbox" id="terms" required aria-describedby="err">
          <span>ยอมรับ<a href="terms.html" target="_blank" rel="noopener">เงื่อนไขการใช้งาน</a>และ<a href="privacy.html" target="_blank" rel="noopener">นโยบายความเป็นส่วนตัว</a> (จำเป็น)</span>
        </label>
        <label class="check-row soft">
          <input type="checkbox" id="marketing">
          <span>รับข่าวโปรโมชันทางอีเมล (ไม่บังคับ)</span>
        </label>
        <button class="btn btn-red btn-lg push" type="submit" id="go" aria-disabled="true">สมัครสมาชิก</button>
      </form>
      <div class="auth-foot">
        <p class="m-only">มีบัญชีแล้ว? <a class="strong-link" href="${esc(keepNext('login.html'))}">เข้าสู่ระบบ</a></p>
        <a class="quiet-link d-only" href="./">สั่งซื้อโดยไม่ต้องสมัครก็ได้</a>
      </div>`;
  }

  function renderAuth(mode, focusTab) {
    const email = $('#email') ? $('#email').value : '';
    $('#card').innerHTML = authTabs(mode) +
      `<div class="auth-panel" id="panel" role="tabpanel" aria-labelledby="tab-${mode}">${mode === 'login' ? loginPanel(email) : signupPanel(email)}</div>`;
    document.title = `${mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'} — ${cfg.shopName || 'Koinz'}`;
    bindToggles($('#card'));
    document.querySelectorAll('.auth-tab').forEach((b) => {
      b.addEventListener('click', () => switchMode(b.dataset.mode));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        switchMode(b.dataset.mode === 'login' ? 'signup' : 'login');
      });
    });
    if (focusTab) $('#tab-' + mode).focus();
    if (mode === 'login') bindLogin(); else bindSignup();
  }

  function switchMode(mode) {
    if (($('#tab-' + mode) || {}).getAttribute('aria-selected') === 'true') return;
    history.replaceState(null, '', `${mode}.html${location.search}`);
    renderAuth(mode, true);
  }

  function bindLogin() {
    const form = $('#form'), go = $('#go');
    clearOnInput(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      const email = $('#email'), pw = $('#password');
      if (!email.value.trim()) return showError('กรอกอีเมล', email);
      if (!pw.value) return showError('กรอกรหัสผ่าน', pw);
      clearError();
      busy(go, 'กำลังเข้าสู่ระบบ…');
      try {
        await api('/api/auth/login', { method: 'POST', body: { email: email.value.trim(), password: pw.value } });
        location.replace(nextUrl());
      } catch (ex) {
        idle(go);
        pw.value = '';
        showError(ex.message, ex.status === 401 ? [pw, email] : pw);
        if (ex.status === 423 || ex.status === 429) {
          const wait = (ex.data && ex.data.retryAfter) || 60;
          countdown(go, wait, (t) => `ลองใหม่ได้ใน ${t}`, () => (go.textContent = 'เข้าสู่ระบบ'));
        }
      }
    });
  }

  function bindSignup() {
    const form = $('#form'), go = $('#go');
    clearOnInput(form);
    const email = $('#email'), pw = $('#password'), terms = $('#terms');
    const update = () => {
      const r = evaluate(pw.value, email.value);
      paintMeter(r);
      go.setAttribute('aria-disabled', String(!(r.valid && terms.checked && validEmail(email.value.trim()))));
      return r;
    };
    [email, pw].forEach((el) => el.addEventListener('input', update));
    terms.addEventListener('change', update);
    policyLoaded.then(update);
    update();
    // ปุ่มยังกดได้ด้วยคีย์บอร์ด/โปรแกรมอ่านจอ → บอกว่ายังขาดอะไร แทนการเงียบ
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      const r = update();
      if (!validEmail(email.value.trim())) return showError('กรอกอีเมลให้ถูกต้อง เช่น you@example.com', email);
      if (!r.valid) return showError(POLICY_MSG[r.problem], pw);
      if (!terms.checked) return showError('ต้องยอมรับเงื่อนไขการใช้งานและนโยบายความเป็นส่วนตัวก่อนสมัคร', terms);
      clearError();
      busy(go, 'กำลังสมัคร…');
      try {
        await api('/api/auth/signup', {
          method: 'POST',
          body: { email: email.value.trim(), password: pw.value, acceptTerms: true, marketing: $('#marketing').checked },
        });
        location.replace(nextUrl());
      } catch (ex) {
        idle(go);
        showError(ex.message, /รหัสผ่าน/.test(ex.message) ? pw : email);
      }
    });
  }

  // =====================================================================
  // ลืมรหัสผ่าน → ตรวจอีเมลของคุณ
  // =====================================================================
  function renderForgot() {
    if (!cfg.passwordResetEnabled) {
      shell({ href: keepNext('login.html'), label: 'กลับไปหน้าเข้าสู่ระบบ' }, `
        <div class="auth-head">
          <h1>ลืมรหัสผ่าน</h1>
          <p>ระบบลืมรหัสผ่านยังไม่เปิดใช้งาน ติดต่อร้านทาง LINE เพื่อขอความช่วยเหลือ</p>
        </div>
        <div class="auth-body notice-wrap">
          ${lineUrl() ? `<a class="btn btn-red btn-lg" href="${esc(lineUrl())}" target="_blank" rel="noopener">ติดต่อร้านทาง LINE</a>` : ''}
        </div>
        <div class="auth-foot"><a class="back-to-login" href="${esc(keepNext('login.html'))}">กลับไปเข้าสู่ระบบ</a></div>`);
      return;
    }
    shell({ href: keepNext('login.html'), label: 'กลับไปหน้าเข้าสู่ระบบ' }, `
      <div class="auth-head">
        <h1>ลืมรหัสผ่าน</h1>
        <p>กรอกอีเมลที่ใช้สมัคร เราจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ไปให้ ลิงก์ใช้ได้ 30 นาที</p>
      </div>
      <form id="form" novalidate>
        ${errBox()}
        ${inputHtml({ id: 'email', label: 'อีเมล', type: 'email', autocomplete: 'email', value: params.get('email') || '' })}
        <button class="btn btn-red btn-lg" type="submit" id="go">ส่งลิงก์ตั้งรหัสผ่านใหม่</button>
      </form>
      <div class="auth-foot"><a class="back-to-login" href="${esc(keepNext('login.html'))}">กลับไปเข้าสู่ระบบ</a></div>`);
    const go = $('#go');
    clearOnInput($('#form'));
    $('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#email');
      const v = email.value.trim();
      if (!validEmail(v)) return showError('กรอกอีเมลให้ถูกต้อง เช่น you@example.com', email);
      busy(go, 'กำลังส่ง…');
      try {
        await api('/api/auth/forgot', { method: 'POST', body: { email: v } });
        renderSent(v);
      } catch (ex) {
        idle(go);
        showError(ex.message, email);
      }
    });
  }

  function renderSent(email) {
    $('#card').innerHTML = `
      <section class="notice-hero">
        <div class="icon-circle">${ICON.mail()}</div>
        <h1 id="sent-title" tabindex="-1">ตรวจอีเมลของคุณ</h1>
        <p>ถ้า <b>${esc(email)}</b> มีบัญชีกับ ${shop()} เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว ลิงก์ใช้ได้ 30 นาที และใช้ได้ครั้งเดียว</p>
      </section>
      <div class="tip-box">ไม่เจออีเมล? ดูในโฟลเดอร์จดหมายขยะ หรือรอ 1–2 นาที</div>
      <div class="notice-acts">
        <button type="button" class="btn btn-wait" id="resend">ส่งอีกครั้ง</button>
        ${errBox()}
      </div>
      <div class="auth-foot"><a class="back-to-login" href="${esc(keepNext('login.html'))}">กลับไปเข้าสู่ระบบ</a></div>`;
    $('#sent-title').focus(); // ย้ายโฟกัสมาที่หัวข้อ → screen reader อ่านว่าส่งแล้ว
    const resend = $('#resend');
    const wait = () => countdown(resend, 60, (t) => `ส่งอีกครั้งได้ใน ${t}`, () => (resend.textContent = 'ส่งอีกครั้ง'));
    wait();
    resend.addEventListener('click', async () => {
      busy(resend, 'กำลังส่ง…');
      try {
        await api('/api/auth/forgot', { method: 'POST', body: { email } });
        clearError();
        wait();
      } catch (ex) {
        idle(resend);
        showError(ex.message);
      }
    });
  }

  // =====================================================================
  // ตั้งรหัสผ่านใหม่ (ลิงก์ reset.html#token=…) / เปลี่ยนรหัสผ่าน (reset.html?mode=change)
  // =====================================================================
  function renderExpired() {
    shell(null, `
      <section class="notice-hero" role="alert">
        <div class="icon-circle grey">${ICON.stopwatch}</div>
        <h1>ลิงก์นี้ใช้ไม่ได้แล้ว</h1>
        <p>ลิงก์หมดอายุ (เกิน 30 นาที) หรือถูกใช้ไปแล้ว ขอลิงก์ใหม่ได้เลย</p>
      </section>
      <a class="btn btn-red btn-lg push" href="forgot.html">ขอลิงก์ใหม่</a>`);
  }

  // แบบฟอร์มรหัสใหม่ใช้ร่วมกัน 2 โหมด
  function passwordForm({ title, email, current, logoutOption }) {
    return `
      <div class="auth-head">
        <h1>${title}</h1>
        <p>สำหรับบัญชี <b>${esc(email)}</b></p>
      </div>
      <form id="form" novalidate>
        ${errBox()}
        <input class="sr-only" type="email" autocomplete="username" value="${esc(email)}" tabindex="-1" aria-hidden="true" readonly>
        ${current ? inputHtml({ id: 'current', label: 'รหัสผ่านปัจจุบัน', type: 'password', autocomplete: 'current-password' }) : ''}
        ${inputHtml({ id: 'password', label: 'รหัสผ่านใหม่', type: 'password', autocomplete: 'new-password', describedby: 'pw-meter err' })}
        ${meterHtml(false)}
        ${logoutOption
          ? `<label class="check-row">
               <input type="checkbox" id="logout-others" checked>
               <span>ออกจากระบบในอุปกรณ์อื่นทั้งหมด<small>แนะนำ ถ้าสงสัยว่ามีคนอื่นรู้รหัสเดิม</small></span>
             </label>`
          : '<p class="pw-hint">อุปกรณ์อื่นที่เข้าสู่ระบบไว้จะออกจากระบบทันที</p>'}
        <button class="btn btn-red btn-lg push" type="submit" id="go">บันทึกรหัสผ่านใหม่</button>
      </form>`;
  }

  function bindPasswordForm(email, submit) {
    bindToggles($('#card'));
    const pw = $('#password'), go = $('#go');
    clearOnInput($('#form'));
    const update = () => { const r = evaluate(pw.value, email); paintMeter(r); return r; };
    pw.addEventListener('input', update);
    policyLoaded.then(update);
    $('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      const cur = $('#current');
      if (cur && !cur.value) return showError('กรอกรหัสผ่านปัจจุบัน', cur);
      const r = update();
      if (!r.valid) return showError(POLICY_MSG[r.problem], pw);
      clearError();
      busy(go, 'กำลังบันทึก…');
      try {
        await submit(pw.value);
      } catch (ex) {
        idle(go);
        if (ex.data && ex.data.resetInvalid) return renderExpired();
        showError(ex.message, cur && /ปัจจุบัน/.test(ex.message) ? cur : pw);
      }
    });
  }

  async function renderReset(member) {
    if (params.get('mode') === 'change') {
      if (!member) return location.replace(`login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
      document.title = `เปลี่ยนรหัสผ่าน — ${cfg.shopName || 'Koinz'}`;
      shell({ href: 'account.html', label: 'กลับไปบัญชีของฉัน' }, passwordForm({ title: 'เปลี่ยนรหัสผ่าน', email: member.email, current: true }));
      bindPasswordForm(member.email, async (newPassword) => {
        await api('/api/me/password', { method: 'POST', body: { currentPassword: $('#current').value, newPassword } });
        location.replace('account.html#password-changed');
      });
      return;
    }

    // token อยู่หลัง # → ไม่ถูกส่งไปกับ request และลบออกจากแถบที่อยู่ทันที
    const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    let info = null;
    if (token) info = await api('/api/auth/reset/verify', { method: 'POST', body: { token } }).catch(() => null);
    if (!info || !info.valid) return renderExpired();
    shell(null, passwordForm({ title: 'ตั้งรหัสผ่านใหม่', email: info.email, logoutOption: true }));
    bindPasswordForm(info.email, async (password) => {
      await api('/api/auth/reset', {
        method: 'POST',
        body: { token, password, logoutOthers: $('#logout-others').checked },
      });
      location.replace('account.html#password-changed');
    });
  }

  // ---------- เริ่ม ----------
  Promise.all([shopConfig, memberStatus()]).then(([c, member]) => {
    cfg = c || {};
    if ((PAGE === 'login' || PAGE === 'signup') && member) return location.replace(nextUrl());
    if (PAGE === 'login' || PAGE === 'signup') {
      shell({ href: PAGE === 'login' ? './' : keepNext('login.html'), label: PAGE === 'login' ? 'กลับหน้าร้าน' : 'กลับไปหน้าเข้าสู่ระบบ' }, '');
      renderAuth(PAGE, false);
    } else if (PAGE === 'forgot') {
      renderForgot();
    } else if (PAGE === 'reset') {
      renderReset(member);
    }
  });
})();
