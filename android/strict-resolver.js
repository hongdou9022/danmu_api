// Strict local danmaku resolver for the Android QuickJS provider.
// Rule source: omnibox/cloudtv_js/src/services/danmu.ts, last changed at
// 8dfd56b667972d93fc4c6b6576aeb85d3aad1cca (2026-11-02).
// Extracted query/selection helpers are intentionally kept mechanically aligned.
// Sync when the source commit changes and run the shared strict fixture suite.
// No D1, Cloudflare Cache API, fetch, or credentials are used in this module.
const RESOLVE_BUDGET_MS = 55_000;
const RESOLVE_SEARCH_TIMEOUT_MS = 23_000;
const RESOLVE_MATCH_TIMEOUT_MS = 5_000;
const MAX_BANGUMI_DISCOVERY = 3;
const CATALOG_FRESH_MS = 15 * 60 * 1000;
const CATALOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOCAL_CATALOG_MAX_KEYS = 64;
const localCatalogCache = new Map();
const SE_RE = /S\d{1,2}E(\d{1,4})(?:\D|$)/i;
const CN_EP_RE = /第\s*(\d{1,4})\s*[集话話期]/;
const ORDINARY_EPISODE_TITLE_RE = /^第\s*(?:[1-9]|[1-9]\d)\s*[集话話期]$/;
const EP_RE = /(?:^|[.\s_-])EP?\s*(\d{1,4})(?:[.\s_-]|$)/i;
const YEAR_RE = /(?:^|[.\s_\-（(])((?:19|20)\d{2})(?:[.\s_\-）)]|$)/;
const SEASON_CN_RE = /第\s*([0-9一二三四五六七八九十]+)\s*季/g;
const SEASON_EN_RE = /\bSeason\s*(\d{1,2})\b/gi;
const SEASON_S_RE = /\bS(\d{1,2})(?=E\d{1,4}(?:\D|$)|\b)/gi;
const SPECIAL_LABELS = [
  { kind: '超前企划', pattern: /超前企划/g },
  { kind: '纯享', pattern: /纯享(?:版)?/g },
  { kind: '花絮', pattern: /花絮(?:特辑|版)?/g },
  { kind: '回顾特辑', pattern: /回顾(?:特辑)?/g },
  { kind: '先导片', pattern: /先导(?:片)?/g },
  { kind: '预告', pattern: /预告(?:片)?/g },
  { kind: '企划', pattern: /企划/g },
  { kind: '超前彩蛋', pattern: /超前彩蛋/g },
  { kind: '首映篇', pattern: /首映篇/g },
  { kind: '送机篇', pattern: /送机篇/g },
  { kind: '超前营业', pattern: /超前营业/g },
  { kind: '陪看记', pattern: /(?:七福)?陪看(?:记)?/g },
  { kind: '正片加码', pattern: /正片加码/g },
  { kind: '直播回放', pattern: /直播回放/g },
  { kind: '还有加更', pattern: /还有加更/g },
]         ;
const SE_DATE_RE = /S\d{1,2}E(\d{8})(?!\d)/i;
const CN_DATE_RE = /第\s*(\d{8})\s*期/;
const BARE_DATE_RE = /(^|[^0-9])(\d{8})([^0-9]|$)/g;
const SHORT_DATE_LIKE_RE = /(^|[\s._-])(\d{6})(?=$|[\s._\-上中下期日])/g;
const SEPARATED_DATE_RE = /(^|[^0-9])((?:19|20)\d{2})[-./年](\d{1,2})[-./月](\d{1,2})日?([^0-9]|$)/g;
const DATE_QUALIFIER_WORD_RE = /^(沉浸版|沉浸|加更版|加更期|加更|抢鲜版|抢鲜|正片|番外版|番外|上半|上篇|上集|上期|上|中半|中篇|中集|中期|中|下半|下篇|下集|下期|下)/;
const DATE_QUALIFIER_NUMBER_RE = /^[-_.\s]*(?:第\s*(0?[1-9]|[1-9]\d)\s*期|[-_. ]?(0?[1-9]|[1-9]\d))/;
const BRACKET_RE = /[\(（\[【][^\)）\]】]*[\)）\]】]/g;
const FROM_RE = /\s*from\s+[^\s.]+/gi;
const QUALITY_RE = /(?:^|[.\s_-])(?:2160p|1080p|720p|4k|8k|web[- ]?dl|bluray|blu-ray|hdtv|remux|h\.?26[45]|x26[45]|hevc|avc|aac|ddp?|dts|hdr|dv)(?:[.\s_-]|$)/gi;
const PROGRAM_EPISODE_RE = /第\s*(\d{1,8})\s*期/g;
const EDITION_LABEL_RE = /沉浸(?:版)?|加更(?:版|期)?|抢鲜(?:版)?|番外(?:版)?|正片/g;
















































































function num(value         )         {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function textOf(value         )         {
  return typeof value === 'string' ? value.trim() : '';
}

function chineseNumber(value        )         {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  const digits                         = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  for (const ch of value) {
    if (ch === '十') {
      if (total === 0) total = 1;
      total *= 10;
    } else if (digits[ch]) {
      total += digits[ch];
    }
  }
  return total;
}

function seasonLabels(value        )                {
  const labels                = [];
  const addMatches = (re        , groupIndex        , convert                           ) => {
    re.lastIndex = 0;
    for (const match of value.matchAll(re)) {
      const season = convert(match[groupIndex] ?? '');
      if (season > 0) labels.push({
        index: match.index,
        end: match.index + match[0].length,
        raw: match[0],
        season,
      });
    }
  };
  addMatches(SEASON_CN_RE, 1, chineseNumber);
  addMatches(SEASON_EN_RE, 1, (token) => Number.parseInt(token, 10));
  addMatches(SEASON_S_RE, 1, (token) => Number.parseInt(token, 10));
  return labels.sort((a, b) => a.index - b.index || a.end - b.end);
}

function seasonInfoFromTitle(value        )             {
  const seasons = [...new Set(seasonLabels(value).map((label) => label.season))];
  return {
    season: seasons.length === 1 ? seasons[0] : 0,
    conflict: seasons.length > 1,
  };
}

function seasonValue(value         )         {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 100) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{1,2}$/.test(text)) return Number.parseInt(text, 10);
    const info = seasonInfoFromTitle(text);
    return info.conflict ? 0 : info.season;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const record = value                           ;
  const values = ['season', 'seasonNumber', 'season_number', 'number']
    .map((key) => seasonValue(record[key]))
    .filter((item) => item > 0);
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : 0;
}

function seasonInfoFromRecord(record                         , titleFallback = '')             {
  const animeTitle = textOf(record.animeTitle) || titleFallback;
  const episodeTitle = textOf(record.episodeTitle);
  const titleSeasons = [
    ...seasonLabels(animeTitle).map((label) => label.season),
    ...seasonLabels(episodeTitle).map((label) => label.season),
  ];
  const metadataSeasons = ['season', 'seasonNumber', 'season_number']
    .map((key) => seasonValue(record[key]))
    .filter((item) => item > 0);
  const all = [...new Set([...titleSeasons, ...metadataSeasons])];
  return {
    season: all.length === 1 ? all[0] : 0,
    conflict: all.length > 1,
  };
}

function stripSpecialLabels(value        )         {
  let result = value;
  for (const label of SPECIAL_LABELS) result = result.replace(new RegExp(label.pattern.source, 'g'), ' ');
  return result;
}

