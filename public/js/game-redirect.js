// ย้ายมาจาก inline script ใน game.html (Content-Security-Policy: script-src 'self')
// หน้าเติมเกมรวมอยู่ในหน้าแรกแล้ว: game.html?slug=x → ./?game=x
const slug = new URLSearchParams(location.search).get('slug');
location.replace('./' + (slug ? '?game=' + encodeURIComponent(slug) : ''));
