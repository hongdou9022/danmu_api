const ALLOWED_PHASES = new Set([
  'raw',
  'format',
  'convert',
  'segment-raw',
  'segment-format',
  'segment-convert',
  'formatDanmuResponse',
]);

// Emit only fixed phase labels and non-negative counts to the native host.
export function logAndroidDanmakuCount(phase, count) {
  const value = Number(count);
  if (!ALLOWED_PHASES.has(phase) || !Number.isSafeInteger(value) || value < 0) return;
  try {
    globalThis.DanmakuHost.log('info', `danmaku-count phase=${phase} count=${value}`);
  } catch (_) {}
}
