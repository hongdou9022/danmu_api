// Android's bundled QuickJS build predates BigInt syntax. Keep protobuf
// varints exact as decimal text, then let callers convert only fields whose
// existing API already exposes them as Number.
export function decodeVarintDecimal(bytes, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new Error('protobuf varint offset is invalid');
  }

  const payloads = [];
  let position = offset;
  let terminated = false;
  for (let index = 0; index < 10 && position < bytes.length; index++) {
    const byte = bytes[position++];
    const payload = byte & 0x7f;
    if (index === 9 && (payload > 1 || (byte & 0x80) !== 0)) {
      throw new Error('protobuf varint exceeds 64 bits');
    }
    payloads.push(payload);
    if ((byte & 0x80) === 0) {
      terminated = true;
      break;
    }
  }
  if (!terminated) throw new Error('protobuf varint is incomplete');

  // Protobuf encodes base-128 digits least-significant first.
  let decimal = '0';
  for (let index = payloads.length - 1; index >= 0; index--) {
    let carry = payloads[index];
    let next = '';
    for (let digitIndex = decimal.length - 1; digitIndex >= 0; digitIndex--) {
      const value = (decimal.charCodeAt(digitIndex) - 48) * 128 + carry;
      next = String(value % 10) + next;
      carry = Math.floor(value / 10);
    }
    while (carry > 0) {
      next = String(carry % 10) + next;
      carry = Math.floor(carry / 10);
    }
    decimal = next.replace(/^0+(?=\d)/, '');
  }

  return { value: decimal, offset: position };
}
