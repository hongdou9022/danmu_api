import './host-shim.js';

import { Globals, globals } from '../danmu_api/configs/globals.js';
import {
  searchAnime,
  searchEpisodes,
  getBangumi,
  getComment,
  getCommentByUrl,
} from '../danmu_api/apis/dandan-api.js';
import { Anime } from '../danmu_api/models/dandan-model.js';
import { findUrlById } from '../danmu_api/utils/cache-util.js';
import { base64ToBytes } from '../danmu_api/utils/codec-util.js';
import { resolveLocalDanmaku } from './strict-resolver.js';
import { BoundedLruMap } from './bounded-comment-cache.js';
import { safeErrorInfo } from './safe-error-info.js';

const API_VERSION = 1;
const CACHE_SCHEMA = 1;
const ANDROID_COMMENT_CACHE_ENTRIES = 2;
const ENGINE_VERSION = globalThis.__OMNI_SCRIPT_VERSION__ || '1.21.8-dev';
const BASE = 'https://omni.invalid';
const STATE_KEY = 'omni-danmaku-engine-v1:meta';
const EPISODE_KEY_PREFIX = 'omni-danmaku-engine-v1:episodes:';
const ANIME_KEY_PREFIX = 'omni-danmaku-engine-v1:animes:';
const SELECT_KEY_PREFIX = 'omni-danmaku-engine-v1:selections:';
const CHUNK_SIZE = 256;
let initialized = false;
let operationQueue = Promise.resolve();
let activeDeadlines = [];

function safeLog(level, message) {
  const text = String(message);
  try { globalThis.DanmakuHost.log(level, text); return; } catch (_) {}
  try {
    const logger = globalThis.console && globalThis.console.log;
    if (typeof logger === 'function') logger.call(globalThis.console, text);
  } catch (_) {}
}

function safeErrorCode(error) {
  const code = error && (error.code || error.name) ? String(error.code || error.name) : 'Error';
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : 'Error';
}

function parseArg(input) {
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch (_) { return {}; }
  }
  return input && typeof input === 'object' ? input : {};
}

function modelJson(anime) {
  return anime && typeof anime.toJson === 'function' ? anime.toJson() : anime;
}

