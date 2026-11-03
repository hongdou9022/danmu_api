import * as esbuild from 'esbuild';
import { createHash, createSign } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rewritePattern from 'regexpu-core';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(root, process.env.DANMAKU_ANDROID_OUTDIR || 'dist/android');
const apiVersion = 1;
const cacheSchema = 1;
const maxScriptBytes = 8 * 1024 * 1024;
const minAppVersion = process.env.DANMAKU_MIN_APP_VERSION || '1.0.20261103_0000';
const strictResolverHanRegexLiteral = String.raw`/^[\p{Script=Han}A-Za-z0-9._-]*(?:版|篇|特辑|全纪录|机位|观演区)(?=$|[·._\-：:（）()【】\[\]])/u`;

function resolveScriptVersion() {
  const explicit = process.env.DANMAKU_SCRIPT_VERSION;
  const ref = process.env.GITHUB_REF_NAME;
  const tagged = ref && ref.startsWith('android-') ? ref.slice('android-'.length) : '';
  const version = explicit || tagged || `20261103.dev.${process.env.GITHUB_SHA?.slice(0, 8) || 'local'}`;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
    throw new Error('DANMAKU_SCRIPT_VERSION must use 1-64 letters, digits, dots, underscores, or hyphens');
  }
  if (version.toLowerCase() === 'stable') throw new Error('"stable" is reserved for the mutable manifest release pointer');
  return version;
}

