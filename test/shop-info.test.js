// เทสข้อมูลร้าน (SHOP_INFO_SPEC.md) — ค่าจาก env → /api/config (key shop) → fillShopInfo() ใน common.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT, startServer } = require('./helpers');

// โหลด common.js ใน vm (ไม่มีเบราว์เซอร์) แล้วเรียก fillShopInfo() กับ DOM จำลอง
function loadCommon() {
  const ctx = vm.createContext({
    window: {}, URL, URLSearchParams, console,
    location: { origin: 'https://shop.example', href: 'https://shop.example/about.html', pathname: '/about.html', search: '' },
    fetch: () => Promise.reject(new Error('offline')),
    localStorage: { getItem: () => null, setItem() {} },
    document: { querySelectorAll: () => [], querySelector: () => null },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'common.js'), 'utf8'), ctx);
  return (shop, els) => {
    const KEYS = { '[data-shop-row]': 'shopRow', '[data-shop-field]': 'shopField', '[data-shop-href]': 'shopHref' };
    ctx.__shop = shop;
    ctx.__root = { querySelectorAll: (sel) => els.filter((e) => KEYS[sel] in e.dataset) };
    vm.runInContext('fillShopInfo(__shop, __root)', ctx);
  };
}
function el(dataset, { text = '', href } = {}) {
  return {
    dataset, hidden: false, textContent: text, href,
    removeAttribute(n) { if (n === 'href') delete this.href; },
  };
}

describe('ข้อมูลร้าน Phase 1 — env → /api/config', () => {
  test('ไม่ตั้งค่า → ข้อมูลร้านว่าง ตัวเลขใช้ค่าเริ่มต้น', async () => {
    const s = await startServer();
    try {
      const { shop } = (await s.req('GET', '/api/config')).body;
      assert.deepEqual(shop, {
        name: 'Koinz', lineId: '', lineUrl: '', facebookUrl: '', facebookName: '', hours: '', legalName: '', dbdId: '',
        fulfillTargetMinutes: 15, refundHours: 24, stuckOrderHours: 1, termsVersion: '2026-11',
      });
    } finally {
      await s.stop();
    }
  });

  test('ตั้งค่าครบ → ส่งออกใต้ shop / ลิงก์ที่ไม่ใช่ https:// กลายเป็นค่าว่าง / ตัวเลขผิด → ค่าเริ่มต้น', async () => {
    const s = await startServer({
      SHOP_LINE_ID: 'deworldr',
      SHOP_LINE_URL: 'https://line.me/ti/p/~deworldr',
      SHOP_FACEBOOK_URL: 'https://www.facebook.com/profile.php?id=61596943354373',
      SHOP_FACEBOOK_NAME: 'Koinz เติมเกม',
      SHOP_HOURS: '09:00–22:00 น.',
      SHOP_LEGAL_NAME: 'ร้าน Koinz',
      SHOP_DBD_ID: '0123456789012',
      FULFILL_TARGET_MINUTES: '20',
      REFUND_HOURS: '48',
      STUCK_ORDER_HOURS: '-3',
      TERMS_VERSION: '2026-12',
    });
    try {
      const c = (await s.req('GET', '/api/config')).body;
      assert.deepEqual(c.shop, {
        name: 'Koinz',
        lineId: 'deworldr',
        lineUrl: 'https://line.me/ti/p/~deworldr',
        facebookUrl: 'https://www.facebook.com/profile.php?id=61596943354373',
        facebookName: 'Koinz เติมเกม',
        hours: '09:00–22:00 น.',
        legalName: 'ร้าน Koinz',
        dbdId: '0123456789012',
        fulfillTargetMinutes: 20,
        refundHours: 48,
        stuckOrderHours: 1,
        termsVersion: '2026-12',
      });
      assert.equal(c.shopLineUrl, 'https://line.me/ti/p/~deworldr');
    } finally {
      await s.stop();
    }
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'http://facebook.com/x', 'data:text/html,hi', 'facebook.com/x', 'https://u:p@evil.example']) {
      const b = await startServer({ SHOP_FACEBOOK_URL: bad, SHOP_LINE_URL: bad });
      try {
        const c = (await b.req('GET', '/api/config')).body;
        assert.equal(c.shop.facebookUrl, '', bad);
        assert.equal(c.shop.lineUrl, '', bad);
        assert.equal(c.shopLineUrl, '', bad);
      } finally {
        await b.stop();
      }
    }
  });

  test('/api/config ไม่มีความลับหลุด: key ตรงตามรายการ และไม่มีค่าลับใด ๆ ใน response', async () => {
    const secrets = {
      ADMIN_PASSWORD: 'secret-admin-pass-7781',
      SESSION_SECRET: 'secret-session-0123456789abcdefghijklmnop',
      PAYMENT_WEBHOOK_SECRET: 'secret-webhook-5521',
      SUPPLIER_API_URL: 'http://127.0.0.1:9/supplier-secret-path',
      SUPPLIER_API_KEY: 'secret-supplier-key-9931',
      LOOKUP_API_URL: 'http://127.0.0.1:9/lookup-secret-path',
      LOOKUP_API_KEY: 'secret-lookup-key-4410',
      RESEND_API_KEY: 're_secretresendkey12345',
      ADMIN_ALERT_WEBHOOK: 'https://discord.example/api/webhooks/secret-hook-777',
      MAIL_FROM: 'Koinz <secret-sender@example.com>',
    };
    const s = await startServer({ ...secrets, SHOP_FACEBOOK_URL: 'https://www.facebook.com/koinz' });
    try {
      const r = await s.req('GET', '/api/config');
      assert.deepEqual(Object.keys(r.body).sort(), [
        'autoFulfill', 'lineLoginEnabled', 'lookupEnabled', 'orderTtlMinutes', 'passwordResetEnabled',
        'promptPayName', 'shop', 'shopLineUrl', 'shopName', 'siteBanner',
      ]);
      assert.deepEqual(Object.keys(r.body.shop).sort(), [
        'dbdId', 'facebookName', 'facebookUrl', 'fulfillTargetMinutes', 'hours', 'legalName', 'lineId', 'lineUrl',
        'name', 'refundHours', 'stuckOrderHours', 'termsVersion',
      ]);
      for (const [k, v] of Object.entries(secrets)) {
        assert.ok(!r.text.includes(v), `${k} หลุดใน /api/config`);
      }
      assert.doesNotMatch(r.text, /secret|127\.0\.0\.1|postgres:\/\//i);
    } finally {
      await s.stop();
    }
  });
});

