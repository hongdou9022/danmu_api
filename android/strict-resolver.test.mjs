import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  clearLocalDanmakuCatalogCache,
  resolveLocalDanmaku,
} from './strict-resolver.js';

const varietyFixture = JSON.parse(await readFile(
  new URL('./fixtures/variety-real.json', import.meta.url), 'utf8',
));
const bigBrotherFixture = JSON.parse(await readFile(
  new URL('./fixtures/big-brother-search-episodes.json', import.meta.url), 'utf8',
));

function fixturePrograms(query) {
  return varietyFixture.programs.find((item) => item.query === query)?.programs ?? [];
}

function itemId(items) {
  const match = /\/comment\/(\d+)/.exec(items?.[0]?.url ?? '');
  return match ? Number(match[1]) : 0;
}

function makeIo({
  animes = [],
  searchEpisodes = null,
  animeHits = [],
  details = {},
  match = { isMatched: false, matches: [] },
  comments = true,
  base = 'https://local-provider.invalid',
  now = () => Date.now(),
} = {}) {
  const calls = { episodes: 0, anime: 0, bangumi: [], match: 0, comments: [] };
  const io = {
    base,
    now,
    async searchEpisodes(title, year, season, deadlineMs) {
      calls.episodes++;
      calls.lastSearchEpisodes = { title, year, season, deadlineMs };
      if (searchEpisodes instanceof Error) throw searchEpisodes;
      if (typeof searchEpisodes === 'function') return searchEpisodes(title, year, season, deadlineMs);
      return searchEpisodes ?? { success: true, errorCode: 0, animes };
    },
    async searchAnime(title, season, deadlineMs) {
      calls.anime++;
      calls.lastSearchAnime = { title, season, deadlineMs };
      if (animeHits instanceof Error) throw animeHits;
      if (typeof animeHits === 'function') return animeHits(title, season, deadlineMs);
      return { success: true, errorCode: 0, animes: animeHits };
    },
    async getBangumi(id, deadlineMs) {
      calls.bangumi.push({ id, deadlineMs });
      const value = details[id];
      if (value instanceof Error) throw value;
      return value ?? { success: false, errorCode: 1 };
    },
    async matchAnime(fileName, deadlineMs) {
      calls.match++;
      calls.lastMatch = { fileName, deadlineMs };
      if (match instanceof Error) throw match;
      return match;
    },
    async commentHasContent(id, deadlineMs) {
      calls.comments.push({ id, deadlineMs });
      return comments;
    },
  };
  return { io, calls };
}

const episode = (episodeId, episodeTitle, extra = {}) => ({ episodeId, episodeTitle, ...extra });
const datedVariety = (animeTitle, episodes) => ({ animeId: 44001, animeTitle, type: '综艺', episodes });

test('real annual season alias selects the eighth-season middle segment', async () => {
  clearLocalDanmakuCatalogCache();
  const { io, calls } = makeIo({ animes: fixturePrograms('花儿与少年 第八季 2026') });
  const result = await resolveLocalDanmaku(
    '花儿与少年 第八季 2026 20260910第1期中', io,
  );
  assert.equal(itemId(result), 12136);
  assert.equal(calls.episodes, 1);
  assert.equal(calls.anime, 0);
});

test('real dated variety labels select exact parts and special captions', async () => {
  clearLocalDanmakuCatalogCache();
  const catalog = fixturePrograms('披荆斩棘2026');
  const { io } = makeIo({ animes: catalog });
  assert.equal(itemId(await resolveLocalDanmaku(
    '披荆斩棘2026 2026 20260816第1期（下）', io,
  )), 11961);
  clearLocalDanmakuCatalogCache();
  const { io: io2 } = makeIo({ animes: catalog });
  assert.equal(itemId(await resolveLocalDanmaku(
    '披荆斩棘2026 2026 20260815第1期（上）', io2,
  )), 11962);

  clearLocalDanmakuCatalogCache();
  const { io: io3 } = makeIo({ animes: catalog });
  assert.deepEqual(await resolveLocalDanmaku('披荆斩棘2026 2026 超前企划', io3), []);
  clearLocalDanmakuCatalogCache();
  const { io: io4 } = makeIo({ animes: catalog });
  assert.equal(itemId(await resolveLocalDanmaku(
    '披荆斩棘2026 2026 超前企划 周杰伦惊喜助阵', io4,
  )), 11963);
});

test('real no-colon catalog heading resolves the first episode without interpreting its caption', async () => {
  clearLocalDanmakuCatalogCache();
  const catalog = bigBrotherFixture.candidates;
  const { io } = makeIo({ animes: catalog });
  const result = await resolveLocalDanmaku(
    '大哥小助理 2026 20260814(第1期上)', io,
  );
  assert.equal(itemId(result), 12253);

  clearLocalDanmakuCatalogCache();
  const unknownEdition = structuredClone(catalog[1]);
  unknownEdition.episodes = [episode(
    99001,
    '【qiyi】 第0集 第1期上 完整加长版 胡军李乃文懵圈助理0帧上岗 2026-08-14期',
  )];
  const { io: io2 } = makeIo({ animes: [unknownEdition] });
  assert.deepEqual(await resolveLocalDanmaku(
    '大哥小助理 2026 20260814第1期上', io2,
  ), []);
});