function androidCompatibilityPlugin() {
  const localSource = path.join(root, 'danmu_api/sources/local.js');
  const localStore = path.join(root, 'danmu_api/utils/local-danmu-store.js');
  const redisStore = path.join(root, 'danmu_api/utils/redis-util.js');
  const localRedisStore = path.join(root, 'danmu_api/utils/local-redis-util.js');
  const bangumiData = path.join(root, 'danmu_api/utils/bangumi-data-util.js');
  const otherSource = path.join(root, 'danmu_api/sources/other.js');
  const danAny = path.join(root, 'danmu_api/utils/dan-any.js');
  const codecUtil = path.join(root, 'danmu_api/utils/codec-util.js');
  const iqiyiSource = path.join(root, 'danmu_api/sources/iqiyi.js');
  const strictResolver = path.join(root, 'android/strict-resolver.js');
  return {
    name: 'android-danmaku-runtime',
    setup(build) {
      build.onResolve({ filter: /^node:async_hooks$/ }, () => ({ path: 'async-hooks', namespace: 'android-node-shims' }));
      build.onResolve({ filter: /^node:(?:http|https)$/ }, args => ({
        path: args.path.slice('node:'.length), namespace: 'android-node-shims'
      }));
      build.onResolve({ filter: /^(?:node:)?(?:fs|path|stream\/promises|node-fetch)$/ }, args => ({
        path: args.path.replace(/^node:/, ''), namespace: 'android-server-only-modules'
      }));
      build.onResolve({ filter: /(?:^|[\\/])(?:local|local-danmu-store)\.js$/ }, args => {
        const modulePath = path.resolve(args.resolveDir, args.path);
        if (modulePath === localSource) return { path: 'local-source', namespace: 'android-disabled-modules' };
        if (modulePath === localStore) return { path: 'local-store', namespace: 'android-disabled-modules' };
      });
      build.onResolve({ filter: /(?:^|[\\/])(?:redis-util|local-redis-util|bangumi-data-util)\.js$/ }, args => {
        const modulePath = path.resolve(args.resolveDir, args.path);
        if (modulePath === redisStore) return { path: 'redis-store', namespace: 'android-disabled-modules' };
        if (modulePath === localRedisStore) return { path: 'local-redis-store', namespace: 'android-disabled-modules' };
        if (modulePath === bangumiData) return { path: 'bangumi-data', namespace: 'android-disabled-modules' };
      });
      build.onResolve({ filter: /(?:^|[\\/])other\.js$/ }, args => {
        if (path.resolve(args.resolveDir, args.path) === otherSource) {
          return { path: 'other-source', namespace: 'android-disabled-modules' };
        }
      });
      build.onResolve({ filter: /(?:^|[\\/])dan-any\.js$/ }, args => {
        if (path.resolve(args.resolveDir, args.path) === danAny) {
          return { path: 'dan-any-json-only', namespace: 'android-disabled-modules' };
        }
      });
      build.onLoad({ filter: /(?:^|[\\/])strict-resolver\.js$/ }, async args => {
        if (path.resolve(args.path) !== strictResolver) return;
        let contents = await readFile(strictResolver, 'utf8');
        const first = contents.indexOf(strictResolverHanRegexLiteral);
        if (first < 0 || contents.indexOf(strictResolverHanRegexLiteral, first + 1) >= 0) {
          throw new Error('Expected exactly one strict resolver Han regex literal for Android compatibility rewriting.');
        }
        const lastSlash = strictResolverHanRegexLiteral.lastIndexOf('/');
        const flags = strictResolverHanRegexLiteral.slice(lastSlash + 1);
        if (flags !== 'u') throw new Error('The strict resolver Han regex must retain its expected Unicode flag before rewriting.');
        const pattern = strictResolverHanRegexLiteral.slice(1, lastSlash);
        const legacyPattern = rewritePattern(pattern, flags, {
          unicodeFlag: 'transform',
          unicodePropertyEscapes: 'transform',
        });
        if (/\\p\{|\\u\{/.test(legacyPattern)) {
          throw new Error('The strict resolver Han regex still contains unsupported Unicode escapes after rewriting.');
        }
        contents = contents.replace(strictResolverHanRegexLiteral, () => `/${legacyPattern}/`);
        return { contents, loader: 'js', resolveDir: path.dirname(strictResolver) };
      });
      build.onLoad({ filter: /(?:^|[\\/])codec-util\.js$/ }, async args => {
        if (path.resolve(args.path) !== codecUtil) return;
        let contents = await readFile(codecUtil, 'utf8');
        const originalVarint = /function readVarint\(bytes, offset\) \{[\s\S]*?\n\}/;
        const originalLength = /function readLengthDelimited\(bytes, offset\) \{[\s\S]*?\n\}/;
        if (!originalVarint.test(contents) || !originalLength.test(contents)) {
          throw new Error('Could not locate the upstream protobuf varint helpers for the Android compatibility transform.');
        }
        contents = `import { decodeVarintDecimal } from '../../android/protobuf-varint.js';\n${contents}`;
        contents = contents.replace(originalVarint, `function readVarint(bytes, offset) {
  const decoded = decodeVarintDecimal(bytes, offset);
  return [Number(decoded.value), decoded.offset];
}`);
        contents = contents.replace(originalLength, `function readLengthDelimited(bytes, offset) {
  const [length, newOffset] = readVarint(bytes, offset);
  const end = newOffset + length;
  if (!Number.isSafeInteger(length) || length < 0 || end > bytes.length) throw new Error('protobuf length is out of bounds');
  return [bytes.slice(newOffset, end), end];
}`);
        contents = contents.replace('const fieldNumber = key >>> 3;', `if (!Number.isSafeInteger(key) || key < 0) throw new Error('protobuf field tag is invalid');
    const fieldNumber = key >>> 3;`);
        contents = contents.replace('const fieldNumber = tag >>> 3;', `if (!Number.isSafeInteger(tag) || tag < 0) throw new Error('protobuf field tag is invalid');
      const fieldNumber = tag >>> 3;`);
        return { contents, loader: 'js', resolveDir: path.dirname(codecUtil) };
      });
      build.onLoad({ filter: /(?:^|[\\/])iqiyi\.js$/ }, async args => {
        if (path.resolve(args.path) !== iqiyiSource) return;
        let contents = await readFile(iqiyiSource, 'utf8');
        const originalFields = /  _parseIqiyiProtoFields\(bytes\) \{[\s\S]*?\n  \}/;
        const originalVarint = /  _readIqiyiVarint\(bytes, offset\) \{[\s\S]*?\n  \}/;
        if (!originalFields.test(contents) || !originalVarint.test(contents)) {
          throw new Error('Could not locate the upstream iQIYI protobuf helpers for the Android compatibility transform.');
        }
        contents = `import { decodeVarintDecimal } from '../../android/protobuf-varint.js';\n${contents}`;
        contents = contents.replace(originalFields, `  _parseIqiyiProtoFields(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
      const keyResult = this._readIqiyiVarint(bytes, offset);
      const tag = Number(keyResult.value);
      if (!Number.isSafeInteger(tag) || tag < 0) throw new Error('爱奇艺 protobuf 字段标签超出安全范围');
      const number = Math.floor(tag / 8);
      const wireType = tag % 8;
      offset = keyResult.offset;
      if (number === 0) throw new Error('爱奇艺 protobuf 字段号无效');
      if (wireType === 0) {
        const valueResult = this._readIqiyiVarint(bytes, offset);
        fields.push({ number, wireType, value: valueResult.value });
        offset = valueResult.offset;
      } else if (wireType === 1) {
        if (offset + 8 > bytes.length) throw new Error('爱奇艺 protobuf 64 位字段越界');
        fields.push({ number, wireType });
        offset += 8;
      } else if (wireType === 2) {
        const lengthResult = this._readIqiyiVarint(bytes, offset);
        const length = Number(lengthResult.value);
        if (!Number.isSafeInteger(length) || length < 0) throw new Error('爱奇艺 protobuf 字段长度无效');
        offset = lengthResult.offset;
        const end = offset + length;
        if (!Number.isSafeInteger(end) || end > bytes.length) throw new Error('爱奇艺 protobuf 字段长度越界');
        const raw = bytes.subarray(offset, end);
        fields.push({ number, wireType, bytes: raw, value: utf8BytesToString(raw) });
        offset = end;
      } else if (wireType === 5) {
        if (offset + 4 > bytes.length) throw new Error('爱奇艺 protobuf 32 位字段越界');
        fields.push({ number, wireType });
        offset += 4;
      } else {
        throw new Error('爱奇艺 protobuf wire type 无效');
      }
    }
    return fields;
  }`);
        contents = contents.replace(originalVarint, `  _readIqiyiVarint(bytes, offset) {
    return decodeVarintDecimal(bytes, offset);
  }`);
        return { contents, loader: 'js', resolveDir: path.dirname(iqiyiSource) };
      });
      build.onResolve({ filter: /^\.\/dictionary-data$/ }, args => {
        if (/[\\/]node_modules[\\/]brotli[\\/]dec[\\/]dictionary\.js$/.test(args.importer)) {
          return { path: path.join(root, 'node_modules/brotli/dec/dictionary-browser.js') };
        }
      });
      build.onLoad({ filter: /^async-hooks$/, namespace: 'android-node-shims' }, () => ({
        loader: 'js',
        contents: `
          export class AsyncLocalStorage {
            constructor() { this.store = undefined; }
            getStore() { return this.store; }
            run(store, callback, ...args) {
              const previous = this.store;
              this.store = store;
              let value;
              try { value = callback(...args); }
              catch (error) { this.store = previous; throw error; }
              if (value && typeof value.then === 'function') {
                return Promise.resolve(value).finally(() => { if (this.store === store) this.store = previous; });
              }
              this.store = previous;
              return value;
            }
          }
        `
      }));
      build.onLoad({ filter: /^(?:http|https)$/, namespace: 'android-node-shims' }, () => ({
        loader: 'js', contents: 'export default { Agent: class Agent {} };'
      }));
      build.onLoad({ filter: /^(?:fs|path|stream\/promises|node-fetch)$/, namespace: 'android-server-only-modules' }, args => ({
        loader: 'js',
        contents: args.path === 'node-fetch'
          ? 'export default (...args) => globalThis.fetch(...args);'
          : args.path === 'path'
            ? 'export default { join: (...parts) => parts.join("/"), resolve: (...parts) => parts.join("/"), dirname: value => String(value).slice(0, String(value).lastIndexOf("/")) };'
            : args.path === 'stream/promises'
              ? 'export async function pipeline() { throw new Error("streaming is unavailable on Android"); }'
              : 'export default {}; export const promises = {};'
      }));
      build.onLoad({ filter: /^local-source$/, namespace: 'android-disabled-modules' }, () => ({
        loader: 'js', contents: `
          export default class LocalSource {
            async search() { return []; }
            async handleAnimes() { return []; }
            async getComments() { return []; }
            async getSegmentComments() { return []; }
          }
        `
      }));
      build.onLoad({ filter: /^local-store$/, namespace: 'android-disabled-modules' }, () => ({
        loader: 'js', contents: 'export async function findLocalDanmu() { return null; }'
      }));
      build.onLoad({ filter: /^(?:redis-store|local-redis-store)$/, namespace: 'android-disabled-modules' }, () => ({
        loader: 'js', contents: 'export async function setRedisKey() {} export async function updateRedisCaches() {} export async function setLocalRedisKey() {} export async function updateLocalRedisCaches() {}'
      }));
      build.onLoad({ filter: /^bangumi-data$/, namespace: 'android-disabled-modules' }, () => ({
        loader: 'js', contents: 'export async function searchBangumiData() { return []; }'
      }));
      build.onLoad({ filter: /^dan-any-json-only$/, namespace: 'android-disabled-modules' }, () => ({
        loader: 'js',
        contents: 'export const danAnyFormats = []; export function convertDanAny() { return null; }'
      }));
      build.onLoad({ filter: /^other-source$/, namespace: 'android-disabled-modules' }, () => ({
        loader: 'js',
        contents: `
          export default class OtherSource {
            async search() { return []; }
            async getEpisodes() { return []; }
            async handleAnimes() { return []; }
            async getEpisodeDanmu() { return []; }
            async getEpisodeDanmuSegments() { return { type: 'other_server', segmentList: [] }; }
            async getEpisodeSegmentDanmu() { return []; }
            async getComments(_id, _sourceName, segmentFlag = false) {
              return segmentFlag ? { type: 'other_server', segmentList: [] } : [];
            }
            async getSegmentComments() { return []; }
            formatComments(comments) { return Array.isArray(comments) ? comments : []; }
          }
        `
      }));
    }
  };
}

async function writeAtomic(file, contents) {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, contents);
  await rename(temp, file);
}

async function main() {
  const scriptVersion = resolveScriptVersion();
  await mkdir(outDir, { recursive: true });
  const enginePath = path.join(outDir, 'engine.js');
  const manifestPath = path.join(outDir, 'manifest.json');
  const signaturePath = path.join(outDir, 'manifest.sig');
  const engineResult = await esbuild.build({
    entryPoints: [path.join(root, 'android/engine-entry.js')],
    bundle: true,
    minify: process.env.DANMAKU_MINIFY !== 'false',
    treeShaking: true,
    sourcemap: false,
    platform: 'browser',
    // ES2019 forces esbuild to reject any BigInt literal that escaped the
    // Android-only protobuf transforms below.
    target: 'es2019',
    format: 'iife',
    outfile: enginePath,
    legalComments: 'inline',
    metafile: true,
    logLevel: 'info',
    plugins: [androidCompatibilityPlugin()],
    define: {
      'globalThis.__OMNI_SCRIPT_VERSION__': JSON.stringify(scriptVersion),
      'globalThis.__FORWARD_WIDGET__': 'true',
      'process.env.NODE_ENV': '"production"'
    }
  });
  const bytes = await readFile(enginePath);
  if (bytes.length === 0 || bytes.length > maxScriptBytes) {
    throw new Error(`Android engine size ${bytes.length} is outside the supported 1..${maxScriptBytes} byte range`);
  }
  const entryOutput = Object.values(engineResult.metafile.outputs).find(output => output.entryPoint);
  const bundledInputs = Object.entries(entryOutput?.inputs || {})
    .filter(([, detail]) => Number(detail.bytesInOutput) > 0)
    .map(([file]) => file.replaceAll('\\', '/'));
  if (bundledInputs.some(file => /(?:^|\/)node_modules\/(?:node-fetch|redis|@redis)\//.test(file)
    || /node_modules\/@dan-uni\/dan-any\//.test(file))) {
    throw new Error('Android bundle unexpectedly includes server-only fetch/redis or dan-any conversion modules');
  }

  const manifest = {
    apiVersion,
    scriptVersion,
    minAppVersion,
    cacheSchema,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    url: `https://github.com/hongdou9022/danmu_api/releases/download/android-${scriptVersion}/engine.js`
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeAtomic(manifestPath, manifestBytes);

  const privateKey = process.env.DANMAKU_SIGNING_PRIVATE_KEY;
  if (privateKey) {
    const signer = createSign('RSA-SHA256');
    signer.update(manifestBytes);
    signer.end();
    await writeAtomic(signaturePath, `${signer.sign(privateKey).toString('base64')}\n`);
  } else {
    await rm(signaturePath, { force: true });
  }
  console.log(`Android danmaku bundle ${scriptVersion}: ${bytes.length} bytes; manifest sha256 ${manifest.sha256}`);
}

main().catch(error => {
  console.error(`Android danmaku build failed: ${error && error.message ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
