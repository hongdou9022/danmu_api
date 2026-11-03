import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { TextDecoder as NodeTextDecoder } from 'node:util';
import rewritePattern from 'regexpu-core';
import { decodeVarintDecimal } from './protobuf-varint.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = new Map();
let requestCount = 0;
let decoderCallCount = 0;

globalThis.DanmakuHost = {
  request(id, url, optionsJson) {
    requestCount++;
    const options = JSON.parse(optionsJson);
    queueMicrotask(() => globalThis.__dmHttpComplete(id, JSON.stringify({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ url, method: options.method }),
    })));
  },
  abort() {},
  timer(id) { queueMicrotask(() => globalThis.__dmTimerFire(id)); },
  clearTimer() {},
  storageGet(key) { return data.has(key) ? data.get(key) : 'null'; },
  storageSet(key, value) { data.set(key, value); },
  storageRemove(key) { data.delete(key); },
  storageClear() { data.clear(); },
  randomBytes(size) { return Buffer.alloc(size, 7).toString('base64'); },
  decodeBase64(value, charset) {
    decoderCallCount++;
    return new NodeTextDecoder(charset).decode(Buffer.from(value, 'base64'));
  },
  log() {},
  complete() {},
};

const { OmniDanmakuEngine } = await import('./engine-entry.js');

test('engine metadata is pure, versioned, and reports the Android contract', async () => {
  const before = requestCount;
  const info = await OmniDanmakuEngine.info();
  assert.equal(info.success, true);
  assert.equal(info.apiVersion, 1);
  assert.equal(info.cacheSchema, 1);
  assert.ok(info.scriptVersion);
  assert.ok(info.capabilities.strictResolve);
  assert.equal(requestCount, before);
});

test('native fetch shim bridges async requests and reads host response JSON', async () => {
  const response = await fetch('https://unit.invalid/probe');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://unit.invalid/probe', method: 'GET' });
  assert.equal(requestCount, 1);
});

test('strict resolver refuses incomplete filenames without calling a fuzzy matcher', async () => {
  const before = requestCount;
  const result = await OmniDanmakuEngine.resolve({ fileName: '' });
  assert.deepEqual(result, { success: true, items: [] });
  assert.equal(requestCount, before);
});

test('Android bundle manifest matches the emitted script bytes and stays within host limits', async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'dist/android/manifest.json'), 'utf8'));
  const engine = await readFile(path.join(repoRoot, 'dist/android/engine.js'));
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.cacheSchema, 1);
  assert.equal(manifest.size, engine.length);
  assert.equal(manifest.sha256, createHash('sha256').update(engine).digest('hex'));
  assert.ok(manifest.size > 0 && manifest.size <= 8 * 1024 * 1024);
  assert.match(manifest.url, /^https:\/\/github\.com\/hongdou9022\/danmu_api\/releases\/download\/android-[^/]+\/engine\.js$/);
});

