const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_PATTERN = /\b(authorization|cookie|set-cookie|token|access[_-]?token)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;

function safeText(value, maxLength) {
  return String(value || '')
    .split(/\r?\n/, 1)[0]
    .replace(URL_PATTERN, '[url]')
    .replace(CREDENTIAL_PATTERN, '$1=[redacted]')
    .slice(0, maxLength);
}

function safeLabel(value, fallback) {
  const text = String(value || fallback);
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : fallback;
}

// Keep enough for Android diagnostics while avoiding request URLs, headers,
// response bodies, nested causes, or full stacks in the app log.
export function safeErrorInfo(error) {
  const rawMessage = String(error && error.message || '');
  const isBodyLike = /^\s*(?:<!doctype\b|<html\b|[\[{])/i.test(rawMessage);
  const stackLines = String(error && error.stack || '').split(/\r?\n/).slice(0, 2);
  return {
    name: safeLabel(error && error.name, 'Error'),
    code: safeLabel(error && error.code, ''),
    message: isBodyLike ? '[omitted]' : safeText(rawMessage, 240),
    stack: stackLines.map(line => safeText(line, 240)).join(' | '),
  };
}
