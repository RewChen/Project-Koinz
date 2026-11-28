// หน้าเอกสาร (terms.html / privacy.html): ใส่ลิงก์ LINE ของร้านจาก /api/config
shopConfig.then((c) => {
  const url = /^https?:\/\//.test((c && c.shopLineUrl) || '') ? c.shopLineUrl : '';
  if (!url) return;
  document.querySelectorAll('[data-line]').forEach((a) => {
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.hidden = false;
  });
  document.querySelectorAll('[data-line-none]').forEach((el) => (el.hidden = true));
});
