// หน้าบัญชีของฉัน (account.html) — โหลดหลัง config.js, common.js
(function () {
  const app = $('#app');
  let cfg = {}, me = null, orders = [], players = [], games = new Map();

  if (memberSite.remote) {
    location.replace(memberSite.url('account.html'));
    return;
  }

  // ออเดอร์ในเครื่องที่ลองผูกแล้วไม่สำเร็จ (เช่น เป็นของบัญชีอื่น) — ไม่ต้องถามซ้ำ
  const skip = {
    list() { try { return JSON.parse(localStorage.getItem('koinz_claim_skip') || '[]'); } catch { return []; } },
    add(ids) {
      try { localStorage.setItem('koinz_claim_skip', JSON.stringify([...new Set([...this.list(), ...ids])].slice(-100))); } catch { /* ignore */ }
    },
  };
  const localToken = (id) => (myOrders.list().find((o) => o.id === id) || {}).token;
  const claimable = () => {
    const owned = new Set(orders.map((o) => o.id));
    const skipped = new Set(skip.list());
    return myOrders.list().filter((o) => o.id && o.token && !owned.has(o.id) && !skipped.has(o.id));
  };
  const orderHref = (o) => {
    const t = localToken(o.id);
    return `order.html?id=${encodeURIComponent(o.id)}${t ? `&t=${encodeURIComponent(t)}` : ''}`;
  };
  const fullDate = (iso) => new Date(iso).toLocaleDateString('th-TH-u-ca-gregory', { day: 'numeric', month: 'short', year: 'numeric' });

  // ---------- วาดหน้า ----------
  function headerHtml() {
    return `
      <header class="top">
        <a class="logo" href="./"><span data-shop>${esc(cfg.shopName || 'Koinz')}</span></a>
        <nav class="navlinks" aria-label="เมนูหลัก">
          <a class="first" href="./"><span class="m-only">เติมเกม</span><span class="d-only">เกมทั้งหมด</span></a>
          <a class="desk" href="account.html" aria-current="page">บัญชีของฉัน</a>
        </nav>
      </header>`;
  }

  function claimHtml() {
    const list = claimable();
    if (!list.length) return '';
    return `
      <div class="claim-bar">
        <p>พบ ${list.length} ออเดอร์ที่สั่งจากเครื่องนี้ก่อนเข้าสู่ระบบ</p>
        <button type="button" class="btn-info" id="claim">เพิ่มเข้าบัญชี</button>
      </div>`;
  }

  function playersHtml() {
    if (!players.length) return '<p class="empty">ยังไม่มี UID ที่บันทึกไว้ สั่งซื้อตอนเข้าสู่ระบบแล้วร้านจะจำให้เอง</p>';
    return `<div class="players">${players.map((p) => {
      const g = games.get(p.gameSlug) || { name: p.gameSlug, initial: '?', color: '' };
      const uid = playerText({ playerInputs: p.inputs, playerLabel: p.label });
      return `
        <div class="player">
          <span class="ini" style="--c:${esc(g.color)}" aria-hidden="true">${esc(g.initial)}</span>
          <span class="p-text"><small>${esc(g.name)}</small><b>${esc(uid)}</b></span>
          <a class="btn-fill" href="./?game=${encodeURIComponent(p.gameSlug)}" aria-label="เติม ${esc(g.name)} ให้ ${esc(uid)}">เติม</a>
          <button type="button" class="icon-btn" data-del="${esc(p.gameSlug)}" aria-label="ลบ UID ${esc(g.name)} ที่บันทึกไว้">${ICON.close}</button>
        </div>`;
    }).join('')}</div>`;
  }

  function ordersHtml() {
    if (!orders.length) return '<p class="empty">ยังไม่มีออเดอร์ในบัญชีนี้</p>';
    const badge = (o) => `<span class="badge ${esc(o.status)}">${esc(STATUS[o.status] || o.status)}</span>`;
    const title = (o) => `${esc(o.gameName)} · ${esc(o.packageName)}`;
    return `
      <div class="orders-m m-only">${orders.map((o) => `
        <a href="${orderHref(o)}">
          <span class="o-text">${title(o)}<small>${esc(thaiTime(o.createdAt))} · ${baht(o.amount)}</small></span>${badge(o)}
        </a>`).join('')}
      </div>
      <div class="orders-d d-only">
        <table>
          <thead><tr><th scope="col">รายการ</th><th scope="col">ผู้เล่น</th><th scope="col" class="r">ยอด</th><th scope="col">สถานะ</th></tr></thead>
          <tbody>${orders.map((o) => `
            <tr>
              <td><a href="${orderHref(o)}">${title(o)}</a><small>${esc(thaiTime(o.createdAt))}</small></td>
              <td>${esc(playerText(o))}</td>
              <td class="r"><b>${baht(o.amount)}</b></td>
              <td>${badge(o)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function render() {
    const changed = location.hash === '#password-changed';
    if (changed) history.replaceState(null, '', location.pathname + location.search);
    document.title = `บัญชีของฉัน — ${cfg.shopName || 'Koinz'}`;
    app.innerHTML = headerHtml() + `
      <div class="acct-head">
        <p>${esc(me.email)}</p>
        <h1>บัญชีของฉัน</h1>
      </div>
      <main class="acct-main">
        <div class="acct-left">
          ${changed ? '<p class="ok-note" role="status">เปลี่ยนรหัสผ่านเรียบร้อยแล้ว</p>' : ''}
          <div id="claim-slot">${claimHtml()}</div>
          <p class="sr-only" id="live" role="status"></p>
          <section aria-labelledby="players-title">
            <h2 id="players-title" tabindex="-1">ผู้เล่นที่บันทึกไว้</h2>
            <div id="players-slot">${playersHtml()}</div>
          </section>
          <section aria-labelledby="orders-title">
            <h2 id="orders-title" tabindex="-1">ออเดอร์ล่าสุด</h2>
            <div id="orders-slot">${ordersHtml()}</div>
          </section>
        </div>
        <aside class="acct-side" aria-label="ความปลอดภัยของบัญชี">
          <h2>ความปลอดภัย</h2>
          <p class="since">สมาชิกตั้งแต่ ${esc(fullDate(me.createdAt))} · ใช้งานอยู่ ${Number(me.sessionCount) || 1} อุปกรณ์</p>
          <a class="menu-row" href="reset.html?mode=change">เปลี่ยนรหัสผ่าน<span class="chev-r">${ICON.next}</span></a>
          <button type="button" class="menu-row" id="logout-all">ออกจากระบบทุกอุปกรณ์<span class="chev-r">${ICON.next}</span></button>
          <button type="button" class="menu-row danger" id="logout">ออกจากระบบ</button>
          <button type="button" class="small-link" id="open-delete">ลบบัญชี</button>
          <p class="error" id="side-err" role="alert"></p>
        </aside>
      </main>
      ${deleteDialogHtml()}`;
    bind();
  }

  function deleteDialogHtml() {
    return `
      <dialog class="sheet" id="delete" aria-labelledby="del-title" aria-describedby="del-lead">
        <form id="del-form" novalidate>
          <h2 id="del-title">ลบบัญชี ${esc(cfg.shopName || 'Koinz')}?</h2>
          <p class="lead" id="del-lead">ลบแล้วกู้คืนไม่ได้</p>
          <ul>
            <li>ลบอีเมล รหัสผ่าน และ UID ที่บันทึกไว้ทั้งหมด</li>
            <li>ออกจากระบบทุกอุปกรณ์ทันที</li>
            <li>ออเดอร์เก่ายังเก็บไว้ตามกฎหมายบัญชี แต่ไม่ผูกกับคุณแล้ว</li>
          </ul>
          <input class="sr-only" type="email" autocomplete="username" value="${esc(me.email)}" tabindex="-1" aria-hidden="true" readonly>
          <div class="pw-wrap">
            <div class="capsule stacked tall has-toggle">
              <label class="mini" for="del-pw">ยืนยันด้วยรหัสผ่าน</label>
              <input id="del-pw" type="password" autocomplete="current-password" maxlength="1024" aria-describedby="del-err">
            </div>
            <button type="button" class="pw-toggle" data-for="del-pw" aria-label="แสดงรหัสผ่าน" aria-pressed="false">${ICON.eye(false)}</button>
          </div>
          <div class="alert-box" id="del-err" role="alert"></div>
          <div class="sheet-acts">
            <button type="button" class="btn" id="del-cancel">ยกเลิก</button>
            <button type="submit" class="btn btn-danger" id="del-go">ลบบัญชีถาวร</button>
          </div>
        </form>
      </dialog>`;
  }

  // ---------- การกด ----------
  function bind() {
    const claim = $('#claim');
    if (claim) claim.addEventListener('click', doClaim);
    bindPlayers();

    $('#logout-all').addEventListener('click', () => post('#logout-all', '/api/auth/logout-all', 'login.html'));
    $('#logout').addEventListener('click', () => post('#logout', '/api/auth/logout', './'));

    // หน้าต่างลบบัญชี: <dialog>.showModal() กันโฟกัสออกนอกหน้าต่าง + Esc ปิดได้ในตัว
    const dlg = $('#delete'), opener = $('#open-delete'), pw = $('#del-pw');
    opener.addEventListener('click', () => {
      $('#del-err').textContent = '';
      dlg.showModal();
      pw.focus();
    });
    $('#del-cancel').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => {
      pw.value = '';
      opener.focus(); // ปิดแล้วโฟกัสกลับไปที่ลิงก์ "ลบบัญชี"
    });
    dlg.querySelectorAll('.pw-toggle').forEach((b) => b.addEventListener('click', () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      b.setAttribute('aria-pressed', String(show));
      b.setAttribute('aria-label', show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
      b.innerHTML = ICON.eye(show);
    }));
    $('#del-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#del-err'), go = $('#del-go');
      if (!pw.value) {
        err.textContent = 'กรอกรหัสผ่านเพื่อยืนยัน';
        pw.setAttribute('aria-invalid', 'true');
        return pw.focus();
      }
      go.disabled = true;
      try {
        await api('/api/me/delete', { method: 'POST', body: { password: pw.value } });
        location.replace('./');
      } catch (ex) {
        go.disabled = false;
        pw.value = '';
        pw.setAttribute('aria-invalid', 'true');
        err.textContent = ex.message;
        pw.focus();
      }
    });
  }

  function bindPlayers() {
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/api/me/players/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
        players = players.filter((p) => p.gameSlug !== b.dataset.del);
        $('#players-slot').innerHTML = playersHtml();
        bindPlayers();
        $('#live').textContent = 'ลบ UID ที่บันทึกไว้แล้ว';
        $('#players-title').focus();
      } catch (ex) {
        b.disabled = false;
        $('#live').textContent = ex.message;
      }
    }));
  }

  async function post(sel, url, then) {
    const b = $(sel);
    b.disabled = true;
    try {
      await api(url, { method: 'POST', body: {} });
      location.replace(then);
    } catch (ex) {
      b.disabled = false;
      $('#side-err').textContent = ex.message;
    }
  }

  async function doClaim() {
    const list = claimable();
    const btn = $('#claim');
    btn.disabled = true;
    try {
      const { claimed } = await api('/api/me/orders/claim', {
        method: 'POST',
        body: { orders: list.map((o) => ({ id: o.id, token: o.token })) },
      });
      skip.add(list.map((o) => o.id).filter((id) => !claimed.includes(id)));
      orders = await api('/api/me/orders');
      $('#claim-slot').innerHTML = claimHtml();
      $('#orders-slot').innerHTML = ordersHtml();
      $('#live').textContent = claimed.length
        ? `เพิ่ม ${claimed.length} ออเดอร์เข้าบัญชีแล้ว`
        : 'ออเดอร์เหล่านี้เพิ่มเข้าบัญชีไม่ได้ (อาจเป็นของบัญชีอื่น)';
      $('#orders-title').focus();
    } catch (ex) {
      btn.disabled = false;
      $('#live').textContent = ex.message;
    }
  }

  // ---------- เริ่ม ----------
  Promise.all([shopConfig, memberStatus()])
    .then(async ([c, member]) => {
      cfg = c || {};
      if (!member) return location.replace(`login.html?next=${encodeURIComponent(location.pathname)}`);
      const [info, list, saved, gameList] = await Promise.all([
        api('/api/me'), api('/api/me/orders'), api('/api/me/players'), api('/api/games').catch(() => []),
      ]);
      me = info;
      orders = list;
      players = saved;
      games = new Map(gameList.map((g) => [g.slug, g]));
      render();
    })
    .catch((e) => {
      app.innerHTML = `<header class="top"><a class="logo" href="./"><span data-shop>Koinz</span></a></header>
        <p class="error" role="alert">${esc(e.message)}</p>`;
    });
})();
