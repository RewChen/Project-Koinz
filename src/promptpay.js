// สร้างข้อมูล QR PromptPay ตามมาตรฐาน EMVCo (Thai QR Payment)

function field(id, value) {
  return id + String(value.length).padStart(2, '0') + value;
}

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatTarget(id) {
  const digits = String(id).replace(/\D/g, '');
  if (digits.length >= 15) return { tag: '03', value: digits }; // e-Wallet ID
  if (digits.length === 13) return { tag: '02', value: digits }; // เลขบัตรประชาชน / เลขผู้เสียภาษี
  // เบอร์โทรศัพท์: 0812345678 -> 0066812345678
  const phone = ('0000000000000' + digits.replace(/^0/, '66')).slice(-13);
  return { tag: '01', value: phone };
}

function promptPayPayload(id, amount) {
  const target = formatTarget(id);
  const merchant = field('00', 'A000000677010111') + field(target.tag, target.value);
  let payload =
    field('00', '01') +
    field('01', amount ? '12' : '11') +
    field('29', merchant) +
    field('58', 'TH') +
    field('53', '764');
  if (amount) payload += field('54', Number(amount).toFixed(2));
  payload += '6304';
  return payload + crc16(payload);
}

module.exports = { promptPayPayload };