test('built IIFE starts in a QuickJS-like context without Node or browser globals', async () => {
  const engine = await readFile(path.join(repoRoot, 'dist/android/engine.js'), 'utf8');
  const isolatedData = new Map();
  let isolatedRequests = 0;
  const isolatedRequestUrls = [];
  let isolatedDecoderCalls = 0;
  const isolatedHostLogs = [];
  const nativeConsoleFallback = [];
  let failHostLogs = false;
  let context;
  const isolatedHost = {
    request(id, url, optionsJson) {
      isolatedRequests++;
      isolatedRequestUrls.push(url);
      const options = JSON.parse(optionsJson);
      const response = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({ url, method: options.method }),
      };
      if (url.endsWith('/native-json')) {
        response.bodyBase64 = Buffer.from(response.bodyText, 'utf8').toString('base64');
        delete response.bodyText;
      } else if (url.endsWith('/binary-response')) {
        response.bodyBase64 = Buffer.from([0, 255, 17, 128]).toString('base64');
        delete response.bodyText;
      }
      setTimeout(() => context.__dmHttpComplete(id, JSON.stringify(response)), 0);
    },
    abort() {},
    timer(id, delay) { setTimeout(() => context.__dmTimerFire(id), delay); },
    clearTimer() {},
    storageGet(key) { return isolatedData.has(key) ? isolatedData.get(key) : 'null'; },
    storageSet(key, value) { isolatedData.set(key, value); },
    storageRemove(key) { isolatedData.delete(key); },
    storageClear() { isolatedData.clear(); },
    randomBytes(size) { return Buffer.alloc(size, 9).toString('base64'); },
    decodeBase64(value, charset) {
      isolatedDecoderCalls++;
      return new NodeTextDecoder(charset).decode(Buffer.from(value, 'base64'));
    },
    log(level, message) {
      if (failHostLogs) throw new Error('host logger unavailable');
      isolatedHostLogs.push({ level, message });
    },
    complete() {},
  };
  context = vm.createContext({
    DanmakuHost: isolatedHost,
    // Match the current QuickJS host: setConsole exposes log only.
    console: { log: (...args) => nativeConsoleFallback.push(args.map(String).join(' ')) },
  });
  vm.runInContext(engine, context, { timeout: 5_000 });
  const info = await vm.runInContext('OmniDanmakuEngine.info()', context);
  assert.equal(info.apiVersion, 1);
  assert.equal(info.success, true);
  assert.equal(isolatedRequests, 0);
  const response = await vm.runInContext("fetch('https://unit.invalid/probe').then(r => r.json())", context);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    url: 'https://unit.invalid/probe',
    method: 'GET',
  });
  assert.equal(isolatedRequests, 1);
  const decoderStart = isolatedDecoderCalls;
  const nativeText = await vm.runInContext(
    "fetch('https://unit.invalid/native-json').then(r => r.clone().text())",
    context,
  );
  assert.equal(nativeText, JSON.stringify({ url: 'https://unit.invalid/native-json', method: 'GET' }));
  assert.equal(isolatedDecoderCalls, decoderStart + 1);
  const nativeJson = await vm.runInContext(
    "fetch('https://unit.invalid/native-json').then(r => r.json())",
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(nativeJson)), {
    url: 'https://unit.invalid/native-json',
    method: 'GET',
  });
  assert.equal(isolatedDecoderCalls, decoderStart + 2);

  vm.runInContext(
    'globalThis.__testEncoderCalls = 0; const __originalEncode = TextEncoder.prototype.encode; TextEncoder.prototype.encode = function(...args) { globalThis.__testEncoderCalls++; return __originalEncode.apply(this, args); }',
    context,
  );
  const directJson = await vm.runInContext("new Response('{\"kind\":\"direct\"}').clone().json()", context);
  assert.deepEqual(JSON.parse(JSON.stringify(directJson)), { kind: 'direct' });
  assert.equal(vm.runInContext('globalThis.__testEncoderCalls', context), 0);
  const directTextBuffer = await vm.runInContext("new Response('é').arrayBuffer()", context);
  assert.deepEqual(Array.from(new Uint8Array(directTextBuffer)), [0xc3, 0xa9]);
  assert.equal(vm.runInContext('globalThis.__testEncoderCalls', context), 1);
  const binaryBuffer = await vm.runInContext(
    "fetch('https://unit.invalid/binary-response').then(r => r.clone().arrayBuffer())",
    context,
  );
  assert.deepEqual(Array.from(new Uint8Array(binaryBuffer)), [0, 255, 17, 128]);

  const logStart = isolatedHostLogs.length;
  vm.runInContext("console.log('log'); console.info('info'); console.warn('warn'); console.error('error'); console.debug('debug')", context);
  assert.deepEqual(isolatedHostLogs.slice(logStart).map(entry => entry.level), ['info', 'info', 'warn', 'error', 'debug']);
  assert.deepEqual(nativeConsoleFallback, []);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    assert.equal(vm.runInContext('typeof console.' + method, context), 'function');
  }

  failHostLogs = true;
  const safeSearchFailure = await vm.runInContext(
    "OmniDanmakuEngine.search({ keyword: { toString() { throw new Error('sensitive test detail'); } } })",
    context,
  );
  const safeResolveFailure = await vm.runInContext(
    "OmniDanmakuEngine.resolve({ fileName: { toString() { throw new Error('sensitive test detail'); } } })",
    context,
  );
  failHostLogs = false;
  assert.deepEqual(JSON.parse(JSON.stringify(safeSearchFailure)), {
    success: false, animes: [], errorCode: 'Error', phase: 'search',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(safeResolveFailure)), {
    success: false, items: [], errorCode: 'Error', phase: 'resolve',
  });
  assert.deepEqual(nativeConsoleFallback, ['search failed (Error)', 'resolve failed (Error)']);
  assert.equal(nativeConsoleFallback.some(message => message.includes('sensitive test detail')), false);

  const traceStart = isolatedHostLogs.length;
  const traceResult = await vm.runInContext(
    "OmniDanmakuEngine.resolve({ fileName: '未命中节目 2026 20261010第1期' })",
    context,
  );
  assert.equal(traceResult.success, true);
  const traceMessages = isolatedHostLogs.slice(traceStart)
    .map(entry => entry.message)
    .filter(message => message.startsWith('resolve stage='));
  assert.ok(traceMessages.some(message => /stage=searchEpisodes .*count=0 .*elapsedMs=\d+/.test(message)));
  assert.ok(traceMessages.some(message => /stage=searchAnime .*count=0 .*elapsedMs=\d+/.test(message)));
  assert.ok(traceMessages.some(message => /stage=choice count=0 elapsedMs=\d+/.test(message)));
  assert.ok(traceMessages.some(message => /stage=complete count=0 elapsedMs=\d+/.test(message)));
  assert.equal(traceMessages.some(message => message.includes('https://') || message.includes('未命中节目')), false);

  const beforeUnknownUrl = isolatedRequests;
  const unknownUrlComments = await vm.runInContext(
    "OmniDanmakuEngine.comments({ url: 'https://unknown.example/video/episode-1' })",
    context,
  );
  assert.equal(unknownUrlComments.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(unknownUrlComments.comments)), []);
  assert.equal(isolatedRequests, beforeUnknownUrl);
  assert.equal(isolatedRequestUrls.some(url => /api\.danmu\.icu/i.test(url)), false);
  const gbkText = await vm.runInContext("new TextDecoder('gbk').decode(new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4]))", context);
  assert.equal(gbkText, '中文');
  assert.equal(isolatedDecoderCalls, decoderStart + 3);
});