function readJson(key) {
  try {
    const raw = globalThis.__dmStorage.get(key);
    return typeof raw === 'string' && raw !== 'null' ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function writeJson(key, value) {
  try { return globalThis.__dmStorage.set(key, JSON.stringify(value)); }
  catch (_) { return false; }
}

function readChunks(prefix, count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const chunk = readJson(`${prefix}${i}`);
    if (Array.isArray(chunk)) result.push(...chunk);
  }
  return result;
}

function writeChunks(prefix, values, previousCount) {
  const count = Math.ceil(values.length / CHUNK_SIZE);
  for (let i = 0; i < count; i++) writeJson(`${prefix}${i}`, values.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  for (let i = count; i < (Number(previousCount) || 0); i++) {
    try { globalThis.__dmStorage.remove(`${prefix}${i}`); } catch (_) {}
  }
  return count;
}

function loadSnapshot() {
  const meta = readJson(STATE_KEY);
  if (!meta || meta.schema !== CACHE_SCHEMA) return;
  try {
    const savedEpisodes = readChunks(EPISODE_KEY_PREFIX, meta.episodeChunks || 0);
    const savedAnimes = readChunks(ANIME_KEY_PREFIX, meta.animeChunks || 0);
    const savedSelections = readChunks(SELECT_KEY_PREFIX, meta.selectionChunks || 0);
    globals.episodeIds = savedEpisodes.filter(row => row && Number.isSafeInteger(Number(row.id)) && row.url);
    globals.episodeNum = Math.max(Number(meta.episodeNum) || 10001, 10001);
    globals.animes = savedAnimes.filter(row => row && typeof row === 'object').map(row => Anime.fromJson(row));
    globals.lastSelectMap = new Map(savedSelections.filter(pair => Array.isArray(pair) && pair.length === 2));
    safeLog('info', `Android cache restored (${globals.animes.length} anime, ${globals.episodeIds.length} episode mappings)`);
  } catch (error) {
    globals.animes = [];
    globals.episodeIds = [];
    globals.episodeNum = 10001;
    globals.lastSelectMap = new Map();
    safeLog('warn', `Android cache restore failed (${safeErrorCode(error)})`);
  }
}

function persistSnapshot() {
  try {
    const old = readJson(STATE_KEY) || {};
    const episodeChunks = writeChunks(EPISODE_KEY_PREFIX, globals.episodeIds || [], old.episodeChunks);
    const animeChunks = writeChunks(ANIME_KEY_PREFIX, (globals.animes || []).map(modelJson), old.animeChunks);
    const selectionChunks = writeChunks(SELECT_KEY_PREFIX, [...(globals.lastSelectMap || new Map()).entries()], old.selectionChunks);
    writeJson(STATE_KEY, { schema: CACHE_SCHEMA, episodeNum: globals.episodeNum, episodeChunks, animeChunks, selectionChunks });
  } catch (error) {
    safeLog('warn', `Android cache persist failed (${safeErrorCode(error)})`);
  }
}

function initialize() {
  if (initialized) return;
  // Only safe, explicit runtime defaults are supplied. No Node env, proxy,
  // custom server, AI, Redis or third-party server secrets are read.
  Globals.init({
    SOURCE_ORDER: 'douban,360,renren,hanjutv',
    DEPLOY_PLATFORM: 'android',
    VOD_REQUEST_TIMEOUT: '10000',
    SEARCH_CACHE_MINUTES: '30',
    TENCENT_CONCURRENCY: '8',
    AI_API_KEY: '',
    PROXY_URL: '',
    OTHER_SERVER: '',
    UPSTASH_REDIS_REST_URL: '',
    UPSTASH_REDIS_REST_TOKEN: '',
    LOCAL_REDIS_URL: '',
  });
  // Envs treats an empty OTHER_SERVER as unset and otherwise restores its
  // public default. Override the resolved config explicitly so unknown video
  // URLs cannot be forwarded to the upstream third-party service.
  globals.otherServer = '';
  globals.commentCache = new BoundedLruMap(ANDROID_COMMENT_CACHE_ENTRIES);
  globals.redisValid = false;
  globals.localRedisValid = false;
  globals.localCacheValid = false;
  globals.aiValid = false;
  globals.logLevel = 'error';
  loadSnapshot();
  initialized = true;
}

async function serial(operation) {
  const run = operationQueue.then(async () => {
    initialize();
    try { return await operation(); }
    finally { persistSnapshot(); }
  });
  // Keep only queue completion state; retaining run's fulfilled value here
  // would keep a large comments array alive until the next engine call.
  operationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function updateActiveDeadline(deadline) {
  activeDeadlines = activeDeadlines.filter(value => value > Date.now());
  if (Number.isFinite(deadline) && deadline > 0) activeDeadlines.push(deadline);
  globalThis.__dmRequestDeadline = activeDeadlines.length ? Math.min(...activeDeadlines) : 0;
}

async function withDeadline(deadline, callback) {
  updateActiveDeadline(deadline);
  try { return await callback(); }
  finally {
    const index = activeDeadlines.indexOf(deadline);
    if (index >= 0) activeDeadlines.splice(index, 1);
    globalThis.__dmRequestDeadline = activeDeadlines.length ? Math.min(...activeDeadlines) : 0;
  }
}

async function responseJson(response) {
  if (!response || typeof response.json !== 'function') return null;
  try { return await response.json(); } catch (_) { return null; }
}

function titleQuery(title, year, season) {
  let query = String(title || '').trim();
  if (season > 0 && !/(?:第\s*\d+\s*季|\bS\d{1,2}\b|\bSeason\s*\d+\b)/i.test(query)) query += ` 第${season}季`;
  if (year > 0 && !/(?:19|20)\d{2}/.test(query)) query += ` (${year})`;
  return query.trim();
}

function resolverProgress(stage, fields = {}) {
  const details = Object.entries(fields).map(([key, value]) => key + '=' + String(value)).join(' ');
  safeLog('info', 'resolve stage=' + stage + (details ? ' ' + details : ''));
}

function makeResolverIO() {
  return {
    base: BASE,
    now: () => Date.now(),
    async searchEpisodes(title, year, season, deadlineMs) {
      return withDeadline(deadlineMs, async () => {
        const startedAt = Date.now();
        try {
          const url = new URL('/api/v2/search/episodes', BASE);
          url.searchParams.set('anime', titleQuery(title, year, season));
          const payload = await responseJson(await searchEpisodes(url));
          resolverProgress('searchEpisodes', {
            success: payload && payload.success === true,
            count: Array.isArray(payload && payload.animes) ? payload.animes.length : 0,
            elapsedMs: Date.now() - startedAt,
          });
          return payload;
        } catch (error) {
          resolverProgress('searchEpisodes', { errorCode: safeErrorCode(error), elapsedMs: Date.now() - startedAt });
          throw error;
        }
      });
    },
    async searchAnime(title, season, deadlineMs) {
      return withDeadline(deadlineMs, async () => {
        const startedAt = Date.now();
        try {
          const url = new URL('/api/v2/search/anime', BASE);
          url.searchParams.set('keyword', String(title || '').trim());
          if (season > 0) url.searchParams.set('season', String(season));
          const payload = await responseJson(await searchAnime(url));
          resolverProgress('searchAnime', {
            success: payload && payload.success === true,
            count: Array.isArray(payload && payload.animes) ? payload.animes.length : 0,
            elapsedMs: Date.now() - startedAt,
          });
          return payload;
        } catch (error) {
          resolverProgress('searchAnime', { errorCode: safeErrorCode(error), elapsedMs: Date.now() - startedAt });
          throw error;
        }
      });
    },
    async getBangumi(id, deadlineMs) {
      return withDeadline(deadlineMs, async () => {
        const startedAt = Date.now();
        try {
          const payload = await responseJson(await getBangumi('/bangumi/' + encodeURIComponent(id)));
          resolverProgress('detail', {
            success: payload && payload.success === true,
            episodeCount: Array.isArray(payload && payload.bangumi && payload.bangumi.episodes)
              ? payload.bangumi.episodes.length
              : 0,
            elapsedMs: Date.now() - startedAt,
          });
          return payload;
        } catch (error) {
          resolverProgress('detail', { errorCode: safeErrorCode(error), elapsedMs: Date.now() - startedAt });
          throw error;
        }
      });
    },
    async commentHasContent(id, deadlineMs) {
      return withDeadline(deadlineMs, async () => {
        const startedAt = Date.now();
        try {
          const response = await getComment('/comment/' + encodeURIComponent(id), 'json', false, null, false);
          const payload = await responseJson(response);
          const count = Array.isArray(payload && payload.comments) ? payload.comments.length : 0;
          resolverProgress('comments', {
            success: Boolean(response && response.ok !== false && payload && payload.success !== false),
            count,
            elapsedMs: Date.now() - startedAt,
          });
          return Boolean(response && response.ok !== false && payload
            && payload.success !== false && count > 0);
        } catch (error) {
          resolverProgress('comments', { errorCode: safeErrorCode(error), elapsedMs: Date.now() - startedAt });
          throw error;
        }
      });
    },
    // The upstream fuzzy matcher can choose a plausible but incorrect season or
    // edition. Android automatic matching intentionally relies on the strict
    // resolver's catalog evidence and leaves uncertain cases to cloud/manual UI.
    async matchAnime() {
      return { success: true, matches: [] };
    },
  };
}

function apiCommentId(url) {
  const match = String(url || '').match(/\/api\/v2\/comment\/(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function originalVideoUrl(value) {
  try {
    const raw = String(value || '');
    const authority = raw.match(/^https?:\/\/([^/?#]+)/i)?.[1] || '';
    if (!authority || authority.includes('@')) return '';
    const url = new URL(raw);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname
      || url.username || url.password || url.hostname === 'omni.invalid') return '';
    return url.toString();
  } catch (_) { return ''; }
}

function normalizeMode(value) {
  const mode = Number(value);
  if (mode === 4 || mode === 1) return mode === 4 ? 1 : 0;
  if (mode === 5) return 2;
  return 0;
}

function normalizeColor(value) {
  if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value.trim())) return `#${value.trim().replace(/^#/, '').toUpperCase()}`;
  const number = Number(value);
  const color = Number.isFinite(number) ? (number >>> 0).toString(16).slice(-6).padStart(6, '0') : 'FFFFFF';
  return `#${color.toUpperCase()}`;
}

function normalizedComments(payload) {
  const input = Array.isArray(payload && payload.comments) ? payload.comments : [];
  return input.slice(0, 20_000).map(item => {
    const p = String(item && item.p || '').split(',');
    const time = Number(item && item.time !== undefined ? item.time : p[0]);
    const rawMode = item && item.mode !== undefined ? item.mode : p[1];
    const rawColor = item && item.color !== undefined ? item.color : p.length >= 8 ? p[3] : p[2];
    return {
      time: Number.isFinite(time) ? time : 0,
      text: String(item && (item.text ?? item.m ?? item.content) || ''),
      mode: normalizeMode(rawMode),
      color: normalizeColor(rawColor),
    };
  }).filter(item => item.text.length > 0);
}

async function binaryDiagnostics() {
  const expectedBytes = [0, 1, 2, 255, 254, 255];
  const response = new Response(null, { bodyBase64: 'AAEC//7/' });
  const buffer = await response.arrayBuffer();
  const view = new Uint8Array(buffer);
  const bytes = Array.from(view);
  const base64 = btoa(String.fromCharCode(...view));
  const roundTrip = Array.from(atob(base64), character => character.charCodeAt(0));
  const codecLength = base64ToBytes('AAEC//7/').length;
  return {
    ok: buffer.byteLength === expectedBytes.length
      && view.length === expectedBytes.length
      && bytes.join(',') === expectedBytes.join(',')
      && roundTrip.join(',') === expectedBytes.join(',')
      && codecLength === expectedBytes.length,
    arrayBufferByteLength: buffer.byteLength,
    uint8ArrayLength: view.length,
    fixedBytes: bytes,
    base64RoundTrip: roundTrip,
    codecBase64Length: codecLength,
  };
}

const Engine = {
  async info(input) {
    return serial(async () => {
      const result = {
        success: true,
        apiVersion: API_VERSION,
        scriptVersion: ENGINE_VERSION,
        minAppVersion: '1.0.20261103_0000',
        cacheSchema: CACHE_SCHEMA,
        sourceOrder: ['douban', '360', 'renren', 'hanjutv'],
        capabilities: { search: true, detail: true, strictResolve: true, commentsById: true, commentsByUrl: true },
        disabled: ['external-danmu-server', 'ai', 'proxy', 'redis', 'local-files', 'custom-source'],
      };
      if (parseArg(input).diagnostics === true) result.diagnostics = await binaryDiagnostics();
      return result;
    });
  },

  async search(input) {
    return serial(async () => {
      try {
        const args = parseArg(input);
        const keyword = String(args.keyword || '').trim();
        if (!keyword) return { success: true, animes: [] };
        const url = new URL('/api/v2/search/anime', BASE);
        url.searchParams.set('keyword', keyword);
        if (Number(args.season) > 0) url.searchParams.set('season', String(Number(args.season)));
        const payload = await responseJson(await searchAnime(url));
        return { success: payload && payload.success === true, animes: Array.isArray(payload && payload.animes) ? payload.animes : [] };
      } catch (error) {
        const errorCode = safeErrorCode(error);
        safeLog('warn', 'search failed (' + errorCode + ')');
        return { success: false, animes: [], errorCode, phase: 'search' };
      }
    });
  },

  async detail(input) {
    return serial(async () => {
      try {
        const args = parseArg(input);
        const animeId = String(args.animeId || '').trim();
        if (!animeId) return { success: false, bangumi: null };
        const payload = await responseJson(await getBangumi(`/bangumi/${encodeURIComponent(animeId)}`));
        const bangumi = payload && payload.bangumi;
        if (bangumi && Array.isArray(bangumi.episodes)) {
          bangumi.episodes = bangumi.episodes.map(episode => ({
            ...episode,
            url: originalVideoUrl(findUrlById(Number(episode && episode.episodeId)) || episode && episode.url),
          }));
        }
        return { success: payload && payload.success === true, bangumi: bangumi || null };
      } catch (error) {
        safeLog('warn', `detail failed (${safeErrorCode(error)})`);
        return { success: false, bangumi: null };
      }
    });
  },

  async resolve(input) {
    return serial(async () => {
      try {
        const args = parseArg(input);
        const fileName = String(args.fileName || '').trim();
        if (!fileName) return { success: true, items: [] };
        const startedAt = Date.now();
        const deadline = Date.now() + 55_000;
        resolverProgress('start');
        const localItems = await withDeadline(deadline, () => resolveLocalDanmaku(fileName, makeResolverIO()));
        resolverProgress('choice', {
          count: Array.isArray(localItems) ? localItems.length : 0,
          elapsedMs: Date.now() - startedAt,
        });
        const items = [];
        for (const item of Array.isArray(localItems) ? localItems : []) {
          const id = apiCommentId(item && item.url);
          if (!id) continue;
          // The resolver's URL is a synthetic danmu-api locator. Only return a
          // real video URL from this engine's ID map; a stale/missing mapping
          // must never be persisted as if it identified the episode.
          const sourceUrl = originalVideoUrl(findUrlById(id));
          items.push({ name: String(item.name || ''), episodeId: id, url: sourceUrl });
        }
        resolverProgress('complete', { count: items.length, elapsedMs: Date.now() - startedAt });
        return { success: true, items };
      } catch (error) {
        const errorCode = safeErrorCode(error);
        safeLog('warn', 'resolve failed (' + errorCode + ')');
        return { success: false, items: [], errorCode, phase: 'resolve' };
      }
    });
  },

  async comments(input) {
    return serial(async () => {
      const startedAt = Date.now();
      try {
        const args = parseArg(input);
        const url = String(args.url || '').trim();
        const episodeId = Number(args.episodeId) || apiCommentId(url);
        let response;
        if (url && /^https?:\/\//i.test(url) && !apiCommentId(url)) response = await getCommentByUrl(url, 'json', false, false);
        else if (episodeId > 0) response = await getComment(`/comment/${episodeId}`, 'json', false, null, false);
        else return { success: false, comments: [] };
        const payload = await responseJson(response);
        const comments = normalizedComments(payload);
        resolverProgress('playbackComments', {
          success: Boolean(response && response.ok !== false && payload && payload.success !== false),
          rawCount: Array.isArray(payload && payload.comments) ? payload.comments.length : 0,
          count: comments.length,
          elapsedMs: Date.now() - startedAt,
        });
        return {
          success: Boolean(response && response.ok !== false && payload && payload.success !== false),
          comments,
        };
      } catch (error) {
        const errorCode = safeErrorCode(error);
        resolverProgress('playbackComments', { errorCode, elapsedMs: Date.now() - startedAt });
        safeLog('warn', 'comments failed (' + errorCode + ') ' + JSON.stringify(safeErrorInfo(error)));
        return { success: false, comments: [] };
      }
    });
  },
};

globalThis.OmniDanmakuEngine = Engine;

// Export for the Node mock-host contract test; the Android bundle is still an IIFE.
export { Engine as OmniDanmakuEngine, normalizedComments };