function normalizedSpecialText(value        , seriesTitle = '')         {
  let result = value
    .replace(/^(?:【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*/, ' ')
    .replace(new RegExp(SE_DATE_RE.source, 'gi'), ' ')
    .replace(new RegExp(CN_DATE_RE.source, 'g'), ' ')
    .replace(new RegExp(SEPARATED_DATE_RE.source, 'g'), ' ')
    .replace(/(?<!\d)\d{8}(?!\d)/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(new RegExp(YEAR_RE.source, 'g'), ' ')
    .replace(SEASON_CN_RE, ' ')
    .replace(SEASON_EN_RE, ' ')
    .replace(SEASON_S_RE, ' ')
    .replace(new RegExp(PROGRAM_EPISODE_RE.source, 'g'), ' ')
    .replace(new RegExp(SE_RE.source, 'gi'), ' ')
    .replace(new RegExp(CN_EP_RE.source, 'g'), ' ')
    .replace(new RegExp(EP_RE.source, 'gi'), ' ');
  result = stripSpecialLabels(result).replace(EDITION_LABEL_RE, ' ');
  result = result.replace(/(?:^|[\s._\-·：:（）()【】\[\]/\\])(?:上半|上篇|上集|上期|上|中半|中篇|中集|中期|中|下半|下篇|下集|下期|下)(?=$|[\s._\-·：:（）()【】\[\]/\\])/g, ' ');
  result = result.replace(/^(?:【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*/, ' ')
    .replace(FROM_RE, ' ');
  const normalized = result.replace(/[\s._\-·：:（）()【】\[\]/\\，,、]+/g, '').toLowerCase();
  const normalizedSeries = seriesTitle
    ? normalizeTitle(seriesTitle).replace(/[\s._\-·：:（）()【】\[\]/\\，,、]+/g, '').toLowerCase()
    : '';
  return normalizedSeries && normalized.startsWith(normalizedSeries)
    ? normalized.slice(normalizedSeries.length)
    : normalized;
}

function specialLabelMatches(value        )                                                      {
  const matches                                                      = [];
  for (const label of SPECIAL_LABELS) {
    const pattern = new RegExp(label.pattern.source, 'g');
    for (const match of value.matchAll(pattern)) {
      const start = match.index ?? 0;
      matches.push({ kind: label.kind, start, end: start + match[0].length });
    }
  }
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const selected                 = [];
  for (const match of matches) {
    const overlapping = selected.find((item) => match.start < item.end && item.start < match.end);
    if (overlapping) continue;
    selected.push(match);
  }
  return selected;
}

function specialInfoFromContext(
  context        ,
  seriesTitle = '',
  fullLabel = '',
)                                  {
  const matches = specialLabelMatches(context);
  const kinds = [...new Set(matches.map((match) => match.kind))];
  if (kinds.length === 0) return { kind: '', title: '' };
  if (kinds.length > 1) return { kind: '!ambiguous-special', title: '' };
  const marker = matches[0];
  const left = context.slice(0, marker.start).split(/[:：]/).at(-1) ?? '';
  const right = context.slice(marker.end).split(/[:：]/, 1)[0] ?? '';
  const colon = fullLabel.search(/[:：]/);
  const afterColon = colon >= 0 ? fullLabel.slice(colon + 1).split(/[:：]/, 1)[0] : '';
  const title = normalizedSpecialText(right, seriesTitle)
    || normalizedSpecialText(left, seriesTitle)
    || normalizedSpecialText(afterColon, seriesTitle);
  return { kind: kinds[0], title };
}

function stripSeasonLabels(value        )         {
  let result = value;
  for (const label of seasonLabels(value).sort((a, b) => b.index - a.index)) {
    result = `${result.slice(0, label.index)} ${result.slice(label.end)}`;
  }
  return result;
}

function cleanTitle(value        )         {
  let title = value.trim();
  const dot = title.lastIndexOf('.');
  if (dot > 0) {
    const ext = title.slice(dot + 1).toLowerCase();
    if (ext.length >= 2 && ext.length <= 5 && !/[0-9 ]/.test(ext)) title = title.slice(0, dot);
  }
  title = title.replace(BRACKET_RE, ' ').replace(FROM_RE, ' ').replace(QUALITY_RE, ' ');
  return title.replace(/[._\-·：:（）()【】\[\]/]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value        )         {
  return value
    .replace(BRACKET_RE, '')
    .replace(FROM_RE, '')
    .replace(YEAR_RE, '')
    .replace(/(?:第\s*[0-9一二三四五六七八九十]+\s*季|\bSeason\s*\d{1,2}\b|\bS\d{1,2}(?=E\d{1,4}(?:\D|$)|\b))/gi, '')
    .replace(/[\s._\-·：:（）()【】\[\]/]/g, '')
    .toLowerCase();
}

function validDate(year        , month        , day        )          {
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function dateQualifier(value        )         {
  let rest = value.trim();
  while (rest) {
    const separator = Math.max(rest.lastIndexOf(' '), rest.lastIndexOf('.'), rest.lastIndexOf('_'), rest.lastIndexOf('-'));
    if (separator < 0) break;
    const suffix = rest.slice(separator + 1).toLowerCase();
    if (isDateFilenameSuffix(suffix)) {
      rest = rest.slice(0, separator);
      continue;
    }
    break;
  }
  while (rest.startsWith('期') || rest.startsWith('日')) rest = rest.slice(1);
  const qualifiers           = [];
  while (rest) {
    const numberMatch = DATE_QUALIFIER_NUMBER_RE.exec(rest);
    if (numberMatch) {
      const end = numberMatch[0].length;
      if (/\d/.test(rest[end] ?? '')) return '';
      const number = Number.parseInt(numberMatch[1] || numberMatch[2], 10);
      if (number === 1) qualifiers.push('上');
      else if (number === 2) qualifiers.push('下');
      rest = rest.slice(end);
      continue;
    }
    const wordMatch = DATE_QUALIFIER_WORD_RE.exec(rest);
    if (wordMatch) {
      const token = wordMatch[1];
      const normalized = token.startsWith('沉浸')
        ? '沉浸'
        : token.startsWith('加更')
          ? '加更'
          : token.startsWith('抢鲜')
            ? '抢鲜'
          : token.startsWith('番外')
            ? '番外'
              : ['上半', '上篇', '上集', '上期'].includes(token)
                ? '上'
                : ['中半', '中篇', '中集', '中期'].includes(token)
                  ? '中'
                  : ['下半', '下篇', '下集', '下期'].includes(token)
                    ? '下'
            : token === '正片'
              ? ''
              : token;
      if (normalized) qualifiers.push(normalized);
      rest = rest.slice(token.length);
      continue;
    }
    const trimmed = rest.replace(/^[\s._\-/\\()（）\[\]【】，,、]+/, '');
    if (trimmed === rest) {
      const unknown = rest.trim().replace(/\s+/g, ' ');
      if (unknown) qualifiers.push(`!${unknown}`);
      break;
    }
    rest = trimmed;
  }
  return qualifiers.sort().join('+');
}

function mergeDateQualifiers(...values          )         {
  return [...new Set(values.flatMap((value) => value.split('+')).filter(Boolean))].sort().join('+');
}

function editionQualifier(value        )         {
  const qualifiers           = [];
  const editionText = value.replace(/还有加更/g, ' ');
  for (const [pattern, qualifier] of [
    [/沉浸(?:版)?/g, '沉浸'],
    [/加更(?:版|期)?/g, '加更'],
    [/抢鲜(?:版)?/g, '抢鲜'],
    [/番外(?:版)?/g, '番外'],
  ]         ) {
    if (pattern.test(editionText)) qualifiers.push(qualifier);
    pattern.lastIndex = 0;
  }
  return qualifiers.sort().join('+');
}

function stripEditionLabels(value        )         {
  return cleanTitle(value.replace(EDITION_LABEL_RE, ' '));
}

function episodeHeading(title        )         {
  const colon = title.search(/[:：]/);
  let heading = (colon >= 0 ? title.slice(0, colon) : title).trim();
  while (heading) {
    const withoutProvider = heading.replace(/^(?:【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*/, '');
    if (withoutProvider === heading) break;
    heading = withoutProvider.trim();
  }
  if (colon >= 0) return heading;

  // Some sources omit the colon and append the episode synopsis directly:
  // `第1期上 胡军... 2026-08-14期`. Keep the structural heading so synopsis
  // text does not become an unknown edition qualifier. The `第0集` prefix is
  // only a provider decoration when it is immediately followed by a program
  // episode label.
  heading = heading.replace(/^第\s*0\s*集\s+(?=第\s*\d{1,4}\s*期)/, '');
  const ordinal = /^(第\s*\d{1,4}\s*期)/.exec(heading);
  if (!ordinal) return heading;

  let structural = ordinal[0];
  let remainder = heading.slice(ordinal[0].length);
  const part = /^[\s._-]*(上半|上篇|上集|上期|上|中半|中篇|中集|中期|中|下半|下篇|下集|下期|下|[（(]\s*(上|中|下)\s*[）)])/.exec(remainder);
  if (part) {
    const afterPart = remainder.slice(part[0].length);
    const afterPartText = afterPart.trimStart();
    if (!afterPartText || /^[\s._\-·：:（）()【】\[\]]/.test(afterPart)
      || episodeHeadingMarkerToken(afterPartText)) {
      structural += part[0].trim();
      remainder = afterPart;
    }
  }

  const suffix = remainder.trim();
  if (!suffix) return structural;
  const marker = episodeHeadingMarkerToken(suffix);
  return marker ? `${structural} ${marker}` : structural;
}

function episodeHeadingMarkerToken(value        )         {
  const token = /^\S+/.exec(value)?.[0] ?? '';
  if (!token) return '';
  const probe = token.replace(/^[·._\-：:（）()【】\[\]]+/, '');
  if (!probe) return '';
  if (specialLabelMatches(probe).some((match) => match.start === 0)) return token;
  if (/^(?:沉浸(?:版)?|加更(?:版|期)?|抢鲜(?:版)?|番外(?:版)?)(?=$|[·._\-：:（）()【】\[\]])/.test(probe)) return token;
  if (/^(?:母带\d*|精华(?:版|篇|片)?|特辑\d*)(?=$|[·._\-：:（）()【】\[\]])/.test(probe)) return token;
  if (/^[\p{Script=Han}A-Za-z0-9._-]*(?:版|篇|特辑|全纪录|机位|观演区)(?=$|[·._\-：:（）()【】\[\]])/u.test(probe)) return token;
  return '';
}

function programEpisodeNumber(value        )         {
  PROGRAM_EPISODE_RE.lastIndex = 0;
  for (const match of value.matchAll(PROGRAM_EPISODE_RE)) {
    if (match[1].length >= 8) continue;
    const number = Number.parseInt(match[1], 10);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function stripDateLabels(value        )         {
  return value
    .replace(/S\d{1,2}E\d{8}(?!\d)/gi, ' ')
    .replace(/第\s*\d{8}\s*期/g, ' ')
    .replace(/(?:19|20)\d{2}[-./年]\d{1,2}[-./月]\d{1,2}日?/g, ' ')
    .replace(/(^|[^0-9])\d{8}([^0-9]|$)/g, '$1 $2');
}

function explicitDatePartQualifier(value        )         {
  const rest = stripDateLabels(value)
    .replace(PROGRAM_EPISODE_RE, ' ')
    .replace(new RegExp(SPECIAL_LABELS.map((label) => label.pattern.source).join('|'), 'g'), ' ')
    .replace(EDITION_LABEL_RE, ' ');
  const partPattern = /(?:^|[（(【\[\s._-])(上半|上篇|上集|上期|上|中半|中篇|中集|中期|中|下半|下篇|下集|下期|下)(?=$|[）)】\]\s._-])/g;
  const parts = [...rest.matchAll(partPattern)].map((match) =>
    match[1].startsWith('上') ? '上' : match[1].startsWith('中') ? '中' : '下',
  );
  const unique = [...new Set(parts)];
  return unique.length === 1 ? unique[0] : unique.length > 1 ? '!ambiguous-part' : '';
}

function explicitEpisodeTokenPart(value        )         {
  const match = /S\d{1,2}E\d{1,4}([\s._-]*(?:上半|上篇|上集|上期|上|中半|中篇|中集|中期|中|下半|下篇|下集|下期|下))$/i.exec(value);
  if (!match) return '';
  return match[1].includes('上') ? '上' : match[1].includes('中') ? '中' : '下';
}

function hasExplicitDatePart(value        )          {
  return explicitDatePartQualifier(value) !== '';
}

function episodeHeadingQualifier(title        )         {
  if (!/[:：]/.test(title)) return '';
  const heading = episodeHeading(title);
  if (!heading) return '';

  const episodePrefix = /^第\s*(\d{1,3})\s*期(.*)$/.exec(heading);
  if (episodePrefix) {
    const episodeNumber = Number.parseInt(episodePrefix[1], 10);
    const suffix = episodePrefix[2].trim();
    const suffixQualifier = dateQualifier(suffix);
    if (hasExplicitDatePart(suffix)) return suffixQualifier;
    if (episodeNumber === 1 || episodeNumber === 2) {
      return mergeDateQualifiers(episodeNumber === 1 ? '上' : '下', suffixQualifier);
    }
    return suffixQualifier;
  }

  return dateQualifier(heading);
}

function isDateFilenameSuffix(value        )          {
  return new Set([
    'mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm2ts',
    '2160p', '1080p', '720p', '480p', '4k', '8k', 'web-dl', 'webdl', 'bluray', 'hdtv',
    'h264', 'h265', 'x264', 'x265', 'hevc', 'avc', 'aac', 'dts', 'hdr', 'dv',
  ]).has(value);
}

function hasDateLikeLabel(value        )          {
  if (SE_DATE_RE.test(value) || CN_DATE_RE.test(value)) return true;
  BARE_DATE_RE.lastIndex = 0;
  if (BARE_DATE_RE.test(value)) return true;
  SEPARATED_DATE_RE.lastIndex = 0;
  return SEPARATED_DATE_RE.test(value);
}

function hasUnexpandedShortDateLike(value        )          {
  SHORT_DATE_LIKE_RE.lastIndex = 0;
  for (const match of value.matchAll(SHORT_DATE_LIKE_RE)) {
    const token = match[2];
    const month = Number.parseInt(token.slice(2, 4), 10);
    if (month >= 1 && month <= 12) return true;
  }
  return false;
}

function findDateLabel(value        )                        {
  let best                        = null;
  const consider = (
    start        ,
    qualifierStart        ,
    yearText        ,
    monthText        ,
    dayText        ,
    end        ,
  ) => {
    const year = Number.parseInt(yearText, 10);
    const month = Number.parseInt(monthText, 10);
    const day = Number.parseInt(dayText, 10);
    if (!validDate(year, month, day)) return;
    const candidate                 = {
      date: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
      qualifier: dateQualifier(value.slice(qualifierStart)),
      start,
      end,
    };
    if (!best || candidate.start < best.start || (candidate.start === best.start && candidate.end > best.end)) {
      best = candidate;
    }
  };

  const compactDate = (token        )                                  => {
    if (token.length !== 8) return null;
    return [token.slice(0, 4), token.slice(4, 6), token.slice(6, 8)];
  };
  for (const re of [SE_DATE_RE, CN_DATE_RE]) {
    const match = re.exec(value);
    if (!match) continue;
    const dateParts = compactDate(match[1]);
    if (!dateParts) continue;
    const yearStart = match.index + match[0].indexOf(match[1]);
    const end = yearStart + match[1].length;
    const qualifierStart = re === CN_DATE_RE ? match.index + match[0].length : end;
    consider(match.index, qualifierStart, ...dateParts, end);
  }

  BARE_DATE_RE.lastIndex = 0;
  for (const match of value.matchAll(BARE_DATE_RE)) {
    const dateParts = compactDate(match[2]);
    if (!dateParts) continue;
    const yearStart = match.index + match[1].length;
    const end = yearStart + match[2].length;
    consider(yearStart, end, ...dateParts, end);
  }

  SEPARATED_DATE_RE.lastIndex = 0;
  for (const match of value.matchAll(SEPARATED_DATE_RE)) {
    const yearStart = match.index + match[1].length;
    const monthStart = yearStart + match[2].length + 1;
    const dayStart = monthStart + match[3].length + 1;
    const dayEnd = dayStart + match[4].length;
    consider(yearStart, dayEnd, match[2], match[3], match[4], dayEnd);
  }
  return best;
}

function explicitLegacyDateOrdinalAlias(value        , dateLabel                       )         {
  if (!dateLabel) return '';
  const suffix = value.slice(dateLabel.end);
  const match = /^\s*(?:期\s*)?第0([12])期/.exec(suffix)
    ?? /^\s*[-_. ]+0([12])(?:期)?(?=$|[\s._-])/.exec(suffix);
  if (!match) return '';
  return match[1] === '1' ? '上' : '下';
}

function episodeDateInfo(
  episode                         ,
  candidateAnimeTitle = '',
)                                                                             {
  const title = textOf(episode.episodeTitle);
  const animeTitle = textOf(episode.animeTitle) || candidateAnimeTitle;
  const parentYearMatch = YEAR_RE.exec(animeTitle);
  const parentYear = parentYearMatch ? Number.parseInt(parentYearMatch[1], 10) : 0;
  let metadataDate                        = null;
  let placeholderAirDate = false;
  let invalidMetadataDate = false;
  for (const key of ['date', 'airDate', 'air_date', 'episodeDate', 'episode_date', 'releaseDate', 'release_date']) {
    const raw = textOf(episode[key]);
    if (!raw) continue;
    const parsed = findDateLabel(raw);
    if (parsed) {
      metadataDate = parsed;
      placeholderAirDate = (key === 'airDate' || key === 'air_date')
        && /^\d{4}-01-01$/.test(parsed.date);
      break;
    }
    if (hasDateLikeLabel(raw)) {
      invalidMetadataDate = true;
      break;
    }
  }
  const titleDate = findDateLabel(title);
  if (invalidMetadataDate || (hasDateLikeLabel(title) && !titleDate)) {
    return { value: null, state: 'invalid' };
  }
  let qualifier = '';
  let date = '';
  if (titleDate) {
    if (metadataDate && titleDate.date !== metadataDate.date
      && !(placeholderAirDate && titleDate.date.slice(0, 4) === metadataDate.date.slice(0, 4))) {
      return { value: null, state: 'invalid' };
    }
    // Some catalog rows use same-year January 1 as a placeholder airDate. The
    // explicit date embedded in episodeTitle is the usable per-episode date.
    date = titleDate.date;
    const cleanTitle = stripSpecialLabels(title);
    const cleanTitleDate = findDateLabel(cleanTitle);
    qualifier = mergeDateQualifiers(cleanTitleDate?.qualifier ?? titleDate.qualifier, episodeHeadingQualifier(cleanTitle));
  } else if (!ORDINARY_EPISODE_TITLE_RE.test(title)) {
    const cleanTitle = stripSpecialLabels(title);
    qualifier = title.search(/[:：]/) >= 0 ? episodeHeadingQualifier(cleanTitle) : dateQualifier(cleanTitle);
  }
  const undatedPlaceholderAirDate = placeholderAirDate
    && parentYear > 0
    && Number.parseInt(metadataDate?.date.slice(0, 4) ?? '0', 10) === parentYear;
  if (!titleDate && metadataDate && !undatedPlaceholderAirDate) date = metadataDate.date;
  qualifier = mergeDateQualifiers(qualifier, editionQualifier(animeTitle));
  if (date) return { value: [date, qualifier], state: 'dated' };
  return { value: null, state: 'undated' };
}

function episodeDate(episode                         , candidateAnimeTitle = '')                          {
  return episodeDateInfo(episode, candidateAnimeTitle).value;
}

function catalogTitleParts(value        , year = 0, season = 0)                                                              {
  const yearMatch = YEAR_RE.exec(value);
  const seasonInfo = seasonInfoFromTitle(value);
  const resolvedYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : year;
  const resolvedSeason = seasonInfo.season || season;
  const base = stripSeasonLabels(value)
    .replace(FROM_RE, ' ')
    .replace(EDITION_LABEL_RE, ' ')
    .replace(YEAR_RE, ' ')
    .replace(BRACKET_RE, ' ')
    .replace(/[\s._\-·：:（）()【】\[\]/]/g, '')
    .toLowerCase();
  return {
    base,
    year: resolvedYear,
    season: resolvedSeason,
    key: `${base}|y${resolvedYear}|s${resolvedSeason}`,
  };
}

function annualVarietySeasonAlias(
  anime                         ,
  title        ,
  query            ,
)          {
  if (query.season <= 0 || query.year <= 0 || !isVarietyAnime(anime, title)) return false;
  const season = seasonInfoFromRecord(anime, title);
  if (season.conflict || season.season > 0 || recordYear(anime, title) !== query.year) return false;

  const unwrapped = title.replace(FROM_RE, ' ').replace(BRACKET_RE, ' ').trim();
  const annual = /((?:19|20)\d{2})\s*$/.exec(unwrapped);
  if (!annual || Number.parseInt(annual[1], 10) !== query.year) return false;
  const candidateBase = catalogTitleParts(unwrapped.slice(0, annual.index)).base;
  const queryBase = catalogTitleParts(query.title, query.year, query.season).base;
  return !!candidateBase && candidateBase === queryBase;
}


function qualifierPart(value        )         {
  const parts = [...new Set(value.split('+').filter((part) => part === '上' || part === '中' || part === '下'))];
  return parts.length === 1 ? parts[0] : parts.length > 1 ? '!ambiguous-part' : '';
}

function programEpisodeRows(options                   )                    {
  const uniqueOptions = new Map                         ();
  for (const option of options) {
    const id = num(option.episode.episodeId);
    const key = id > 0
      ? `id:${id}`
      : `title:${textOf(option.animeTitle)}|${textOf(option.episode.episodeTitle)}`;
    if (!uniqueOptions.has(key)) uniqueOptions.set(key, option);
  }

  const rows                    = [...uniqueOptions.values()].map((option) => {
    const title = textOf(option.episode.episodeTitle);
    const heading = episodeHeading(title);
    const animeTitle = textOf(option.episode.animeTitle) || option.animeTitle;
    const dateInfo = episodeDateInfo(option.episode, animeTitle);
    const parsedDate = dateInfo.value;
    const dateSuffixQualifier = findDateLabel(stripSpecialLabels(title))?.qualifier ?? '';
    const titleParts = catalogTitleParts(animeTitle);
    const episodeSeason = seasonInfoFromRecord(option.episode, animeTitle);
    const headingPart = explicitDatePartQualifier(heading);
    const fullTitlePart = explicitDatePartQualifier(stripDateLabels(title));
    const explicitPart = headingPart && fullTitlePart && headingPart !== fullTitlePart
      ? '!ambiguous-part'
      : fullTitlePart || headingPart;
    const special = specialInfoFromContext(heading, animeTitle, title);
    const cleanHeading = stripSpecialLabels(heading);
    return {
      ...option,
      animeTitle,
      date: parsedDate?.[0] ?? '',
      dateState: dateInfo.state,
      edition: mergeDateQualifiers(editionQualifier(animeTitle), editionQualifier(cleanHeading)),
      seriesBase: option.seriesBase || titleParts.base,
      parentKey: option.parentKey || parentKeyForEpisode(option.episode, animeTitle),
      parentYear: option.animeYear || titleParts.year,
      year: titleParts.year || (parsedDate ? Number.parseInt(parsedDate[0].slice(0, 4), 10) : 0),
      season: episodeSeason.conflict ? -1 : episodeSeason.season || option.animeSeason || titleParts.season,
      explicitOrdinal: programEpisodeNumber(heading),
      ordinal: programEpisodeNumber(heading),
      explicitPart,
      qualifierPart: qualifierPart(dateSuffixQualifier),
      unknownQualifier: [parsedDate?.[1] ?? '', dateQualifier(cleanHeading)]
        .some((value) => value.split('+').some((part) => part.startsWith('!')))
        || special.kind.startsWith('!'),
      specialKind: special.kind,
      specialTitle: special.title,
    };
  });

  const groups = new Map                           ();
  for (const row of rows) {
    const key = `${row.parentKey}|${row.seriesBase}|y${row.year}|s${row.season}|edition:${row.edition}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.some((row) => row.specialKind || row.edition.split('+').includes('抢鲜'))) continue;
    if (!group.every((row) => row.date)) continue;
    const dates = [...new Set(group.map((row) => row.date))].sort();
    if (dates.length < 2) continue;
    const ordinalByDate = new Map(dates.map((date, index) => [date, index + 1]));
    for (const row of group) {
      if (!row.explicitOrdinal) row.ordinal = ordinalByDate.get(row.date) ?? 0;
    }
  }
  return rows;
}

function selectProgramEpisode(
  options                   ,
  query            ,
  requestedOrdinal        ,
)                                                               {
  if (requestedOrdinal <= 0 || query.programPart.startsWith('!')) {
    return { selected: null, hasCandidates: false };
  }
  if (query.episodeQualifier.split('+').some((part) => part.startsWith('!'))) {
    return { selected: null, hasCandidates: false };
  }

  const queryTitle = catalogTitleParts(query.title, query.year, query.season);
  const scoped = programEpisodeRows(options).filter((row) =>
    row.seriesBase === queryTitle.base
    && (!query.year || row.year === query.year)
    && (!query.season || row.season === query.season
      || (query.season === 1 && query.seasonDefaultNotation && row.season === 0))
    && row.edition === query.edition
    && !row.specialKind
    && !row.unknownQualifier,
  );
  const rowsByParent = new Map                           ();
  for (const row of scoped) {
    const parentRows = rowsByParent.get(row.parentKey) ?? [];
    parentRows.push(row);
    rowsByParent.set(row.parentKey, parentRows);
  }

  const matchesPart = (row                 , allowMissingPart         )          => {
    if (query.programPart) {
      return row.explicitPart === query.programPart || row.qualifierPart === query.programPart;
    }
    if (query.dateOrdinalAlias) {
      if (row.explicitPart) return row.explicitPart === query.dateOrdinalAlias;
      if (row.explicitOrdinal === 1 || row.explicitOrdinal === 2) {
        return (row.explicitOrdinal === 1 ? '上' : '下') === query.dateOrdinalAlias;
      }
      return true;
    }
    return allowMissingPart || !row.explicitPart;
  };

  if (query.episodeDate) {
    const exactSelections                    = [];
    let hasExactDateOrdinal = false;
    for (const parentRows of rowsByParent.values()) {
      const dateOrdinal = parentRows.filter((row) => row.date === query.episodeDate
        && (!query.programPart && query.dateOrdinalAlias
          ? true
          : row.ordinal === requestedOrdinal));
      if (dateOrdinal.length > 0) hasExactDateOrdinal = true;
      const exact = dateOrdinal.filter((row) => matchesPart(row, false));
      if (exact.length === 1) exactSelections.push(exact[0]);
    }
    if (exactSelections.length > 0) {
      return { selected: exactSelections[0], hasCandidates: true };
    }
    if (hasExactDateOrdinal) {
      return { selected: null, hasCandidates: true };
    }

    const undatedSelections                    = [];
    const expectedYear = Number.parseInt(query.episodeDate.slice(0, 4), 10);
    const wantedPart = query.programPart || query.dateOrdinalAlias;
    const hasExplicitIdentity = requestedOrdinal > 0 || ['上', '中', '下'].includes(wantedPart);
    if (!hasExplicitIdentity || (query.year > 0 && query.year !== expectedYear)) {
      return { selected: null, hasCandidates: scoped.length > 0 };
    }
    for (const parentRows of rowsByParent.values()) {
      const undated = parentRows.filter((row) => row.dateState === 'undated'
        && row.parentYear === expectedYear
        && (requestedOrdinal <= 0 || row.explicitOrdinal === requestedOrdinal)
        && (wantedPart
          ? row.explicitPart === wantedPart || row.qualifierPart === wantedPart
            || (!row.explicitPart && row.explicitOrdinal === (wantedPart === '上' ? 1 : wantedPart === '下' ? 2 : 0))
          : !row.explicitPart));
      if (undated.length === 1) undatedSelections.push(undated[0]);
    }
    return {
      selected: undatedSelections[0] ?? null,
      hasCandidates: scoped.length > 0 || undatedSelections.length > 0,
    };
  }

  const selections                    = [];
  for (const parentRows of rowsByParent.values()) {
    const matches = parentRows.filter((row) => row.ordinal === requestedOrdinal && matchesPart(row, false));
    if (matches.length === 1) selections.push(matches[0]);
  }
  return { selected: selections[0] ?? null, hasCandidates: scoped.length > 0 };
}

function selectSpecialEpisode(
  options                   ,
  query            ,
)                                                               {
  if (!query.specialKind || query.specialKind.startsWith('!') || query.programPart.startsWith('!')) {
    return { selected: null, hasCandidates: false };
  }
  if (query.episodeQualifier.split('+').some((part) => part.startsWith('!'))) {
    return { selected: null, hasCandidates: false };
  }
  const queryTitle = catalogTitleParts(query.title, query.year, query.season);
  const scoped = programEpisodeRows(options).filter((row) =>
    row.seriesBase === queryTitle.base
    && (!query.year || row.year === query.year)
    && (!query.season || row.season === query.season
      || (query.season === 1 && query.seasonDefaultNotation && row.season === 0))
    && row.edition === query.edition
    && row.specialKind === query.specialKind
    && (!query.specialTitle || row.specialTitle === query.specialTitle)
    && !row.unknownQualifier,
  );
  if (scoped.length === 0) return { selected: null, hasCandidates: false };

  const byParent = new Map                           ();
  for (const row of scoped) {
    const group = byParent.get(row.parentKey) ?? [];
    group.push(row);
    byParent.set(row.parentKey, group);
  }
  const matchesIdentity = (row                 )          => {
    if (query.programEpisode > 0 && row.explicitOrdinal !== query.programEpisode) return false;
    if (query.programPart) {
      return row.explicitPart === query.programPart || row.qualifierPart === query.programPart;
    }
    if (query.dateOrdinalAlias) {
      return row.explicitPart === query.dateOrdinalAlias
        || row.qualifierPart === query.dateOrdinalAlias
        || (!row.explicitPart && row.explicitOrdinal === (query.dateOrdinalAlias === '上' ? 1 : query.dateOrdinalAlias === '下' ? 2 : 0));
    }
    return !row.explicitPart;
  };

  const selectedByParent                    = [];
  for (const rows of byParent.values()) {
    if (query.episodeDate) {
      const exact = rows.filter((row) => row.date === query.episodeDate && matchesIdentity(row));
      if (exact.length === 1) {
        selectedByParent.push(exact[0]);
        continue;
      }
      if (exact.length > 1) continue;

      const expectedYear = Number.parseInt(query.episodeDate.slice(0, 4), 10);
      const hasExplicitIdentity = query.programEpisode > 0
        || !!query.programPart
        || !!query.specialTitle;
      if (!hasExplicitIdentity || (query.year > 0 && query.year !== expectedYear)) continue;
      const undated = rows.filter((row) => row.dateState === 'undated'
        && row.parentYear === expectedYear
        && matchesIdentity(row));
      if (undated.length === 1) selectedByParent.push(undated[0]);
    } else {
      const matches = rows.filter((row) => row.dateState !== 'invalid' && matchesIdentity(row));
      if (matches.length === 1) selectedByParent.push(matches[0]);
    }
  }
  return { selected: selectedByParent[0] ?? null, hasCandidates: scoped.length > 0 };
}

function candidateDateOptions(candidates                  , varietyOnly = false)                    {
  return candidates
    .filter((candidate) => !varietyOnly || candidate.variety)
    .flatMap((candidate) => candidate.episodes.map((episode) => ({
      episode,
      animeTitle: candidate.title,
      animeSeason: candidate.season,
      animeYear: candidate.parentYear,
      parentKey: candidate.parentKey,
      seriesBase: candidate.seriesBase,
    })));
}

function hasRequestedEpisodeMatch(candidates                  , query            )          {
  if (candidates.length === 0) return false;
  const allOptions = candidateDateOptions(candidates);
  const varietyOptions = candidateDateOptions(candidates, true);
  if (query.specialKind) return !!selectSpecialEpisode(allOptions, query).selected;
  if (query.programEpisode > 0) {
    return !!selectProgramEpisode(allOptions, query, query.programEpisode).selected;
  }
  if (query.episodeDate) {
    return !!selectDateEpisode(allOptions, query.episodeDate, query.episodeQualifier).selected;
  }
  if (query.episode > 0 && varietyOptions.length > 0) {
    return !!selectProgramEpisode(varietyOptions, query, query.episode).selected;
  }
  if (query.episode > 0) {
    return candidates.some((candidate) => !!pickEpisode(candidate.episodes, query));
  }
  return true;
}

function selectDateEpisode(
  options                   ,
  wantedDate        ,
  wantedQualifier        ,
)                                                                {
  const dated = options.flatMap((option) => {
    const title = textOf(option.episode.episodeTitle);
    if (specialInfoFromContext(episodeHeading(title), option.animeTitle, title).kind) return [];
    const parsed = episodeDate(option.episode, option.animeTitle);
    return parsed && parsed[0] === wantedDate ? [{ option, qualifier: parsed[1] }] : [];
  });
  if (dated.length === 0) return { selected: null, hasDateEntries: false };
  if (!wantedQualifier && dated.some((entry) => entry.qualifier)) {
    return { selected: null, hasDateEntries: true };
  }

  const matches = !wantedQualifier
    ? dated.filter((entry) => !entry.qualifier)
    : dated.filter((entry) => entry.qualifier === wantedQualifier);
  const matchesByParent = new Map                        ();
  for (const entry of matches) {
    const key = entry.option.parentKey || parentKeyForEpisode(entry.option.episode, entry.option.animeTitle);
    const rows = matchesByParent.get(key) ?? [];
    rows.push(entry);
    matchesByParent.set(key, rows);
  }
  const uniquePerParent = [...matchesByParent.values()].filter((rows) => rows.length === 1);
  return {
    selected: uniquePerParent[0]?.[0].option ?? null,
    hasDateEntries: true,
  };
}

function pickDateEpisode(
  episodes                           ,
  wantedDate        ,
  wantedQualifier        ,
)                                 {
  const options = episodes.map((episode) => ({ episode, animeTitle: textOf(episode.animeTitle) }));
  return selectDateEpisode(options, wantedDate, wantedQualifier).selected?.episode ?? null;
}

function parseEpisodeNumber(value        )         {
  if (findDateLabel(value)) return 0;
  for (const re of [SE_RE, CN_EP_RE, EP_RE]) {
    const match = re.exec(value);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function parseQuery(fileName        )             {
  const dateLabel = findDateLabel(fileName);
  const qualifierDateLabel = findDateLabel(stripSpecialLabels(fileName));
  const dateLike = hasDateLikeLabel(fileName);
  const unexpandedShortDateLike = hasUnexpandedShortDateLike(fileName);
  let cut = fileName.length;
  let year = 0;
  const yearMatches = fileName.matchAll(new RegExp(YEAR_RE.source, 'g'));
  for (const match of yearMatches) {
    const yearStart = match.index + match[0].indexOf(match[1]);
    const yearEnd = yearStart + match[1].length;
    if (dateLabel && yearStart >= dateLabel.start && yearEnd <= dateLabel.end) continue;
    year = Number.parseInt(match[1], 10);
    if (match.index < cut) cut = match.index;
    break;
  }
  if (dateLabel && dateLabel.start < cut) cut = dateLabel.start;
  const seasonMatches = seasonLabels(fileName);
  const seasonMatch = seasonMatches[0] ?? null;
  if (seasonMatch && seasonMatch.index < cut) cut = seasonMatch.index;
  for (const re of [SE_RE, CN_EP_RE, EP_RE]) {
    const match = re.exec(fileName);
    if (match && match.index < cut) cut = match.index;
  }
  for (const marker of specialLabelMatches(fileName)) {
    if (marker.start > 0 && /\s/.test(fileName[marker.start - 1]) && marker.start < cut) {
      cut = marker.start;
    }
  }
  let title = cleanTitle(fileName.slice(0, cut));
  if (!title) title = cleanTitle(fileName);
  const uniqueSeasons = [...new Set(seasonMatches.map((label) => label.season))];
  const season = uniqueSeasons.length === 1 ? uniqueSeasons[0] : 0;
  const programEpisode = programEpisodeNumber(fileName);
  const edition = editionQualifier(fileName);
  const programPart = explicitDatePartQualifier(fileName) || explicitEpisodeTokenPart(fileName);
  const specialContext = fileName.slice(cut);
  const special = specialInfoFromContext(episodeHeading(specialContext), title, specialContext);
  const legacyDateOrdinalAlias = explicitLegacyDateOrdinalAlias(fileName, dateLabel);
  const searchSeason = seasonMatch
    ? seasonMatch.raw.startsWith('第') ? seasonMatch.raw : `第${season}季`
    : '';
  const searchTitle = stripEditionLabels([title, searchSeason].filter(Boolean).join(' ')) || title;
  return {
    title,
    searchTitle,
    year,
    season,
    episode: dateLike || unexpandedShortDateLike ? 0 : parseEpisodeNumber(fileName),
    programEpisode,
    programPart,
    dateOrdinalAlias: legacyDateOrdinalAlias,
    edition,
    specialKind: special.kind,
    specialTitle: special.title,
    episodeDate: dateLabel?.date ?? '',
    episodeQualifier: mergeDateQualifiers(qualifierDateLabel?.qualifier ?? '', edition),
    invalidEpisodeDate: (dateLike && !dateLabel) || unexpandedShortDateLike,
    invalidSeason: uniqueSeasons.length > 1,
    seasonDefaultNotation: season === 1 && /^s\d{1,2}$/i.test(seasonMatch?.raw ?? ''),
  };
}

function scoreCandidate(query            , animeTitle        )         {
  const input = normalizeTitle(query.title);
  const candidate = normalizeTitle(animeTitle);
  if (!input || !candidate) return 0;
  let score        ;
  if (candidate === input) score = 100;
  else if (candidate.includes(input)) score = 60;
  else if (input.includes(candidate)) score = 50;
  else return 0;
  if (query.year > 0) {
    const yearMatch = YEAR_RE.exec(animeTitle);
    if (yearMatch && Number.parseInt(yearMatch[1], 10) !== query.year) return 0;
    score += yearMatch && Number.parseInt(yearMatch[1], 10) === query.year ? 20 : -20;
  }
  if (query.season > 0) {
    const seasonInfo = seasonInfoFromTitle(animeTitle);
    if (seasonInfo.conflict || (seasonInfo.season > 0 && seasonInfo.season !== query.season)) return 0;
    if (seasonInfo.season === query.season) score += 15;
  } else if (seasonInfoFromTitle(animeTitle).season === 0) {
    score += 5;
  }
  for (const derivative of ['剧场版', '合集', '速看', '动态漫', '双食记', 'top', '解说', '预告', '花絮', '美食图鉴']) {
    if (animeTitle.toLowerCase().includes(derivative) && !query.title.toLowerCase().includes(derivative)) {
      score -= 40;
      break;
    }
  }
  return score;
}

function pickEpisode(episodes                           , query            )                                 {
  const ordinaryEpisodes = episodes.filter((episode) =>
    !specialInfoFromContext(episodeHeading(textOf(episode.episodeTitle))).kind,
  );
  if (query.episodeDate) return pickDateEpisode(ordinaryEpisodes, query.episodeDate, query.episodeQualifier);
  if (ordinaryEpisodes.length === 0) return null;
  if (query.episode <= 0) return ordinaryEpisodes[0];
  for (const episode of ordinaryEpisodes) {
    if (parseEpisodeNumber(textOf(episode.episodeTitle)) === query.episode) return episode;
  }
  return query.episode <= ordinaryEpisodes.length ? ordinaryEpisodes[query.episode - 1] : null;
}

function isVarietyAnime(anime                         , title        )          {
  return /【\s*综艺\s*】/.test(title)
    || /综艺/.test(textOf(anime.type))
    || /综艺/.test(textOf(anime.typeDescription));
}


function recordYear(record                         , title        , episodes                            = [])         {
  const titleMatch = YEAR_RE.exec(title);
  if (titleMatch) return Number.parseInt(titleMatch[1], 10);
  for (const key of ['year', 'animeYear', 'anime_year', 'startYear', 'start_year', 'releaseYear', 'release_year']) {
    const value = record[key];
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(textOf(value), 10);
    if (Number.isFinite(parsed) && parsed >= 1900 && parsed <= 2099) return parsed;
  }
  const years = [...new Set(episodes.flatMap((episode) => {
    const parsed = episodeDate(episode, title);
    return parsed ? [Number.parseInt(parsed[0].slice(0, 4), 10)] : [];
  }))];
  return years.length === 1 ? years[0] : 0;
}

function episodesForSeason(
  episodes                           ,
  title        ,
  seriesSeason            ,
  query            ,
)                            {
  if (query.season <= 0) return episodes;
  if (seriesSeason.conflict || (seriesSeason.season > 0 && seriesSeason.season !== query.season)) return [];
  return episodes.filter((episode) => {
    const episodeSeason = seasonInfoFromRecord(episode, title);
    if (episodeSeason.conflict) return false;
    const season = episodeSeason.season || seriesSeason.season;
    if (season > 0) return season === query.season;
    // S01E01 remains the conventional default when a provider omits season metadata.
    return query.season === 1 && query.seasonDefaultNotation;
  });
}

function candidateFromAnime(
  anime                         ,
  query            ,
  discovered = false,
  parentKey = parentKeyForEpisode(anime),
)                        {
  const title = textOf(anime.animeTitle);
  const episodes = Array.isArray(anime.episodes)
    ? anime.episodes.filter((episode)                                     =>
      !!episode && typeof episode === 'object' && !Array.isArray(episode),
    )
    : [];
  const score = scoreCandidate(query, title);
  if (!title || score < 50 || episodes.length === 0) return null;
  const season = seasonInfoFromRecord(anime, title);
  if (season.conflict) return null;
  const annualAlias = annualVarietySeasonAlias(anime, title, query);
  if (query.season > 0 && season.season > 0 && season.season !== query.season) return null;
  if (query.season > 1 && season.season === 0 && !annualAlias) return null;
  const variety = isVarietyAnime(anime, title);
  const effectiveSeason             = annualAlias ? { season: query.season, conflict: false } : season;
  const selectedEpisodes = episodesForSeason(episodes, title, effectiveSeason, query);
  if (selectedEpisodes.length === 0) return null;
  const parentYear = recordYear(anime, title);
  const year = recordYear(anime, title, selectedEpisodes);
  if (query.year > 0 && year > 0 && year !== query.year) return null;
  if (discovered && query.year > 0 && year === 0) return null;
  if (discovered && catalogTitleParts(title).base !== catalogTitleParts(query.title).base && !annualAlias) return null;
  const seriesBase = annualAlias
    ? catalogTitleParts(query.title, query.year, query.season).base
    : catalogTitleParts(title).base;
  return { title, episodes: selectedEpisodes, score, season: effectiveSeason.season, parentYear, variety, discovered, parentKey, seriesBase };
}









function animeIdOf(record                         )         {
  for (const key of ['animeId', 'animeID', 'anime_id', 'id', 'bangumiId', 'bangumi_id']) {
    const id = num(record[key]);
    if (id > 0) return id;
  }
  return 0;
}

function parentKeyForEpisode(episode                         , titleFallback = '')         {
  const animeId = animeIdOf(episode);
  if (animeId > 0) return `id:${animeId}`;
  const title = textOf(episode.animeTitle) || titleFallback;
  return `title:${title.trim().toLowerCase()}`;
}

function animeSearchCandidates(response                         , query            )                         {
  const rows = Array.isArray(response.animes)
    ? response.animes.filter((item)                                  =>
      !!item && typeof item === 'object' && !Array.isArray(item),
    )
    : [];
  const queryBase = catalogTitleParts(query.title).base;
  const byId = new Map                              ();
  for (const anime of rows) {
    const title = textOf(anime.animeTitle);
    if (!title) continue;
    const annualAlias = annualVarietySeasonAlias(anime, title, query);
    if (catalogTitleParts(title).base !== queryBase && !annualAlias) continue;
    const score = scoreCandidate(query, title);
    if (score < 50) continue;
    const info = seasonInfoFromRecord(anime, title);
    if (info.conflict || (query.season > 0 && info.season > 0 && info.season !== query.season)) continue;
    const year = recordYear(anime, title);
    if (query.year > 0 && year > 0 && year !== query.year) continue;

    const animeId = animeIdOf(anime);
    if (animeId <= 0) continue;
    const candidate                       = {
      animeId,
      title,
      season: info.season,
      seasonProven: info.season > 0,
      score,
    };
    const previous = byId.get(animeId);
    if (!previous || candidate.score > previous.score) byId.set(animeId, candidate);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, MAX_BANGUMI_DISCOVERY);
}


export function danmakuItemsFromMatch(match                         , base        , fileName = '') {
  if (match.isMatched !== true) return null;
  const matches = match.matches;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const query = fileName ? parseQuery(fileName) : null;
  if (query?.invalidEpisodeDate || query?.invalidSeason
    || query?.specialKind.startsWith('!')
    || query?.episodeQualifier.split('+').some((part) => part.startsWith('!'))) return null;
  const records = matches.filter((item)                                  =>
    !!item && typeof item === 'object' && !Array.isArray(item),
  ).filter((item) => {
    if (!query) return true;
    const animeTitle = textOf(item.animeTitle);
    const specialKind = specialInfoFromContext(
      episodeHeading(textOf(item.episodeTitle)), animeTitle, textOf(item.episodeTitle),
    ).kind;
    if (!query.specialKind && specialKind) return false;
    const season = seasonInfoFromRecord(item, animeTitle);
    if (season.conflict || (query.season > 0 && season.season > 0 && season.season !== query.season)) return false;
    const annualAlias = annualVarietySeasonAlias(item, animeTitle, query);
    if (query.season > 0 && season.season === 0
      && !annualAlias
      && !(query.season === 1 && query.seasonDefaultNotation)) return false;
    const year = recordYear(item, animeTitle);
    return !(query.year > 0 && year > 0 && year !== query.year);
  });
  if (records.length === 0) return null;
  const options = records.map((episode) => ({
    episode,
    animeTitle: textOf(episode.animeTitle),
    animeSeason: query && annualVarietySeasonAlias(episode, textOf(episode.animeTitle), query)
      ? query.season
      : seasonInfoFromRecord(episode, textOf(episode.animeTitle)).season,
    animeYear: recordYear(episode, textOf(episode.animeTitle)),
    parentKey: parentKeyForEpisode(episode),
    seriesBase: query && annualVarietySeasonAlias(episode, textOf(episode.animeTitle), query)
      ? catalogTitleParts(query.title, query.year, query.season).base
      : catalogTitleParts(textOf(episode.animeTitle)).base,
  }));
  const variety = records.some((item) => isVarietyAnime(item, textOf(item.animeTitle)));
  const requestedOrdinal = query ? query.programEpisode || (variety ? query.episode : 0) : 0;
  const record = query?.specialKind
    ? selectSpecialEpisode(options, query).selected?.episode ?? null
    : query?.episodeDate
    ? query.programEpisode > 0
      ? selectProgramEpisode(options, query, query.programEpisode).selected?.episode ?? null
      : pickDateEpisode(records, query.episodeDate, query.episodeQualifier)
    : query && (query.programEpisode > 0 || (requestedOrdinal > 0 && variety))
      ? selectProgramEpisode(options, query , requestedOrdinal).selected?.episode ?? null
      : records[0];
  if (!record) return null;
  const episodeId = Number(record.episodeId);
  if (!Number.isFinite(episodeId)) return null;
  const animeTitle = typeof record.animeTitle === 'string' ? record.animeTitle : '';
  const episodeTitle = typeof record.episodeTitle === 'string' ? record.episodeTitle : '';
  let name = '弹幕';
  if (animeTitle && episodeTitle) name = `${animeTitle} - ${episodeTitle}`;
  else if (episodeTitle) name = episodeTitle;
  return [{ name, url: `${base}/api/v2/comment/${Math.trunc(episodeId)}?format=xml` }];
}


function catalogAnimeEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const animeTitle = textOf(item.animeTitle);
    const episodes = Array.isArray(item.episodes)
      ? item.episodes.filter((episode) => !!episode && typeof episode === 'object' && !Array.isArray(episode))
      : [];
    return animeTitle && episodes.length > 0 ? [{ ...item, episodes }] : [];
  });
}

function isPositiveCatalogResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.success === false) return false;
  return !Object.prototype.hasOwnProperty.call(value, 'errorCode') || num(value.errorCode) === 0;
}

function catalogIdentity(anime) {
  const id = num(anime.animeId);
  if (id > 0) return 'id:' + id;
  const title = textOf(anime.animeTitle).replace(FROM_RE, '').replace(BRACKET_RE, '').replace(/\s+/g, '').toLowerCase();
  return 'title:' + title;
}

function providerBase(io) {
  return textOf(io && io.base).replace(/\/+$/, '');
}

function ioNow(io) {
  const value = io && typeof io.now === 'function' ? Number(io.now()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function localCatalogKey(base, title, year = 0, season = 0) {
  const parts = catalogTitleParts(stripEditionLabels(title), year, season);
  return base + '\u0000' + parts.base;
}

function readLocalPositiveCatalog(base, title, year, season, now) {
  if (!base) return null;
  const key = localCatalogKey(base, title, year, season);
  const cached = localCatalogCache.get(key);
  if (!cached) return null;
  const age = now - cached.cachedAt;
  if (!cached.cachedAt || age < 0 || age >= CATALOG_RETENTION_MS || cached.entries.length === 0) {
    localCatalogCache.delete(key);
    return null;
  }
  return { entries: cached.entries, fresh: age < CATALOG_FRESH_MS };
}

function writeLocalPositiveCatalog(io, title, year, season, entries) {
  const base = providerBase(io);
  if (!base || !entries || entries.length === 0) return;
  const requestQuery = parseQuery(title);
  if (year > 0) requestQuery.year = year;
  if (season > 0) requestQuery.season = season;
  const buckets = new Map();
  for (const anime of entries) {
    const animeTitle = textOf(anime.animeTitle);
    if (!animeTitle) continue;
    const annualAlias = annualVarietySeasonAlias(anime, animeTitle, requestQuery);
    const bucketTitle = annualAlias ? requestQuery.title : animeTitle;
    const key = localCatalogKey(base, bucketTitle, year, season);
    const bucket = buckets.get(key) ?? [];
    bucket.push(anime);
    buckets.set(key, bucket);
  }
  const now = ioNow(io);
  for (const [key, newEntries] of buckets) {
    const merged = new Map();
    const previous = localCatalogCache.get(key);
    for (const anime of previous?.entries ?? []) merged.set(catalogIdentity(anime), anime);
    for (const anime of newEntries) merged.set(catalogIdentity(anime), anime);
    if (merged.size > 0) localCatalogCache.set(key, { cachedAt: now, entries: [...merged.values()] });
  }
  while (localCatalogCache.size > LOCAL_CATALOG_MAX_KEYS) {
    localCatalogCache.delete(localCatalogCache.keys().next().value);
  }
}

export function clearLocalDanmakuCatalogCache() {
  localCatalogCache.clear();
}

function itemForEpisode(base, episode, animeTitle) {
  const episodeId = num(episode && episode.episodeId);
  if (!base || episodeId <= 0) return null;
  const episodeTitle = textOf(episode.episodeTitle);
  const name = episodeTitle ? animeTitle + ' - ' + episodeTitle : animeTitle;
  return { name, url: base + '/api/v2/comment/' + episodeId + '?format=xml' };
}

async function invoke(io, method, args, deadline) {
  if (!io || typeof io[method] !== 'function' || ioNow(io) >= deadline) return null;
  return io[method](...args, deadline);
}

async function localCommentHasContent(io, episodeId, deadline) {
  if (!io || typeof io.commentHasContent !== 'function') return true;
  if (ioNow(io) >= deadline) return false;
  try {
    return (await io.commentHasContent(episodeId, deadline)) === true;
  } catch {
    return false;
  }
}

async function discoverLocalCatalog(io, query, deadline) {
  let response;
  try {
    response = await invoke(io, 'searchAnime', [query.title, query.season], deadline);
  } catch {
    return [];
  }
  if (!isPositiveCatalogResponse(response)) return [];
  const searchCandidates = animeSearchCandidates(response, query);
  if (searchCandidates.length === 0) return [];

  const details = await Promise.all(searchCandidates.map(async (candidate) => {
    try {
      const detailResponse = await invoke(io, 'getBangumi', [candidate.animeId], deadline);
      if (!isPositiveCatalogResponse(detailResponse)) return null;
      const raw = detailResponse.bangumi;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      let detail = raw;
      const title = textOf(detail.animeTitle) || candidate.title;
      const annualAlias = annualVarietySeasonAlias(detail, title, query);
      if (catalogTitleParts(title).base !== catalogTitleParts(query.title).base && !annualAlias) return null;
      const detailSeason = seasonInfoFromRecord(detail, title);
      if (detailSeason.conflict
        || (query.season > 0 && detailSeason.season > 0 && detailSeason.season !== query.season)
        || (candidate.season > 0 && detailSeason.season > 0 && candidate.season !== detailSeason.season)) return null;
      if (!textOf(detail.animeTitle)) detail = { ...detail, animeTitle: title };
      if (detailSeason.season === 0 && candidate.seasonProven && candidate.season > 0) {
        detail = { ...detail, season: candidate.season };
      }
      if (!animeIdOf(detail)) detail = { ...detail, animeId: candidate.animeId };
      return catalogAnimeEntries([detail])[0] ?? null;
    } catch {
      return null;
    }
  }));

  const entries = details.filter(Boolean);
  if (entries.length > 0) writeLocalPositiveCatalog(io, query.searchTitle, query.year, query.season, entries);
  return entries.filter((item) => candidateFromAnime(item, query, true) !== null);
}

function selectedItem(selection, base) {
  return selection && selection.selected
    ? itemForEpisode(base, selection.selected.episode, selection.selected.animeTitle)
    : null;
}

/**
 * Resolve using injected local provider IO. Search payloads keep the same shapes as the
 * danmu_api upstream endpoints. All selection still uses the strict Workers rules above.
 * The returned URL is a synthetic comment locator only; this function never fetches it.
 */
export async function resolveLocalDanmaku(fileName, io) {
  const query = parseQuery(textOf(fileName));
  if (!query.title || query.invalidEpisodeDate || query.invalidSeason
    || query.specialKind.startsWith('!')
    || query.episodeQualifier.split('+').some((part) => part.startsWith('!'))) return [];
  const base = providerBase(io);
  if (!base) return [];
  const deadline = ioNow(io) + RESOLVE_BUDGET_MS;

  let episodesResponse = null;
  const cachedCatalog = readLocalPositiveCatalog(base, query.searchTitle, query.year, query.season, ioNow(io));
  if (cachedCatalog?.fresh) {
    episodesResponse = { animes: cachedCatalog.entries };
  } else {
    try {
      episodesResponse = await invoke(io, 'searchEpisodes',
        [query.searchTitle, query.year, query.season], deadline);
    } catch {
      episodesResponse = null;
    }
    const upstreamEntries = episodesResponse && isPositiveCatalogResponse(episodesResponse)
      ? catalogAnimeEntries(episodesResponse.animes)
      : [];
    if (upstreamEntries.length > 0) {
      episodesResponse = { ...episodesResponse, animes: upstreamEntries };
      writeLocalPositiveCatalog(io, query.searchTitle, query.year, query.season, upstreamEntries);
    } else if (cachedCatalog) {
      episodesResponse = { ...(episodesResponse ?? {}), animes: cachedCatalog.entries };
    }
  }

  const responseEntries = () => catalogAnimeEntries(episodesResponse?.animes);
  const buildCandidates = (entries) => entries
    .map((anime) => candidateFromAnime(anime, query, false, parentKeyForEpisode(anime)))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  let animeEntries = responseEntries();
  let candidates = buildCandidates(animeEntries);
  if (!hasRequestedEpisodeMatch(candidates, query) && ioNow(io) < deadline) {
    const discovered = await discoverLocalCatalog(io, query, deadline);
    if (discovered.length > 0) {
      const merged = new Map();
      for (const anime of animeEntries) merged.set(catalogIdentity(anime), anime);
      for (const anime of discovered) merged.set(catalogIdentity(anime), anime);
      animeEntries = [...merged.values()];
      episodesResponse = { ...(episodesResponse ?? {}), animes: animeEntries };
      candidates = buildCandidates(animeEntries);
    }
  }

  const allOptions = candidateDateOptions(candidates);
  const varietyOptions = candidateDateOptions(candidates, true);
  if (query.specialKind) {
    const item = selectedItem(selectSpecialEpisode(allOptions, query), base);
    return item ? [item] : [];
  }
  if (query.programEpisode > 0) {
    const item = selectedItem(selectProgramEpisode(allOptions, query, query.programEpisode), base);
    return item ? [item] : [];
  }

  let fallback = null;
  if (query.episodeDate) {
    const options = candidateDateOptions(candidates);
    let selected;
    let hasDateCandidates;
    if (query.programEpisode > 0) {
      const selection = selectProgramEpisode(options, query, query.programEpisode);
      selected = selection.selected;
      hasDateCandidates = selection.hasCandidates;
    } else {
      const selection = selectDateEpisode(options, query.episodeDate, query.episodeQualifier);
      selected = selection.selected;
      hasDateCandidates = selection.hasDateEntries;
    }
    if (!selected && hasDateCandidates) return [];
    if (selected) fallback = itemForEpisode(base, selected.episode, selected.animeTitle);
  } else {
    if (varietyOptions.length > 0 && query.episode > 0) {
      const item = selectedItem(selectProgramEpisode(varietyOptions, query, query.episode), base);
      return item ? [item] : [];
    }
    for (const candidate of candidates.slice(0, 3)) {
      const episode = pickEpisode(candidate.episodes, query);
      if (!episode) continue;
      const item = itemForEpisode(base, episode, candidate.title);
      if (!item) continue;
      if (!fallback) fallback = item;
      const episodeId = num(episode.episodeId);
      if (await localCommentHasContent(io, episodeId, deadline)) return [item];
    }
  }
  if (fallback) return [fallback];

  try {
    const match = await invoke(io, 'matchAnime', [fileName], deadline);
    const matches = Array.isArray(match?.matches) ? match.matches : [];
    const related = matches.filter((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const animeTitle = textOf(item.animeTitle);
      if (animeTitle) {
        const input = normalizeTitle(query.title);
        const candidate = normalizeTitle(animeTitle);
        if (input && candidate && !candidate.includes(input) && !input.includes(candidate)) return false;
      } else if (query.episodeDate || query.season > 1) {
        return false;
      }
      const season = seasonInfoFromRecord(item, animeTitle);
      if (season.conflict || (query.season > 0 && season.season > 0 && season.season !== query.season)) return false;
      const annualAlias = annualVarietySeasonAlias(item, animeTitle, query);
      if (query.season > 0 && season.season === 0
        && !annualAlias
        && !(query.season === 1 && query.seasonDefaultNotation)) return false;
      const year = recordYear(item, animeTitle);
      return !(query.year > 0 && year > 0 && year !== query.year);
    });
    const item = danmakuItemsFromMatch({ ...match, matches: related }, base, fileName)?.[0];
    const matchId = item ? Number(/\/comment\/(\d+)/.exec(item.url)?.[1] ?? 0) : 0;
    if (item && matchId > 0 && await localCommentHasContent(io, matchId, deadline)) return [item];
  } catch {
    // A provider error is a no-match so the caller can use its cloud fallback.
  }
  return [];
}
