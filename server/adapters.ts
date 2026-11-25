export async function lookupNickname(gameSlug: string, playerInputs: Record<string, string>) {
  // Mock adapter: replace this deterministic response with the game's official lookup provider.
  const id = Object.values(playerInputs).filter(Boolean).join(' / ');
  if (!id) throw new Error('กรุณากรอกข้อมูลผู้เล่น');
  return { nickname: `ผู้เล่น ${id.slice(0, 8)}`, verified: true, provider: `mock:${gameSlug}` };
}

export async function fulfillTopup(input: { supplierSku: string; playerInputs: unknown; orderNumber: string }) {
  // Never report success until the supplier confirms the delivery.
  if (!process.env.SUPPLIER_API_URL || !process.env.SUPPLIER_API_KEY) {
    throw new Error('ยังไม่ได้ตั้งค่า Supplier API');
  }
  const response = await fetch(`${process.env.SUPPLIER_API_URL}/topups`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.SUPPLIER_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': input.orderNumber },
    body: JSON.stringify({ sku: input.supplierSku, player: input.playerInputs, reference: input.orderNumber }),
  });
  if (!response.ok) throw new Error(`Supplier ตอบกลับ ${response.status}`);
  return await response.json() as { reference?: string };
}