describe('ข้อมูลร้าน Phase 1 — fillShopInfo() ใน common.js', () => {
  const fill = loadCommon();

  test('ไม่ตั้ง Facebook → ซ่อนทั้งแถว / ตั้ง → แสดง พร้อมลิงก์และชื่อ', () => {
    const make = () => {
      const row = el({ shopRow: 'facebookUrl' });
      const link = el({ shopHref: 'facebookUrl' }, { href: '' });
      const name = el({ shopField: 'facebookName' }, { text: 'เพจ Facebook' });
      return { row, link, name, all: [row, link, name] };
    };
    const a = make();
    fill({ facebookUrl: '', facebookName: '' }, a.all);
    assert.equal(a.row.hidden, true);
    assert.equal(a.link.href, undefined);
    assert.equal(a.name.textContent, 'เพจ Facebook'); // ไม่มีค่า → คงข้อความตั้งต้น

    const b = make();
    fill({ facebookUrl: 'https://www.facebook.com/koinz', facebookName: 'Koinz เติมเกม' }, b.all);
    assert.equal(b.row.hidden, false);
    assert.equal(b.link.href, 'https://www.facebook.com/koinz');
    assert.equal(b.name.textContent, 'Koinz เติมเกม');

    const none = make();
    fill(undefined, none.all); // /api/config ล้มเหลว
    assert.equal(none.row.hidden, true);
  });

  test('ลิงก์ javascript: / http: / ข้อความ → ไม่ใส่ href และซ่อนแถว (กันอีกชั้นหลังเซิร์ฟเวอร์)', () => {
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'http://facebook.com/x', 'data:text/html,x', '//evil.example', 'facebook.com']) {
      const row = el({ shopRow: 'facebookUrl' });
      const link = el({ shopHref: 'facebookUrl' }, { href: 'about.html' });
      fill({ facebookUrl: bad }, [row, link]);
      assert.equal(row.hidden, true, bad);
      assert.equal(link.href, undefined, bad);
    }
  });

  test('ข้อความใส่ด้วย textContent (HTML ไม่ถูกตีความ) / แถวหลายค่าต้องมีครบ', () => {
    const name = el({ shopField: 'legalName' });
    const both = el({ shopRow: 'legalName dbdId' });
    const one = el({ shopRow: 'legalName' });
    fill({ legalName: '<img src=x onerror=alert(1)>', dbdId: '' }, [name, both, one]);
    assert.equal(name.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(both.hidden, true);
    assert.equal(one.hidden, false);
    const mins = el({ shopField: 'fulfillTargetMinutes' }, { text: '15' });
    fill({ fulfillTargetMinutes: 20 }, [mins]);
    assert.equal(mins.textContent, '20');
  });

  test('common.js ไม่ใช้ innerHTML ใน fillShopInfo', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common.js'), 'utf8');
    const body = src.slice(src.indexOf('function fillShopInfo'), src.indexOf('const shopConfig'));
    assert.ok(body.length > 100);
    assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
