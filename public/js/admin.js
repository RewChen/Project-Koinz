// ย้ายมาจาก inline script ใน admin.html (Content-Security-Policy: script-src 'self')
let token = sessionStorage.getItem('koinz_admin') || '';
const auth = () => ({ Authorization: 'Bearer ' + token });
const REFRESH_MS = 15000;
const ACTOR = { customer: 'ลูกค้า', admin: 'แอดมิน', webhook: 'webhook', system: 'ระบบ' };
// ป้ายสถานะแบบสั้นสำหรับหลังบ้าน
const ST = {
  pending_payment: 'รอโอน', paid_pending_review: 'รอตรวจยอด', paid: 'ยืนยันยอดแล้ว', processing: 'กำลังเติม',
  completed: 'เติมสำเร็จ', expired: 'หมดเวลา', cancelled: 'ยกเลิก', refund_needed: 'ต้องคืนเงิน', refunded: 'คืนเงินแล้ว',
};
const FILTERS = [['paid_pending_review', 'รอตรวจ'], ['paid', 'ยืนยันยอดแล้ว'], ['processing', 'กำลังเติม'],
  ['refund_needed', 'ต้องคืนเงิน'], ['completed', 'สำเร็จ'], ['', 'ทั้งหมด']];
let stats = {}, gamesBySlug = {}, current = new Map(), openId = null, refreshTimer;
let filter = sessionStorage.getItem('koinz_filter') ?? 'paid_pending_review';

const badge = (s) => `<span class="badge ${esc(s)}">${ST[s] || esc(s)}</span>`;

function showLogin(msg = '') {
  clearInterval(refreshTimer);
  $('#logout').hidden = true;
  $('#tabs').hidden = true;
  $('#modes').innerHTML = '';
  $('#app').innerHTML = `
    <form class="login-card" id="login">
      <h1>เข้าสู่ระบบหลังบ้าน</h1>
      <label for="pw">รหัสผ่าน</label>
      <div class="capsule"><input id="pw" type="password" autocomplete="current-password" required></div>
      <p class="error" id="err" role="alert">${esc(msg)}</p>
      <button class="btn btn-red">เข้าสู่ระบบ</button>
    </form>`;
  $('#pw').focus();
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      ({ token } = await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } }));
      sessionStorage.setItem('koinz_admin', token);
      showDashboard();
    } catch (ex) { $('#err').textContent = ex.message; }
  });
}

function flash(msg, ok = false) {
  const el = $('#flash');
  if (!el) return;
  el.textContent = msg;
  el.className = ok ? 'nick' : 'error';
}

async function guarded(fn) {
  try { return await fn(); }
  catch (e) {
    if (/เข้าสู่ระบบ/.test(e.message)) { sessionStorage.removeItem('koinz_admin'); showLogin(e.message); }
    else flash(e.message);
  }
}

// ---------- แดชบอร์ด ----------
async function showDashboard() {
  $('#logout').hidden = false;
  $('#tabs').hidden = false;
  $('#app').innerHTML = `<section class="tiles" id="tiles" aria-label="สรุป"></section><p id="flash" role="status"></p><section id="tab"></section>`;
  guarded(async () => {
    const games = await api('/api/admin/games', { headers: auth() });
    gamesBySlug = Object.fromEntries(games.map((g) => [g.slug, g]));
  });
  await loadStats(); // ปุ่มลัดขึ้นกับโหมดเติมอัตโนมัติ
  if (!$('#tab')) return;
  showOrders();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.hidden || !$('#tiles')) return;
    loadStats();
    if ($('#rows')) loadOrders();
  }, REFRESH_MS);
}

document.querySelectorAll('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
    flash('');
    b.dataset.tab === 'orders' ? showOrders() : showGames();
  })
);

async function loadStats() {
  await guarded(async () => {
    stats = await api('/api/admin/stats', { headers: auth() });
    const n = stats.byStatus;
    const mode = (label, on) => `<span class="mode ${on ? 'on' : ''}">${label}</span>`;
    $('#modes').innerHTML =
      mode(`ยืนยันยอด: ${stats.webhookEnabled ? 'webhook' : 'ตรวจเอง'}`, stats.webhookEnabled) +
      mode(`เติมเกม: ${stats.autoFulfill ? 'อัตโนมัติ' : 'แอดมินเติม'}`, stats.autoFulfill) +
      mode(`ตรวจชื่อ: ${stats.lookupEnabled ? 'เปิด' : 'ปิด'}`, stats.lookupEnabled);
    const tile = (f, label, value, sub, dot) => `
      <button type="button" class="tile" data-filter="${f}" aria-pressed="${filter === f}" style="--dot: var(${dot})">
        <span class="t-label">${label}</span><b>${value}</b><small>${sub}</small>
      </button>`;
    $('#tiles').innerHTML =
      tile('paid_pending_review', 'รอตรวจยอด', n.paid_pending_review, 'ลูกค้ากดแจ้งโอนแล้ว', '--st-review-fg') +
      tile('processing', 'กำลังเติม', n.processing + n.paid, stats.autoFulfill ? 'ส่งให้ supplier แล้ว' : 'ยืนยันยอดแล้ว รอแอดมินเติม', '--st-proc-fg') +
      tile('refund_needed', 'ต้องคืนเงิน', n.refund_needed, 'เติมไม่สำเร็จ', '--red') +
      tile('completed', 'ยอดขายวันนี้', baht(stats.revenueToday), `สำเร็จทั้งหมด ${n.completed} ออเดอร์`, '--green');
    document.querySelectorAll('.tile').forEach((b) => b.addEventListener('click', () => {
      if (!$('#rows')) document.querySelector('[data-tab="orders"]').click();
      setFilter(b.dataset.filter);
    }));
  });
}