test('invalid dates and conflicting seasons fail closed before selection', async () => {
  clearLocalDanmakuCatalogCache();
  const empty = makeIo();
  assert.deepEqual(await resolveLocalDanmaku('综艺A 2026 20260230第1期', empty.io), []);
  assert.equal(empty.calls.episodes, 0);
  assert.equal(empty.calls.anime, 0);

  const wrongSeason = datedVariety('季号节目 第3季(2026)【综艺】', [
    episode(99101, '第1期上：来源内容 2026-10-10期'),
  ]);
  clearLocalDanmakuCatalogCache();
  const { io } = makeIo({ animes: [wrongSeason] });
  assert.deepEqual(await resolveLocalDanmaku('季号节目 第4季 2026 第1期上', io), []);
});

test('same-day up/down parts are conjunctive and ambiguous rows never choose the first', async () => {
  const rows = [
    episode(99201, '第1期上：上半内容 2026-10-10期'),
    episode(99202, '第1期下：下半内容 2026-10-10期'),
  ];
  clearLocalDanmakuCatalogCache();
  const { io } = makeIo({ animes: [datedVariety('分段节目(2026)【综艺】', rows)] });
  assert.equal(itemId(await resolveLocalDanmaku('分段节目 2026 20261010第1期下', io)), 99202);

  clearLocalDanmakuCatalogCache();
  const { io: bareIo } = makeIo({ animes: [datedVariety('分段节目(2026)【综艺】', rows)] });
  assert.deepEqual(await resolveLocalDanmaku('分段节目 2026 20261010', bareIo), []);

  clearLocalDanmakuCatalogCache();
  const ambiguous = datedVariety('分段节目(2026)【综艺】', [
    episode(99203, '第1期上：候选A 2026-10-10期'),
    episode(99204, '第1期上：候选B 2026-10-10期'),
  ]);
  const { io: ambiguousIo } = makeIo({ animes: [ambiguous] });
  assert.deepEqual(await resolveLocalDanmaku('分段节目 2026 20261010第1期上', ambiguousIo), []);
});

test('special editions cannot satisfy a plain program request or vice versa', async () => {
  const catalog = datedVariety('特辑节目(2026)【综艺】', [
    episode(99301, '第1期：正片内容 2026-10-10期'),
    episode(99302, '2026-10-10第1期纯享'),
  ]);
  clearLocalDanmakuCatalogCache();
  const { io } = makeIo({ animes: [catalog] });
  assert.equal(itemId(await resolveLocalDanmaku('特辑节目 2026 20261010第1期纯享', io)), 99302);

  clearLocalDanmakuCatalogCache();
  const { io: plainIo } = makeIo({ animes: [datedVariety('仅特辑(2026)【综艺】', [
    episode(99303, '先导片上：预告内容 2026-10-10期'),
  ])] });
  assert.deepEqual(await resolveLocalDanmaku('仅特辑 2026 20261010', plainIo), []);
});

test('cold discovery uses SearchAnime then at most three GetBangumi calls under one deadline', async () => {
  clearLocalDanmakuCatalogCache();
  const program = fixturePrograms('披荆斩棘2026')[0];
  const { io, calls } = makeIo({
    animes: [],
    animeHits: [{
      animeId: program.animeId,
      animeTitle: program.animeTitle,
      type: program.type,
      year: 2026,
    }],
    details: {
      [program.animeId]: { success: true, errorCode: 0, bangumi: program },
    },
  });
  const result = await resolveLocalDanmaku(
    '披荆斩棘2026 2026 20260815第1期上', io,
  );
  assert.equal(itemId(result), 11962);
  assert.equal(calls.episodes, 1);
  assert.equal(calls.anime, 1);
  assert.deepEqual(calls.bangumi.map((call) => call.id), [program.animeId]);
  assert.equal(calls.lastSearchEpisodes.deadlineMs, calls.lastSearchAnime.deadlineMs);
});

test('only successful non-empty catalogs enter the local cache', async () => {
  clearLocalDanmakuCatalogCache();
  const anime = datedVariety('缓存节目(2026)【综艺】', [episode(99401, '第1期')]);
  const { io, calls } = makeIo({ animes: [anime] });
  assert.equal(itemId(await resolveLocalDanmaku('缓存节目 2026 第1期', io)), 99401);
  assert.equal(itemId(await resolveLocalDanmaku('缓存节目 2026 第1期', io)), 99401);
  assert.equal(calls.episodes, 1);

  clearLocalDanmakuCatalogCache();
  const { io: emptyIo, calls: emptyCalls } = makeIo({ animes: [] });
  assert.deepEqual(await resolveLocalDanmaku('空目录节目 2026 第1集', emptyIo), []);
  assert.deepEqual(await resolveLocalDanmaku('空目录节目 2026 第1集', emptyIo), []);
  assert.equal(emptyCalls.episodes, 2);
});

test('ordinary numbered TV episodes retain ordinal matching', async () => {
  clearLocalDanmakuCatalogCache();
  const anime = {
    animeId: 99501,
    animeTitle: '普通电视剧(2024)',
    type: '电视剧',
    episodes: [episode(99511, '第1集'), episode(99512, '第2集')],
  };
  const { io } = makeIo({ animes: [anime] });
  assert.equal(itemId(await resolveLocalDanmaku('普通电视剧 2024 S01E02', io)), 99512);
});