test('GBK response decoding delegates bytes to the native charset host', () => {
  const text = new TextDecoder('gbk').decode(Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4));
  assert.equal(text, '中文');
  assert.equal(decoderCallCount, 1);
});

test('protobuf varints retain little-endian digits and exact uint64 payloads', () => {
  assert.deepEqual(decodeVarintDecimal(Uint8Array.of(0xac, 0x02), 0), { value: '300', offset: 2 });
  assert.deepEqual(decodeVarintDecimal(Uint8Array.of(0x82, 0x08), 0), { value: '1026', offset: 2 });
  assert.deepEqual(decodeVarintDecimal(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f), 0), {
    value: '9007199254740991', offset: 8,
  });
  assert.deepEqual(decodeVarintDecimal(Uint8Array.of(0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10), 0), {
    value: '9007199254740993', offset: 8,
  });
  assert.deepEqual(decodeVarintDecimal(Uint8Array.of(
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
  ), 0), { value: '18446744073709551615', offset: 10 });
  assert.throws(() => decodeVarintDecimal(Uint8Array.of(
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
  ), 0), /64 bits/);
  assert.throws(() => decodeVarintDecimal(Uint8Array.of(0x80, 0x80), 0), /incomplete/);
});

test('Android Han regex rewrite preserves supplementary Han, groups, and punctuation without u', () => {
  const literal = String.raw`/^[\p{Script=Han}A-Za-z0-9._-]*(?:版|篇|特辑|全纪录|机位|观演区)(?=$|[·._\-：:（）()【】\[\]])/u`;
  const lastSlash = literal.lastIndexOf('/');
  const rewritten = rewritePattern(literal.slice(1, lastSlash), 'u', {
    unicodeFlag: 'transform',
    unicodePropertyEscapes: 'transform',
  });
  assert.doesNotMatch(rewritten, /\\p\{|\\u\{/);
  const compatibilityPattern = new RegExp(rewritten);
  assert.ok(compatibilityPattern.test('中文精华版'));
  assert.ok(compatibilityPattern.test(`${String.fromCodePoint(0x2b740)}精选篇`));
  assert.ok(compatibilityPattern.test('中文全纪录：'));
  assert.ok(compatibilityPattern.test('中文观演区】'));
  assert.equal(compatibilityPattern.test('中文全纪录A'), false);
  assert.equal(compatibilityPattern.test('ひらがな全纪录'), false);
});
