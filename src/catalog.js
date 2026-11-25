// แคตตาล็อกเกม/แพ็กเกจ และการตรวจข้อมูลผู้เล่นตาม fields ของแต่ละเกม
const store = require('./store');

const MAX_INPUT = 64;
const BAD_CHARS = /[<>"'`]/;

const getGames = () => store.read('games', []);

function findGame(slug, { includeInactive = false } = {}) {
  return getGames().find((g) => g.slug === slug && (includeInactive || g.active !== false)) || null;
}

function findPackage(game, packageId) {
  return (game.packages || []).find((p) => p.id === packageId && p.active !== false) || null;
}

const initialOf = (g) => g.initial || String(g.name || '?').trim().charAt(0).toUpperCase();

function publicField(f) {
  const out = { name: f.name, label: f.label, required: f.required !== false };
  for (const k of ['placeholder', 'hint', 'pattern', 'patternHint', 'inputmode']) if (f[k]) out[k] = f[k];
  if (Array.isArray(f.options)) out.options = f.options.slice();
  return out;
}

// ข้อมูลที่หน้าร้านใช้ — ห้ามมี sku และ cost
function publicGame(g) {
  return {
    slug: g.slug,
    name: g.name,
    category: g.category || '',
    color: g.color || '',
    currency: g.currency || '',
    initial: initialOf(g),
    fields: (g.fields || []).map(publicField),
    packages: (g.packages || [])
      .filter((p) => p.active !== false)
      .map((p) => {
        const out = { id: p.id, name: p.name, price: p.price };
        if (p.tag) out.tag = p.tag;
        return out;
      }),
  };
}

// สำหรับหน้ารวมเกม (ไม่ต้องมีแพ็กเกจทั้งหมด)
function publicSummary(g) {
  const { fields, packages, ...rest } = publicGame(g);
  return { ...rest, minPrice: packages.length ? Math.min(...packages.map((p) => p.price)) : null };
}

// ตรวจและทำความสะอาดข้อมูลผู้เล่น → { inputs } หรือ { error }
function validateInputs(game, raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const inputs = {};
  for (const f of game.fields || []) {
    const v = src[f.name];
    if (v !== undefined && v !== null && typeof v === 'object') return { error: `${f.label}ไม่ถูกต้อง` };
    const value = String(v ?? '').trim();
    const isSelect = Array.isArray(f.options);
    if (!value) {
      if (f.required !== false) return { error: `${isSelect ? 'กรุณาเลือก' : 'กรุณากรอก'}${f.label}` };
      continue;
    }
    if (value.length > MAX_INPUT) return { error: `${f.label}ยาวเกิน ${MAX_INPUT} ตัวอักษร` };
    if (BAD_CHARS.test(value)) return { error: `${f.label}มีอักขระที่ใช้ไม่ได้ (< > " ' \`)` };
    if (isSelect && !f.options.includes(value)) return { error: `กรุณาเลือก${f.label}จากรายการ` };
    if (f.pattern && !new RegExp(f.pattern).test(value)) return { error: f.patternHint || `${f.label}ไม่ถูกต้อง` };
    inputs[f.name] = value;
  }
  return { inputs };
}

// ข้อความสั้น ๆ ที่ใช้แสดงข้อมูลผู้เล่น
function playerLabel(game, inputs) {
  const fields = (game.fields || []).filter((f) => inputs[f.name]);
  if (fields.length === 1) return inputs[fields[0].name];
  return fields.map((f) => `${f.label} ${inputs[f.name]}`).join(' · ');
}

// ตรวจแคตตาล็อกทั้งร้านก่อนบันทึก → ข้อความ error ภาษาไทย หรือ null ถ้าถูกต้อง
function validateGames(games) {
  if (!Array.isArray(games)) return 'ข้อมูลต้องเป็นรายการเกม (array)';
  const slugs = new Set();
  const pkgIds = new Map(); // id -> ชื่อเกม
  const isText = (v) => typeof v === 'string' && v.trim() !== '';

  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (!g || typeof g !== 'object' || Array.isArray(g)) return `เกมลำดับที่ ${i + 1}: ข้อมูลไม่ถูกต้อง`;
    const gName = `เกม "${isText(g.name) ? g.name : g.slug || `ลำดับที่ ${i + 1}`}"`;

    if (typeof g.slug !== 'string' || !/^[a-z0-9-]{2,40}$/.test(g.slug)) {
      return `${gName}: slug ต้องเป็น a-z, 0-9 หรือ - ยาว 2–40 ตัว`;
    }
    if (slugs.has(g.slug)) return `${gName}: slug "${g.slug}" ซ้ำกับเกมอื่น`;
    slugs.add(g.slug);
    if (!isText(g.name)) return `${gName}: ต้องมีชื่อเกม (name)`;
    if (g.color !== undefined && g.color !== '' && !/^#[0-9A-Fa-f]{3,8}$/.test(g.color)) {
      return `${gName}: color ต้องเป็นรหัสสีแบบ #RRGGBB`;
    }

    if (!Array.isArray(g.fields) || g.fields.length < 1) return `${gName}: ต้องมีช่องข้อมูลผู้เล่น (fields) อย่างน้อย 1 ช่อง`;
    const fieldNames = new Set();
    for (const f of g.fields) {
      if (!f || typeof f.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(f.name)) {
        return `${gName}: ชื่อช่อง (field name) "${f && f.name}" ต้องขึ้นต้นด้วยตัวอักษรอังกฤษ และมีแค่ A-Z 0-9 _`;
      }
      if (fieldNames.has(f.name)) return `${gName}: ช่อง "${f.name}" ซ้ำกัน`;
      fieldNames.add(f.name);
      if (!isText(f.label)) return `${gName}: ช่อง "${f.name}" ต้องมี label`;
      if (f.pattern !== undefined) {
        try {
          new RegExp(f.pattern);
        } catch {
          return `${gName}: ช่อง "${f.name}" มี pattern ที่ใช้ไม่ได้`;
        }
      }
      if (f.options !== undefined && (!Array.isArray(f.options) || !f.options.length || !f.options.every(isText))) {
        return `${gName}: ช่อง "${f.name}" options ต้องเป็นรายการข้อความอย่างน้อย 1 ตัวเลือก`;
      }
    }

    if (!Array.isArray(g.packages) || g.packages.length < 1) return `${gName}: ต้องมีแพ็กเกจอย่างน้อย 1 แพ็ก`;
    for (const p of g.packages) {
      const pName = `แพ็กเกจ "${p && isText(p.name) ? p.name : (p && p.id) || '?'}"`;
      if (!p || !isText(p.id)) return `${gName}: ${pName} ต้องมี id`;
      if (pkgIds.has(p.id)) {
        return `${gName}: ${pName} ใช้ id "${p.id}" ซ้ำกับแพ็กเกจในเกม "${pkgIds.get(p.id)}"`;
      }
      pkgIds.set(p.id, g.name);
      if (!isText(p.name)) return `${gName}: แพ็กเกจ id "${p.id}" ต้องมีชื่อ (name)`;
      const price = p.price;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        return `${gName}: ${pName} ราคาต้องเป็นตัวเลขมากกว่า 0`;
      }
      if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) {
        return `${gName}: ${pName} ราคามีทศนิยมได้ไม่เกิน 2 ตำแหน่ง`;
      }
      if (p.cost !== undefined && (typeof p.cost !== 'number' || !(p.cost >= 0))) {
        return `${gName}: ${pName} cost ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป`;
      }
    }
  }
  return null;
}

module.exports = {
  getGames,
  findGame,
  findPackage,
  publicGame,
  publicSummary,
  validateInputs,
  playerLabel,
  validateGames,
};
