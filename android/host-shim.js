// QuickJS host compatibility layer. Installs before importing the upstream
// engine so http-util selects this native fetch bridge instead of node-fetch.
(() => {
  const host = globalThis.DanmakuHost;
  if (!host) throw new Error('DanmakuHost is unavailable');
  const nativeConsole = globalThis.console || {};
  const nativeConsoleLog = typeof nativeConsole.log === 'function'
    ? (...args) => { try { nativeConsole.log.apply(nativeConsole, args); } catch (_) {} }
    : () => {};

  function consoleMessage(args) {
    return args.map(value => {
      if (typeof value === 'string') return value;
      try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
      } catch (_) { return String(value); }
    }).join(' ');
  }

  // Android QuickJS currently provides only console.log. Route all standard
  // levels to the host logger while keeping the original native log as a
  // failure fallback. The forwarding guard prevents a native logger that
  // re-enters console from causing recursion.
  const isNodeRuntime = typeof process !== 'undefined' && Boolean(process.versions && process.versions.node);
  if (!isNodeRuntime) {
    let forwardingConsoleLog = false;
    const runtimeConsole = Object.create(nativeConsole);
    const bridgeConsole = level => (...args) => {
      if (forwardingConsoleLog) { nativeConsoleLog(...args); return; }
      forwardingConsoleLog = true;
      let delivered = false;
      try {
        if (typeof host.log !== 'function') throw new Error('DanmakuHost.log is unavailable');
        host.log(level, consoleMessage(args));
        delivered = true;
      } catch (_) {
        // Keep native console output as the last resort; never call the bridge
        // again from this fallback path.
      } finally {
        forwardingConsoleLog = false;
      }
      if (!delivered) nativeConsoleLog(...args);
    };
    runtimeConsole.log = bridgeConsole('info');
    runtimeConsole.info = bridgeConsole('info');
    runtimeConsole.warn = bridgeConsole('warn');
    runtimeConsole.error = bridgeConsole('error');
    runtimeConsole.debug = bridgeConsole('debug');
    try { globalThis.console = runtimeConsole; } catch (_) {}
  }

  let requestId = 1;
  let timerId = 1;
  const requests = new Map();
  const timers = new Map();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function fromBase64(value) {
    const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const bytes = [];
    let bits = 0, buffer = 0;
    for (const char of text) {
      if (char === '=') break;
      const n = alphabet.indexOf(char);
      if (n < 0) continue;
      buffer = (buffer << 6) | n; bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
    }
    return new Uint8Array(bytes);
  }
  function toBase64(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    let output = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], hasB = i + 1 < bytes.length, hasC = i + 2 < bytes.length;
      const b = hasB ? bytes[i + 1] : 0, c = hasC ? bytes[i + 2] : 0;
      output += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b >> 4)];
      output += hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
      output += hasC ? alphabet[c & 63] : '=';
    }
    return output;
  }
  function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(value || []);
  }

  class HostTextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      const text = String(input), out = [];
      for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
          const low = text.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + low - 0xdc00; i++; }
          else c = 0xfffd;
        } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
    encodeInto(input, destination) {
      const bytes = this.encode(input), count = Math.min(bytes.length, destination.length);
      destination.set(bytes.subarray(0, count));
      return { read: String(input).length, written: count };
    }
  }
  class HostTextDecoder {
    constructor(label = 'utf-8', options = {}) {
      this.encoding = String(label || 'utf-8').toLowerCase();
      this.fatal = options.fatal === true; this.ignoreBOM = options.ignoreBOM === true;
    }
    decode(input = new Uint8Array(), options = {}) {
      const bytes = bytesOf(input); let out = '';
      for (let i = 0; i < bytes.length;) {
        const first = bytes[i++]; let code = first, more = 0;
        if (first >= 0xf0 && first <= 0xf4) { code = first & 7; more = 3; }
        else if (first >= 0xe0 && first <= 0xef) { code = first & 15; more = 2; }
        else if (first >= 0xc2 && first <= 0xdf) { code = first & 31; more = 1; }
        else if (first >= 0x80) code = -1;
        let valid = code >= 0 && i + more <= bytes.length;
        for (let n = 0; valid && n < more; n++) {
          const next = bytes[i + n]; if ((next & 0xc0) !== 0x80) valid = false;
          else code = (code << 6) | (next & 63);
        }
        if (valid && ((more === 1 && code < 0x80) || (more === 2 && code < 0x800) || (more === 3 && (code < 0x10000 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))))) valid = false;
        if (!valid) { if (this.fatal || options.fatal) throw new TypeError('Invalid UTF-8 sequence'); out += '\ufffd'; continue; }
        i += more;
        if (code <= 0xffff) out += String.fromCharCode(code);
        else { code -= 0x10000; out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023)); }
      }
      if (!this.ignoreBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
      return out;
    }
  }

  const NativeTextDecoder = globalThis.TextDecoder;
  class RuntimeTextDecoder {
    constructor(label = 'utf-8', options = {}) {
      this.encoding = String(label || 'utf-8').toLowerCase();
      this._extendedEncoding = /^(gbk|gb2312|gb18030|big5)$/i.test(this.encoding);
      this._options = options || {};
      this._fallback = new HostTextDecoder(label, options);
      this._native = null;
      if (NativeTextDecoder && (!this._extendedEncoding || typeof host.decodeBase64 !== 'function')) {
        try { this._native = new NativeTextDecoder(label, options); } catch (_) {}
      }
      this.fatal = this._options.fatal === true;
      this.ignoreBOM = this._options.ignoreBOM === true;
    }
    decode(input = new Uint8Array(), options = {}) {
      if (this._extendedEncoding && typeof host.decodeBase64 === 'function') {
        return String(host.decodeBase64(toBase64(bytesOf(input)), this.encoding));
      }
      if (this._native) return this._native.decode(input, options);
      return this._fallback.decode(input, options);
    }
  }

  const encodePart = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const decodePart = value => { try { return decodeURIComponent(String(value).replace(/\+/g, ' ')); } catch (_) { return String(value).replace(/\+/g, ' '); } };
  class HostURLSearchParams {
    constructor(init = '') {
      this.items = [];
      if (typeof init === 'string') {
        for (const part of init.replace(/^\?/, '').split('&')) if (part) {
          const i = part.indexOf('='); this.items.push([decodePart(i < 0 ? part : part.slice(0, i)), decodePart(i < 0 ? '' : part.slice(i + 1))]);
        }
      } else if (Array.isArray(init)) init.forEach(pair => { if (pair && pair.length > 1) this.append(pair[0], pair[1]); });
      else if (init && typeof init === 'object') Object.keys(init).forEach(key => this.append(key, init[key]));
    }
    append(k, v) { this.items.push([String(k), String(v)]); }
    set(k, v) { k = String(k); v = String(v); const i = this.items.findIndex(x => x[0] === k); this.items = this.items.filter(x => x[0] !== k); if (i < 0) this.items.push([k, v]); else this.items.splice(Math.min(i, this.items.length), 0, [k, v]); }
    get(k) { const item = this.items.find(x => x[0] === String(k)); return item ? item[1] : null; }
    getAll(k) { return this.items.filter(x => x[0] === String(k)).map(x => x[1]); }
    has(k) { return this.items.some(x => x[0] === String(k)); }
    delete(k) { this.items = this.items.filter(x => x[0] !== String(k)); }
    sort() { this.items.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }
    forEach(fn, self) { this.items.slice().forEach(x => fn.call(self, x[1], x[0], this)); }
    entries() { return this.items.map(x => x.slice())[Symbol.iterator](); }
    keys() { return this.items.map(x => x[0])[Symbol.iterator](); }
    values() { return this.items.map(x => x[1])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this.items.map(x => `${encodePart(x[0])}=${encodePart(x[1])}`).join('&'); }
  }
  class HostURL {
    constructor(input, base) { this._parse(String(input), base === undefined ? '' : String(base)); }
    _parse(input, base) {
      let value = input.trim();
      if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
        if (!base) throw new TypeError('Invalid URL');
        const b = new HostURL(base);
        if (value.startsWith('//')) value = b.protocol + value;
        else if (value.startsWith('/')) value = b.origin + value;
        else if (value.startsWith('?')) value = b.origin + b.pathname + value;
        else if (value.startsWith('#')) value = b.origin + b.pathname + b.search + value;
        else value = b.origin + b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1) + value;
      }
      const m = value.match(/^([a-zA-Z][a-zA-Z\d+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/);
      if (!m) throw new TypeError('Invalid URL');
      this._protocol = m[1].toLowerCase(); this._authority = m[2] || '';
      this._pathname = m[3] || '/'; if (this._authority && !this._pathname.startsWith('/')) this._pathname = `/${this._pathname}`;
      this._params = new HostURLSearchParams(m[4] || ''); this._hash = m[5] === undefined ? '' : `#${m[5]}`;
      this._normalizePath();
    }
    _normalizePath() { if (!this._authority) return; const parts = []; for (const p of this._pathname.split('/')) { if (!p || p === '.') continue; if (p === '..') parts.pop(); else parts.push(p); } this._pathname = `/${parts.join('/')}`; }
    get href() { return this.toString(); } set href(v) { this._parse(String(v), ''); }
    get protocol() { return this._protocol; } set protocol(v) { this._protocol = String(v).endsWith(':') ? String(v).toLowerCase() : `${String(v).toLowerCase()}:`; }
    get host() { return this._authority; } set host(v) { this._authority = String(v); }
    get hostname() { return this._authority.split('@').pop().split(':')[0]; }
    set hostname(v) { const auth = this._authority.split('@'), cred = auth.length > 1 ? `${auth.slice(0, -1).join('@')}@` : '', tail = auth[auth.length - 1], port = tail.includes(':') ? tail.slice(tail.lastIndexOf(':')) : ''; this._authority = `${cred}${String(v)}${port}`; }
    get port() { const a = this._authority.split('@').pop(); return a.includes(':') ? a.slice(a.lastIndexOf(':') + 1) : ''; }
    set port(v) { this.host = `${this.hostname}${v ? `:${v}` : ''}`; }
    get origin() { return this._authority ? `${this._protocol}//${this._authority}` : 'null'; }
    get pathname() { return this._pathname; } set pathname(v) { this._pathname = String(v).startsWith('/') ? String(v) : `/${v}`; this._normalizePath(); }
    get search() { const s = this._params.toString(); return s ? `?${s}` : ''; } set search(v) { this._params = new HostURLSearchParams(String(v).replace(/^\?/, '')); }
    get searchParams() { return this._params; }
    get hash() { return this._hash; } set hash(v) { const s = String(v); this._hash = !s ? '' : (s.startsWith('#') ? s : `#${s}`); }
    toString() { return `${this._protocol}${this._authority ? `//${this._authority}` : ''}${this._pathname}${this.search}${this._hash}`; }
  }
  class HostHeaders {
    constructor(init = {}) { this.valuesByName = Object.create(null); if (init instanceof HostHeaders) init.forEach((v, k) => this.set(k, v)); else if (Array.isArray(init)) init.forEach(x => { if (x && x.length > 1) this.append(x[0], x[1]); }); else if (init && typeof init === 'object') Object.keys(init).forEach(k => this.set(k, init[k])); }
    append(k, v) { k = String(k).toLowerCase(); this.valuesByName[k] = this.valuesByName[k] ? `${this.valuesByName[k]}, ${String(v).trim()}` : String(v).trim(); }
    set(k, v) { this.valuesByName[String(k).toLowerCase()] = String(v).trim(); }
    get(k) { const v = this.valuesByName[String(k).toLowerCase()]; return v === undefined ? null : v; }
    has(k) { return Object.prototype.hasOwnProperty.call(this.valuesByName, String(k).toLowerCase()); }
    delete(k) { delete this.valuesByName[String(k).toLowerCase()]; }
    forEach(fn, self) { Object.keys(this.valuesByName).forEach(k => fn.call(self, this.valuesByName[k], k, this)); }
    entries() { return Object.keys(this.valuesByName).sort().map(k => [k, this.valuesByName[k]])[Symbol.iterator](); }
    keys() { return Object.keys(this.valuesByName).sort()[Symbol.iterator](); }
    values() { return Object.keys(this.valuesByName).sort().map(k => this.valuesByName[k])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toJSON() { const out = {}; this.forEach((v, k) => { out[k] = v; }); return out; }
  }
  class HostResponse {
    constructor(body = null, init = {}) {
      this.status = Number(init.status || 200);
      this.statusText = String(init.statusText || '');
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new HostHeaders(init.headers || {});
      this.url = String(init.url || '');
      this.redirected = init.redirected === true;
      this.type = 'basic';
      this._text = typeof body === 'string' ? body : null;
      this._base64 = this._text === null
        && Object.prototype.hasOwnProperty.call(init, 'bodyBase64')
        && typeof init.bodyBase64 === 'string'
        ? init.bodyBase64
        : null;
      this._bytes = this._text !== null || this._base64 !== null
        ? null
        : body == null ? new Uint8Array() : bytesOf(body).slice();
      this.bodyUsed = false;
    }
    async arrayBuffer() {
      this.bodyUsed = true;
      const bytes = this._base64 !== null
        ? fromBase64(this._base64)
        : this._text !== null
          ? new HostTextEncoder().encode(this._text)
          : (this._bytes || new Uint8Array());
      const copy = bytes.slice();
      return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    }
    async text() {
      this.bodyUsed = true;
      if (this._text !== null) return this._text;
      if (this._base64 !== null) {
        if (typeof host.decodeBase64 === 'function') {
          try { return String(host.decodeBase64(this._base64, 'UTF-8')); } catch (_) {}
        }
        return new HostTextDecoder().decode(fromBase64(this._base64));
      }
      return new HostTextDecoder().decode(this._bytes || new Uint8Array());
    }
    async json() { return JSON.parse(await this.text()); }
    clone() {
      const init = { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, redirected: this.redirected };
      if (this._base64 !== null) init.bodyBase64 = this._base64;
      const body = this._text !== null ? this._text : this._base64 !== null ? null : this._bytes;
      return new HostResponse(body, init);
    }
  }
  class HostAbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this.listeners = new Set(); }
    addEventListener(type, fn) { if (type === 'abort' && typeof fn === 'function') this.listeners.add(fn); }
    removeEventListener(type, fn) { if (type === 'abort') this.listeners.delete(fn); }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    _abort(reason) { if (this.aborted) return; this.aborted = true; this.reason = reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }); for (const fn of [...this.listeners]) { try { fn.call(this, { type: 'abort', target: this }); } catch (_) {} } this.listeners.clear(); }
  }
  class HostAbortController { constructor() { this.signal = new HostAbortSignal(); } abort(reason) { this.signal._abort(reason); } }
  function errorFrom(value) { const e = new Error(value && value.message ? String(value.message) : String(value || 'Request failed')); if (value && value.name) e.name = String(value.name); if (value && value.code) e.code = String(value.code); return e; }

  globalThis.__dmHttpComplete = (id, raw) => {
    const task = requests.get(Number(id)); if (!task) return; requests.delete(Number(id));
    let response; try { response = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { task.reject(errorFrom(e)); return; }
    if (!response || response.error) { task.reject(errorFrom(response && response.error)); return; }
    const init = { status: response.status || 0, headers: response.headers || {}, url: task.url };
    let body = null;
    if (typeof response.bodyBase64 === 'string' && response.bodyBase64.length > 0) init.bodyBase64 = response.bodyBase64;
    else body = typeof response.bodyText === 'string' ? response.bodyText : '';
    task.resolve(new HostResponse(body, init));
  };
  globalThis.__dmTimerFire = id => {
    const entry = timers.get(Number(id)); if (!entry) return;
    if (!entry.interval) timers.delete(Number(id));
    try { entry.fn(...entry.args); } catch (e) { try { host.log('error', `Timer callback failed (${e && e.name || 'Error'})`); } catch (_) {} }
    if (entry.interval && timers.has(Number(id))) host.timer(Number(id), entry.delay);
  };
  globalThis.fetch = (input, init = {}) => {
    const url = input instanceof HostURL ? input.toString() : String(input && input.url || input);
    const id = requestId++; const signal = init.signal || (input && input.signal);
    if (signal && signal.aborted) return Promise.reject(errorFrom(signal.reason));
    const headers = new HostHeaders(init.headers || (input && input.headers) || {}).toJSON();
    let body = init.body === undefined ? null : init.body;
    if (body !== null && typeof body !== 'string') body = new HostTextDecoder().decode(bytesOf(body));
    return new Promise((resolve, reject) => {
      const abort = () => { try { host.abort(id); } catch (_) {} requests.delete(id); reject(errorFrom(signal.reason)); };
      if (signal && signal.addEventListener) signal.addEventListener('abort', abort, { once: true });
      requests.set(id, {
        url,
        resolve: r => { if (signal && signal.removeEventListener) signal.removeEventListener('abort', abort); resolve(r); },
        reject: e => { if (signal && signal.removeEventListener) signal.removeEventListener('abort', abort); reject(e); }
      });
      const remaining = Number(globalThis.__dmRequestDeadline || 0) > 0 ? Math.max(1, Number(globalThis.__dmRequestDeadline) - Date.now()) : 0;
      try { host.request(id, url, JSON.stringify({ method: String(init.method || 'GET').toUpperCase(), headers, body, timeoutMs: remaining || Number(init.timeoutMs || 0), followRedirects: init.redirect !== 'manual', responseType: 'base64' })); }
      catch (e) { requests.delete(id); if (signal && signal.removeEventListener) signal.removeEventListener('abort', abort); reject(errorFrom(e)); }
    });
  };
  const addTimer = (fn, delay, args, interval) => { const id = timerId++; const entry = { fn: typeof fn === 'function' ? fn : () => {}, delay: Math.max(0, Number(delay) || 0), args, interval }; timers.set(id, entry); host.timer(id, entry.delay); return id; };
  globalThis.setTimeout = (fn, delay, ...args) => addTimer(fn, delay, args, false);
  globalThis.clearTimeout = id => { id = Number(id); if (timers.delete(id)) host.clearTimer(id); };
  globalThis.setInterval = (fn, delay, ...args) => addTimer(fn, delay, args, true);
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.URL = globalThis.URL || HostURL;
  globalThis.URLSearchParams = globalThis.URLSearchParams || HostURLSearchParams;
  globalThis.Headers = globalThis.Headers || HostHeaders;
  globalThis.Response = globalThis.Response || HostResponse;
  globalThis.TextEncoder = globalThis.TextEncoder || HostTextEncoder;
  globalThis.TextDecoder = RuntimeTextDecoder;
  globalThis.AbortController = globalThis.AbortController || HostAbortController;
  globalThis.structuredClone = globalThis.structuredClone || (value => value instanceof Uint8Array ? value.slice() : JSON.parse(JSON.stringify(value)));
  globalThis.atob = value => {
    const bytes = fromBase64(value);
    let output = '';
    const chunkSize = 8192;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      output += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return output;
  };
  globalThis.btoa = value => {
    const text = String(value);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 255) throw new Error('Invalid character');
      bytes[i] = code;
    }
    return toBase64(bytes);
  };
  // http-util treats missing WebAssembly as legacy iOS and tries node-fetch.
  if (typeof globalThis.WebAssembly === 'undefined') globalThis.WebAssembly = {};
  // Node exposes crypto as a read-only global accessor, while QuickJS may not
  // provide it. Preserve an existing implementation and only install a
  // fallback when the runtime has no global value.
  if (!globalThis.crypto) globalThis.crypto = {};
  if (typeof globalThis.crypto.getRandomValues !== 'function') globalThis.crypto.getRandomValues = view => {
    if (!ArrayBuffer.isView(view)) throw new TypeError('Expected typed array');
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(fromBase64(host.randomBytes(view.byteLength)).subarray(0, view.byteLength)); return view;
  };
  if (typeof globalThis.crypto.randomUUID !== 'function') globalThis.crypto.randomUUID = () => { const b = new Uint8Array(16); globalThis.crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  globalThis.__dmStorage = {
    get(key) { try { return host.storageGet(String(key)); } catch (_) { return 'null'; } },
    set(key, json) { try { host.storageSet(String(key), typeof json === 'string' ? json : JSON.stringify(json)); return true; } catch (_) { return false; } },
    remove(key) { try { host.storageRemove(String(key)); return true; } catch (_) { return false; } },
    clear() { try { if (typeof host.storageClear === 'function') host.storageClear(); return true; } catch (_) { return false; } }
  };
})();
