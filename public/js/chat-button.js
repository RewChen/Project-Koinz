// ปุ่มแชทลอยสำหรับติดต่อแอดมินผ่านช่องทางที่ร้านตั้งค่าไว้
(function () {
  const apiUrl = (path) => String(window.KOINZ_API || '').replace(/\/+$/, '') + path;
  const icon = (body) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  async function init() {
    let shopLineUrl = '';
    try {
      const response = await fetch(apiUrl('/api/config'));
      if (response.ok) shopLineUrl = (await response.json()).shopLineUrl || '';
    } catch { /* แสดงปุ่มพร้อมข้อความตั้งค่าไม่ครบ ถ้าติดต่อ API ไม่ได้ */ }

    const params = new URLSearchParams(location.search);
    const orderId = params.get('id');
    const root = document.createElement('div');
    root.className = 'chat-widget';
    root.innerHTML = `
      <section class="chat-panel" id="chat-panel" role="dialog" aria-labelledby="chat-title" aria-modal="false" hidden>
        <header class="chat-head">
          <span class="chat-avatar" aria-hidden="true">K</span>
          <span class="chat-head-copy"><strong id="chat-title">แชทกับแอดมิน</strong><small>ทีมงาน Koinz พร้อมช่วยเหลือ</small></span>
          <button class="chat-close" type="button" aria-label="ปิดหน้าต่างแชท">${icon('<path d="m18 6-12 12M6 6l12 12"/>')}</button>
        </header>
        <div class="chat-content" aria-live="polite">
          <p class="chat-bubble">สวัสดีครับ ต้องการความช่วยเหลือเรื่องเติมเกมหรือออเดอร์ ติดต่อทีมงานได้ทาง LINE</p>
          <p class="chat-order" hidden></p>
          <a class="chat-line" href="#" target="_blank" rel="noopener noreferrer" hidden>เริ่มแชทกับแอดมิน ${icon('<path d="M7 17 17 7M7 7h10v10"/>')}</a>
          <p class="chat-unavailable" hidden>ร้านยังไม่ได้ตั้งค่าช่องทางแชท กรุณาติดต่อผู้ดูแลร้าน</p>
        </div>
      </section>
      <button class="chat-launch" type="button" aria-label="เปิดแชทกับแอดมิน" aria-expanded="false" aria-controls="chat-panel">
        <span class="chat-launch-icon">${icon('<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/>')}</span>
        <span>แชทกับแอดมิน</span>
      </button>`;
    document.body.appendChild(root);

    const panel = root.querySelector('.chat-panel');
    const launcher = root.querySelector('.chat-launch');
    const close = root.querySelector('.chat-close');
    const line = root.querySelector('.chat-line');
    const unavailable = root.querySelector('.chat-unavailable');
    const order = root.querySelector('.chat-order');
    if (/^https:\/\//i.test(shopLineUrl)) {
      line.href = shopLineUrl;
      line.hidden = false;
    } else {
      unavailable.hidden = false;
    }
    if (orderId) {
      order.textContent = `เลขออเดอร์ที่กำลังดู: ${orderId} (แจ้งเลขนี้กับแอดมินได้เลย)`;
      order.hidden = false;
    }

    function setOpen(open) {
      panel.hidden = !open;
      launcher.setAttribute('aria-expanded', String(open));
      if (open) close.focus(); else launcher.focus();
    }
    launcher.addEventListener('click', () => setOpen(panel.hidden));
    close.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) setOpen(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
