// Tencent's Android formatter returns a new array. Drop the much larger raw
// response array once formatting has completed to reduce peak QuickJS memory.
export function releaseTencentRawComments(raw, formatted, sourceName) {
  if (sourceName === 'qq' && formatted !== raw && Array.isArray(raw)) raw.length = 0;
}
