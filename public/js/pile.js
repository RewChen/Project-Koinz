// กองเหรียญ voxel — วาดด้วย SVG polygon (อัลกอริทึมเดียวกับ mockup)
//   renderPile(svgEl, level, label)   level 1–6 (ลำดับแพ็กเกจตามราคา + 1)
// Animation เดียวของเว็บ: บล็อกที่เพิ่มขึ้นใหม่ตกลงมาทีละชั้นจากล่างขึ้นบน (ปิดเมื่อ prefers-reduced-motion)
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const S = 12, N = 8, C = 4, R = 4.7, G = 0.5;
  const P = (x, y, z) => ((x - y) * S * 0.866).toFixed(1) + ',' + ((x + y) * S * 0.5 - z * S).toFixed(1);
  const hash = (a, b) => {
    let h = Math.imul(a + 7, 73856093) ^ Math.imul(b + 3, 19349663);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h >>> 0) % 1000) / 1000;
  };

  // → { ground: [faces], blocks: [{ key, z, faces }] } เรียงจากหลังมาหน้า
  function pileModel(level) {
    const ground = [
      { pts: [P(0, 0, G), P(N, 0, G), P(N, N, G), P(0, N, G)], fill: '--ground-top', stroke: '--ground-top' },
      { pts: [P(0, N, G), P(N, N, G), P(N, N, 0), P(0, N, 0)], fill: '--ground-left', stroke: '--ground-left' },
      { pts: [P(N, 0, G), P(N, N, G), P(N, N, 0), P(N, 0, 0)], fill: '--ground-right', stroke: '--ground-right' },
    ];
    const cells = [];
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        const d = Math.hypot(x + 0.5 - C, y + 0.5 - C);
        const h = Math.floor(level * 1.2 * (1 - d / R) + hash(x, y) * 0.9);
        if (h > 0) cells.push({ x, y, h });
      }
    }
    cells.sort((a, b) => a.x + a.y - (b.x + b.y)); // วาดจากหลังมาหน้า
    const blocks = [];
    for (const { x, y, h } of cells) {
      for (let z = 0; z < h; z++) {
        const z0 = G + z, z1 = z0 + 1;
        const faces = [
          { pts: [P(x, y + 1, z1), P(x + 1, y + 1, z1), P(x + 1, y + 1, z0), P(x, y + 1, z0)], fill: '--gold-left', stroke: '--gold-left-edge' },
          { pts: [P(x + 1, y, z1), P(x + 1, y + 1, z1), P(x + 1, y + 1, z0), P(x + 1, y, z0)], fill: '--gold-right', stroke: '--gold-right-edge' },
        ];
        if (z === h - 1) {
          faces.push({
            pts: [P(x, y, z1), P(x + 1, y, z1), P(x + 1, y + 1, z1), P(x, y + 1, z1)],
            fill: hash(y, x) > 0.82 ? '--gold-shine' : '--gold-top',
            stroke: '--gold-top-edge',
          });
        }
        blocks.push({ key: `${x},${y},${z}`, top: z === h - 1, z, faces });
      }
    }
    return { ground, blocks };
  }

  function polygon(face) {
    const el = document.createElementNS(NS, 'polygon');
    el.setAttribute('points', face.pts.join(' '));
    el.setAttribute('stroke-width', '0.5');
    el.setAttribute('stroke-linejoin', 'round');
    // var() ใช้ใน attribute fill ไม่ได้ ต้องตั้งผ่าน style
    el.style.fill = `var(${face.fill})`;
    el.style.stroke = `var(${face.stroke})`;
    return el;
  }

  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function renderPile(svg, level, label) {
    const lv = Math.max(1, Math.min(6, Math.round(level) || 1));
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', '-96 -112 192 212');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label ? `กองเหรียญขนาด ${label}` : 'กองเหรียญ');

    const before = svg._koinzBlocks || null; // บล็อก (key + ว่าเป็นชั้นบนสุดไหม) ของรอบก่อน
    const { ground, blocks } = pileModel(lv);
    const animate = before && !reduceMotion() && typeof Element.prototype.animate === 'function';

    svg.replaceChildren();
    for (const f of ground) svg.appendChild(polygon(f));
    const added = [];
    for (const b of blocks) {
      const g = document.createElementNS(NS, 'g');
      for (const f of b.faces) g.appendChild(polygon(f));
      svg.appendChild(g);
      if (animate && !before.has(b.key)) added.push({ g, z: b.z });
    }
    svg._koinzBlocks = new Set(blocks.map((b) => b.key));

    if (added.length) {
      // ตกลงมาทีละชั้น: ชั้นล่างก่อน
      const layers = [...new Set(added.map((a) => a.z))].sort((a, b) => a - b);
      const step = Math.min(60, 250 / layers.length);
      for (const { g, z } of added) {
        g.animate(
          [{ transform: 'translateY(-40px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
          { duration: 250, delay: layers.indexOf(z) * step, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' }
        );
      }
    }
  }

  // ลำดับขนาดของแพ็กเกจในเกม (ตามราคา) → level 1–6
  function pileLevel(packages, packageId) {
    const sorted = [...(packages || [])].sort((a, b) => a.price - b.price);
    const i = sorted.findIndex((p) => p.id === packageId);
    return Math.min(6, (i < 0 ? 3 : i) + 1);
  }

  window.renderPile = renderPile;
  window.pileLevel = pileLevel;
})();