// ---------- ออเดอร์ ----------
function showOrders() {
  $('#tab').innerHTML = `
    <div class="admin-tools">
      <div class="capsule">${ICON.search()}<label for="q" class="sr-only">ค้นหาออเดอร์</label>
        <input id="q" type="search" placeholder="ค้นหาเลขออเดอร์ / UID / LINE / เลขอ้างอิงการโอน"></div>
      <div class="filters" role="group" aria-label="กรองสถานะ">
        ${FILTERS.map(([v, l]) => `<button type="button" class="filter" data-f="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}
      </div>
      <span class="auto">อัปเดตอัตโนมัติทุก 15 วินาที · <span id="count"></span></span>
    </div>
    <div class="admin-main">
      <section class="orders-box" aria-label="รายการออเดอร์">
        <table>
          <thead><tr><th>ออเดอร์</th><th>เกม · แพ็กเกจ</th><th>ผู้เล่น</th><th>LINE ID</th><th class="r">ยอด</th><th>สถานะ</th><th>ทำต่อ</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </section>
      <aside class="detail" id="detail" aria-label="รายละเอียดออเดอร์" hidden></aside>
    </div>`;
  document.querySelectorAll('.filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.f)));
  let debounce;
  $('#q').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(loadOrders, 300); });
  loadOrders();
}

function setFilter(v) {
  filter = v;
  sessionStorage.setItem('koinz_filter', v);
  document.querySelectorAll('.filter').forEach((b) => b.setAttribute('aria-pressed', b.dataset.f === v));
  document.querySelectorAll('.tile').forEach((b) => b.setAttribute('aria-pressed', b.dataset.filter === v));
  loadOrders();
}

// ปุ่มตามสถานะ → [label, action, ประเภท]  ประเภท: primary (แดง) / danger (ต้องกดซ้ำ) / ''
function actionsFor(o) {
  const auto = stats.autoFulfill;
  switch (o.status) {
    case 'pending_payment':
    case 'paid_pending_review':
    case 'expired':
      return [['ยืนยันยอดเข้าแล้ว', 'status:paid', 'primary'], ['ยกเลิก', 'status:cancelled', 'danger']];
    case 'paid':
      return auto ? [] : [['เติมสำเร็จ', 'status:completed', 'primary'], ['เติมไม่สำเร็จ', 'status:refund_needed', 'danger']];
    case 'processing':
      return auto ? [['เติมใหม่', 'retry', 'primary'], ['เติมสำเร็จ', 'status:completed', '']] : [['เติมสำเร็จ', 'status:completed', 'primary']];
    case 'refund_needed':
      return [auto ? ['เติมใหม่', 'retry', 'primary'] : ['เติมสำเร็จแล้ว', 'status:completed', 'primary'], ['คืนเงินแล้ว', 'status:refunded', 'danger']];
    default:
      return [];
  }
}

// ปุ่มในแถว: เฉพาะงานหลักของสถานะนั้น (แดงเฉพาะ "ยืนยันยอดเข้าแล้ว" ของออเดอร์รอตรวจ)
function rowAction(o) {
  if (['pending_payment', 'expired'].includes(o.status)) return '';
  const a = actionsFor(o)[0];
  if (!a) return '';
  const primary = o.status === 'paid_pending_review';
  return `<button type="button" class="act ${primary ? 'primary' : ''}" data-act="${a[1]}" data-id="${esc(o.id)}">${a[0]}</button>`;
}

async function loadOrders() {
  await guarded(async () => {
    const params = new URLSearchParams({ status: filter, q: $('#q').value.trim() });
    const list = await api('/api/admin/orders?' + params, { headers: auth() });
    if (!$('#rows')) return;
    current = new Map(list.map((o) => [o.id, o]));
    $('#count').textContent = `${list.length} รายการ`;
    const searchAll = $('#q').value.trim() && filter ? ' <button type="button" class="act" id="search-all">ค้นหาทุกสถานะ</button>' : '';
    $('#rows').innerHTML = list.length ? list.map((o) => `
      <tr data-row="${esc(o.id)}" class="${o.id === openId ? 'open' : ''}">
        <td><button type="button" class="row-open" data-open="${esc(o.id)}"><b>${esc(o.id)}</b><small>${thaiTime(o.createdAt)}</small></button></td>
        <td>${esc(o.gameName)}<small>${esc(o.packageName)}</small></td>
        <td>${esc(playerText(o))}${o.playerNickname ? `<small class="nick">${esc(o.playerNickname)}</small>` : ''}</td>
        <td>${esc(o.lineId || '–')}</td>
        <td class="r"><b>${baht(o.amount)}</b></td>
        <td>${badge(o.status)}</td>
        <td>${rowAction(o)}</td>
      </tr>`).join('')
      : `<tr><td colspan="7" class="empty" style="text-align:left">ไม่มีออเดอร์ในสถานะนี้${searchAll}</td></tr>`;
    if ($('#search-all')) $('#search-all').addEventListener('click', () => setFilter(''));
    bindActions($('#rows'));
    document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openDetail(b.dataset.open)));
    // แผงรายละเอียด: เลือกแถวแรกให้อัตโนมัติ / อัปเดตเมื่อออเดอร์เปลี่ยน (ถ้าไม่ได้พิมพ์หมายเหตุค้างไว้)
    const note = $('#d-note');
    if (!openId && list.length) openDetail(list[0].id);
    else if (openId && current.has(openId) && current.get(openId).updatedAt !== $('#detail').dataset.updated && !(note && note.value)) {
      openDetail(openId);
    }
  });
}

function bindActions(root) {
  root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => runAction(b)));
}

async function runAction(btn, note = '') {
  // ปุ่มอันตรายต้องกดซ้ำภายใน 4 วินาที
  if (btn.hasAttribute('data-danger') && !btn.dataset.armed) {
    const label = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = `กดอีกครั้งเพื่อ${label}`;
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; }, 4000);
    return;
  }
  const id = btn.dataset.id;
  const [kind, status] = btn.dataset.act.split(':');
  btn.disabled = true;
  await guarded(async () => {
    const url = `/api/admin/orders/${encodeURIComponent(id)}/${kind === 'retry' ? 'retry' : 'status'}`;
    const r = await api(url, { method: 'POST', headers: auth(), body: kind === 'retry' ? { note } : { status, note } });
    flash(r.autoFulfillQueued
      ? `${id}: ${kind === 'retry' ? 'สั่งเติมใหม่แล้ว' : ST[status]} — ระบบกำลังเติมอัตโนมัติ`
      : `${id}: เปลี่ยนเป็น "${ST[status]}" แล้ว`, true);
  });
  btn.disabled = false;
  await Promise.all([loadStats(), loadOrders()]);
  if (openId === id) openDetail(id);
}

async function openDetail(id) {
  openId = id;
  document.querySelectorAll('[data-row]').forEach((tr) => tr.classList.toggle('open', tr.dataset.row === id));
  const box = $('#detail');
  // ออเดอร์อาจหลุดจากตัวกรองหลังเปลี่ยนสถานะ → ดึงด้วยเลขออเดอร์ เพื่อให้แผงยังเปิดอยู่
  const o = current.get(id) || ((await guarded(() =>
    api('/api/admin/orders?q=' + encodeURIComponent(id), { headers: auth() }))) || []).find((x) => x.id === id);
  if (!o || openId !== id || !box) { if (box && openId === id) box.hidden = true; return; }
  const audit = (await guarded(() => api(`/api/admin/orders/${encodeURIComponent(id)}/audit`, { headers: auth() }))) || [];
  if (openId !== id) return;

  const game = gamesBySlug[o.gameSlug];
  const fieldLabel = (name) => ((game && game.fields) || []).find((f) => f.name === name)?.label || name;
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');
  const inputs = Object.entries(o.playerInputs || {});
  const acts = actionsFor(o).map(([label, act, kind]) =>
    `<button type="button" class="act ${kind === 'primary' ? 'primary' : ''}" data-act="${act}" data-id="${esc(o.id)}" ${kind === 'danger' ? 'data-danger' : ''}>${label}</button>`).join('');

  box.dataset.updated = o.updatedAt || '';
  box.hidden = false;
  box.innerHTML = `
    <div class="detail-head">
      <div><small>${thaiTime(o.createdAt)}</small><h2>${esc(o.id)}</h2></div>
      ${badge(o.status)}
    </div>
    <div class="player-box">
      <small>${esc(o.gameName)} · ${esc(o.packageName)}</small>
      <p class="uid-big">${esc(playerText(o))}</p>
      ${o.playerNickname ? `<p class="nick">✓ ชื่อในเกม: ${esc(o.playerNickname)}</p>` : '<p class="nick none">ยังไม่ได้ตรวจชื่อในเกม</p>'}
    </div>
    <dl>
      <dt>ยอด</dt><dd><b>${baht(o.amount)}</b></dd>
      ${inputs.length > 1 ? inputs.map(([k, v]) => row(esc(fieldLabel(k)), v)).join('') : ''}
      <dt>LINE</dt><dd>${esc(o.lineId || '–')}</dd>
      ${row('ติดต่อ', o.contact)}
      <dt>หมายเหตุลูกค้า</dt><dd>${esc(o.customerNote || '–')}</dd>
      <dt>อ้างอิงการโอน</dt><dd>${esc(o.paymentRef || '–')}</dd>
      ${row('อ้างอิง supplier', o.supplierRef)}
      ${row('หมดเวลาชำระ', o.expiresAt && thaiTime(o.expiresAt))}
    </dl>
    <div>
      <label for="d-note" class="sr-only">หมายเหตุของแอดมิน</label>
      <div class="capsule" style="min-height:44px"><input id="d-note" maxlength="200" autocomplete="off" placeholder="หมายเหตุของแอดมิน (บันทึกในประวัติ)"></div>
    </div>
    ${acts ? `<div class="detail-acts">${acts}</div>` : ''}
    <details>
      <summary>เปลี่ยนสถานะเอง</summary>
      <div class="row">
        <label for="d-status" class="sr-only">สถานะใหม่</label>
        <select id="d-status">${Object.entries(ST).filter(([k]) => k !== o.status).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button type="button" class="act" id="d-set">บันทึก</button>
      </div>
    </details>
    <div>
      <h3>ประวัติ</h3>
      <ol class="log">
        ${audit.map((a) => `
          <li><span class="t">${clockTime(a.at)}</span>
            <span class="x">${a.action === 'create' ? 'สร้างออเดอร์' : a.action === 'retry' ? 'สั่งเติมใหม่' : `${a.from ? `${esc(ST[a.from] || a.from)} → ` : ''}${esc(ST[a.to] || a.to || a.action)}`}
              ${a.note ? `<small>${esc(a.note)}</small>` : ''}</span>
            <span class="by">${esc(ACTOR[a.actor] || a.actor)}</span></li>`).join('') || '<li>ยังไม่มีประวัติ</li>'}
      </ol>
    </div>`;
  box.querySelectorAll('.detail-acts [data-act]').forEach((b) => b.addEventListener('click', () => runAction(b, $('#d-note').value)));
  $('#d-set').addEventListener('click', () => {
    const b = $('#d-set');
    b.dataset.id = id;
    b.dataset.act = 'status:' + $('#d-status').value;
    runAction(b, $('#d-note').value);
  });
}

// ---------- เกมและราคา ----------
async function showGames() {
  openId = null;
  $('#tab').innerHTML = `
    <section class="panel">
      <h2>เกมและราคา</h2>
      <p class="muted" style="font-size:13px">แก้เกม ช่องข้อมูลผู้เล่น (fields) แพ็กเกจ และราคาในรูปแบบ JSON แล้วกดบันทึก · ใส่ "active": false เพื่อซ่อนเกมหรือแพ็กเกจ · sku และ cost ลูกค้าไม่เห็น</p>
      <label for="json" class="sr-only">ข้อมูลเกม (JSON)</label>
      <textarea id="json" spellcheck="false"></textarea>
      <p class="error" id="gerr" role="alert"></p>
      <button class="btn btn-red btn-sm" id="save" style="display:inline-flex">บันทึกเกมและราคา</button>
    </section>`;
  await guarded(async () => {
    $('#json').value = JSON.stringify(await api('/api/admin/games', { headers: auth() }), null, 2);
  });
  $('#save').addEventListener('click', () => guarded(async () => {
    const out = $('#gerr');
    out.className = 'error';
    out.textContent = '';
    let data;
    try { data = JSON.parse($('#json').value); } catch { return (out.textContent = 'รูปแบบ JSON ไม่ถูกต้อง ตรวจเครื่องหมายจุลภาคและวงเล็บ'); }
    try {
      await api('/api/admin/games', { method: 'PUT', headers: auth(), body: data });
      gamesBySlug = Object.fromEntries(data.map((g) => [g.slug, g]));
      out.className = 'ok';
      out.textContent = 'บันทึกเกมและราคาแล้ว';
    } catch (e) {
      if (/เข้าสู่ระบบ/.test(e.message)) throw e;
      out.textContent = e.message;
    }
  }));
}

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', headers: auth() }).catch(() => {});
  sessionStorage.removeItem('koinz_admin');
  token = '';
  showLogin();
});
token ? showDashboard() : showLogin();
