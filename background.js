/**
 * background.js
 * 초고속 가사 탐색 엔진 (v3.3.0):
 * 1) [방안 1] Promise.any 최선착순 레이싱(First-Win Racing) + 내부 쿼리 병렬화 + AbortController 즉시 취소
 * 2) [방안 2] 좋아요(Liked) 및 저장목록(Saved/Library) 곡 전용 chrome.storage.local 영구 로컬 캐싱 (0.01초 즉시 로드)
 * 3) [방안 3] 다음 트랙(Up Next) 백그라운드 프리페칭(Pre-fetching) 지원 (곡 전환 시 0초 즉시 렌더링)
 */

const sessionLyricsCache = new Map();     // 현재 세션 인메모리 캐시 (프리페칭 및 일반 곡용)
const persistentLyricsCache = new Map();  // 좋아요/저장목록 곡 전용 영구 캐시 미러
const inFlightRequests = new Map();       // 동일 곡 중복 네트워크 요청 방지 맵

const MAX_SESSION_CACHE_SIZE = 300;
const MAX_PERSISTENT_CACHE_SIZE = 500;
const STORAGE_KEY = 'ytm_liked_saved_lyrics_cache_v2';
const LEGACY_STORAGE_KEY = 'ytm_liked_saved_lyrics_cache_v1';
const SETTINGS_KEY = 'ytm_lyrics_settings_v1';

let isPersistentCacheEnabled = true;

const LRCLIB_BASE_URL = 'https://lrclib.net/api';
const ALSONG_HTTPS_URL = 'https://lyric.altools.co.kr/search/search.ijkl';
const ALSONG_HTTP_URL = 'http://lyric.altools.co.kr/search/search.ijkl';
const NETEASE_SEARCH_URL = 'https://music.163.com/api/search/get';
const NETEASE_LYRIC_URL = 'https://music.163.com/api/song/lyric';
const QQ_SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const QQ_LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';

const LRCLIB_HEADERS = {
  'Accept': 'application/json',
  'X-User-Agent': 'YTMusic-AppleStyle-Lyrics-Extension/3.3.0 (https://music.youtube.com)'
};

let dnrInitializedPromise = null;
let storageLoadedPromise = null;

/**
 * 1. declarativeNetRequest 동적 규칙 등록
 */
function ensureDeclarativeNetRequestRules() {
  if (dnrInitializedPromise) return dnrInitializedPromise;

  dnrInitializedPromise = (async () => {
    try {
      if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) {
        return;
      }

      const rules = [
        {
          id: 101,
          priority: 10,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'remove' },
              { header: 'Referer', operation: 'remove' },
              { header: 'Cookie', operation: 'remove' },
              {
                header: 'User-Agent',
                operation: 'set',
                value:
                  'com.google.android.apps.youtube.music/7.21.50 (Linux; U; Android 13; ko_KR; Pixel 7 Build/TQ3A.230805.001) gzip'
              },
              {
                header: 'X-Goog-Api-Format-Version',
                operation: 'set',
                value: '2'
              }
            ]
          },
          condition: {
            urlFilter: '*://music.youtube.com/youtubei/v1/*ytm_mobile=1*',
            resourceTypes: ['xmlhttprequest']
          }
        },
        {
          id: 102,
          priority: 10,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://music.163.com' },
              { header: 'Referer', operation: 'set', value: 'https://music.163.com/' },
              { header: 'Cookie', operation: 'set', value: 'os=pc; appver=2.9.7' }
            ]
          },
          condition: {
            urlFilter: '*://music.163.com/api/*',
            resourceTypes: ['xmlhttprequest']
          }
        },
        {
          id: 103,
          priority: 10,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://y.qq.com' },
              { header: 'Referer', operation: 'set', value: 'https://y.qq.com/' }
            ]
          },
          condition: {
            urlFilter: '*://c.y.qq.com/*',
            resourceTypes: ['xmlhttprequest']
          }
        },
        {
          id: 104,
          priority: 10,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'remove' },
              { header: 'Referer', operation: 'remove' },
              { header: 'User-Agent', operation: 'set', value: 'ALSong' }
            ]
          },
          condition: {
            urlFilter: '*://lyric.altools.co.kr/*',
            resourceTypes: ['xmlhttprequest']
          }
        }
      ];

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [101, 102, 103, 104],
        addRules: rules
      });
    } catch (e) {}
  })();

  return dnrInitializedPromise;
}

/**
 * 2. chrome.storage.local 영구 캐시 로드 및 저장 (좋아요 / 저장목록 곡 전용)
 */
function ensurePersistentStorageLoaded() {
  if (storageLoadedPromise) return storageLoadedPromise;

  storageLoadedPromise = new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      // 이전 버전(v1)의 잘못 캐싱된 중국어 가사가 남아있다면 자동 정리
      chrome.storage.local.remove([LEGACY_STORAGE_KEY]);
      chrome.storage.local.get([STORAGE_KEY, SETTINGS_KEY], (res) => {
        const settings = res && res[SETTINGS_KEY];
        if (settings && typeof settings.enablePersistentCache === 'boolean') {
          isPersistentCacheEnabled = settings.enablePersistentCache;
        }

        const storedObj = res && res[STORAGE_KEY];
        if (storedObj && typeof storedObj === 'object') {
          for (const [k, v] of Object.entries(storedObj)) {
            if (v && v.status === 'synced' && v.syncedLyrics) {
              persistentLyricsCache.set(k, v);
              sessionLyricsCache.set(k, v);
            }
          }
        }
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });

  return storageLoadedPromise;
}

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[SETTINGS_KEY]) {
      const nextSettings = changes[SETTINGS_KEY].newValue;
      isPersistentCacheEnabled =
        !nextSettings || nextSettings.enablePersistentCache !== false;
    }
    if (changes[STORAGE_KEY] && !changes[STORAGE_KEY].newValue) {
      persistentLyricsCache.clear();
    }
  });
}

function saveToPersistentStorage(canonicalKey, lyricResult, meta = {}) {
  if (!isPersistentCacheEnabled) return;
  if (!canonicalKey || !lyricResult || lyricResult.status !== 'synced' || !lyricResult.syncedLyrics) {
    return;
  }

  if (persistentLyricsCache.size >= MAX_PERSISTENT_CACHE_SIZE && !persistentLyricsCache.has(canonicalKey)) {
    const oldestKey = persistentLyricsCache.keys().next().value;
    persistentLyricsCache.delete(oldestKey);
  }

  persistentLyricsCache.set(canonicalKey, {
    ...lyricResult,
    videoId: meta.videoId || lyricResult.videoId || '',
    rawTitle: meta.rawTitle || lyricResult.rawTitle || lyricResult.trackName || '',
    cleanTitle: meta.cleanTitle || lyricResult.cleanTitle || lyricResult.trackName || '',
    rawArtist: meta.rawArtist || lyricResult.rawArtist || lyricResult.artistName || '',
    cleanArtist: meta.cleanArtist || lyricResult.cleanArtist || lyricResult.artistName || '',
    savedAt: Date.now()
  });

  try {
    if (chrome.storage && chrome.storage.local) {
      const serialized = Object.fromEntries(persistentLyricsCache.entries());
      chrome.storage.local.set({ [STORAGE_KEY]: serialized });
    }
  } catch (e) {}
}

function setSessionCache(canonicalKey, value) {
  if (!canonicalKey || !value) return;
  if (sessionLyricsCache.size >= MAX_SESSION_CACHE_SIZE && !sessionLyricsCache.has(canonicalKey)) {
    const oldestKey = sessionLyricsCache.keys().next().value;
    sessionLyricsCache.delete(oldestKey);
  }
  sessionLyricsCache.set(canonicalKey, value);
}

ensureDeclarativeNetRequestRules();
ensurePersistentStorageLoaded();

/**
 * 한국 아티스트 한/영 양방향 별칭 사전
 */
const KOREAN_ARTIST_ALIAS_GROUPS = [
  ['아이유', 'IU', '이지은'],
  ['태연', 'TAEYEON', '소녀시대', 'Girls Generation'],
  ['윤하', 'Younha', 'YOUNHA'],
  ['에픽하이', 'Epik High', 'EPIK HIGH'],
  ['다비치', 'Davichi', 'DAVICHI'],
  ['악뮤', 'AKMU', '악동뮤지션', 'Akdong Musician'],
  ['볼빨간사춘기', 'BOL4', 'Bolbbalgan4'],
  ['소연', 'SOYEON', '전소연', '(여자)아이들', '(G)I-DLE', 'GIDLE', 'QWER'],
  ['(여자)아이들', '여자아이들', '(G)I-DLE', 'G-IDLE', 'I-DLE'],
  ['큐더블유이알', 'QWER'],
  ['데이식스', 'DAY6', 'Day6'],
  ['에스파', 'aespa', 'AESPA'],
  ['뉴진스', 'NewJeans', 'NEWJEANS'],
  ['아이브', 'IVE', 'Ive'],
  ['르세라핌', 'LE SSERAFIM', 'LESSERAFIM'],
  ['아일릿', 'ILLIT'],
  ['투어스', 'TWS'],
  ['라이즈', 'RIIZE'],
  ['보이넥스트도어', 'BOYNEXTDOOR'],
  ['플레이브', 'PLAVE'],
  ['키스오브라이프', 'KISS OF LIFE'],
  ['베이비몬스터', 'BABYMONSTER'],
  ['제로베이스원', 'ZEROBASEONE', 'ZB1'],
  ['방탄소년단', 'BTS', '방탄'],
  ['블랙핑크', 'BLACKPINK', 'Blackpink'],
  ['세븐틴', 'SEVENTEEN', 'Seventeen'],
  ['트와이스', 'TWICE', 'Twice'],
  ['스트레이 키즈', '스트레이키즈', 'Stray Kids', 'STRAY KIDS'],
  ['투모로우바이투게더', 'TOMORROW X TOGETHER', 'TXT'],
  ['엔하이픈', 'ENHYPEN'],
  ['엔시티', 'NCT', 'NCT 127', 'NCT DREAM', '엔시티 드림', '엔시티 127'],
  ['레드벨벳', 'Red Velvet'],
  ['마마무', 'MAMAMOO'],
  ['있지', 'ITZY'],
  ['엔믹스', 'NMIXX'],
  ['스테이씨', 'STAYC'],
  ['프로미스나인', 'fromis_9'],
  ['오마이걸', 'OH MY GIRL'],
  ['빅뱅', 'BIGBANG'],
  ['지드래곤', 'G-DRAGON', 'GD'],
  ['태양', 'TAEYANG'],
  ['싸이', 'PSY'],
  ['십센치', '10CM', '10cm'],
  ['잔나비', 'JANNABI', 'Jannabi'],
  ['혁오', 'HYUKOH', 'Hyukoh'],
  ['검정치마', 'The Black Skirts'],
  ['백예린', 'Yerin Baek', 'Baek Yerin'],
  ['크러쉬', 'Crush', 'CRUSH'],
  ['지코', 'ZICO', 'Zico'],
  ['딘', 'DEAN', 'Dean'],
  ['우즈', 'WOODZ', '조승연'],
  ['헤이즈', 'Heize', 'HEIZE'],
  ['선미', 'SUNMI', 'Sunmi'],
  ['청하', 'CHUNG HA', 'Chungha'],
  ['비비', 'BIBI', 'Bibi'],
  ['이영지', 'Lee Young Ji', 'Lee Youngji'],
  ['폴킴', 'Paul Kim'],
  ['성시경', 'Sung Si Kyung'],
  ['멜로망스', 'MeloMance'],
  ['김민석', 'Kim Min Seok'],
  ['이무진', 'Lee Mujin'],
  ['임영웅', 'Lim Young Woong'],
  ['박재범', 'Jay Park'],
  ['창모', 'CHANGMO'],
  ['애쉬 아일랜드', '애쉬아일랜드', 'ASH ISLAND'],
  ['릴러말즈', 'Leellamarz'],
  ['다이나믹 듀오', '다이나믹듀오', 'Dynamicduo', 'Dynamic Duo'],
  ['실리카겔', 'Silica Gel'],
  ['루시', 'LUCY'],
  ['이클립스', 'ECLIPSE'],
  ['로제', 'ROSÉ', 'ROSE'],
  ['제니', 'JENNIE'],
  ['리사', 'LISA'],
  ['지수', 'JISOO'],
  ['정국', 'Jungkook', 'Jung Kook'],
  ['지민', 'Jimin', 'JIMIN'],
  ['뷔', 'V'],
  ['슈가', 'SUGA', 'Agust D'],
  ['백현', 'BAEKHYUN'],
  ['엑소', 'EXO'],
  ['샤이니', 'SHINee'],
  ['하이라이트', 'HIGHLIGHT', '비스트', 'BEAST'],
  ['비투비', 'BTOB'],
  ['인피니트', 'INFINITE'],
  ['카라', 'KARA'],
  ['원더걸스', 'Wonder Girls'],
  ['투애니원', '2NE1'],
  ['씨스타', 'SISTAR'],
  ['에이핑크', 'Apink'],
  ['걸스데이', 'Girls Day'],
  ['여자친구', 'GFRIEND'],
  ['비비지', 'VIVIZ'],
  ['권은비', 'KWON EUNBI'],
  ['최예나', 'YENA'],
  ['조유리', 'JO YURI'],
  ['아이즈원', 'IZ*ONE', 'IZONE'],
  ['박효신', 'Park Hyo Shin'],
  ['김범수', 'Kim Bum Soo'],
  ['나얼', 'Naul'],
  ['버즈', 'Buzz'],
  ['엠씨더맥스', 'M.C the MAX', 'MC THE MAX'],
  ['넬', 'NELL', 'Nell'],
  ['자우림', 'Jaurim'],
  ['이승기', 'Lee Seung Gi'],
  ['케이윌', 'K.Will', 'K.will'],
  ['거미', 'Gummy'],
  ['린', 'LYn'],
  ['에일리', 'Ailee'],
  ['정은지', 'Jeong Eun Ji'],
  ['이하이', 'LeeHi', 'Lee Hi'],
  ['수지', 'SUZY', 'Suzy']
];

/**
 * 상위 레이스 AbortSignal과 개별 타임아웃(기본 2400ms)을 결합한 초고속 fetch 래퍼
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 2400, parentSignal = null) {
  if (parentSignal && parentSignal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();

  if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function normalizeForCompare(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function normalizeWithoutBrackets(str = '') {
  return normalizeForCompare(
    String(str).replace(/[\(\[\{【『（][^)\]}】』）]*[\)\]\}】』）]/g, ' ')
  );
}

/**
 * 프리페칭/영구캐시/세션캐시가 모두 공유하는 정규화된 트랙 고유 키 생성
 */
function buildCanonicalTrackKey(meta, titleVariants = [], artistVariants = []) {
  const t = normalizeWithoutBrackets(titleVariants[0] || meta.cleanTitle || meta.rawTitle || '');
  const a = normalizeWithoutBrackets(artistVariants[0] || meta.cleanArtist || meta.rawArtist || '');
  return `${t}::${a}`;
}

function generateTitleVariants(rawTitle = '', cleanTitle = '', enTitle = '') {
  const ordered = [];
  const addUnique = (val) => {
    const t = String(val || '').trim();
    if (t && !ordered.includes(t)) ordered.push(t);
  };

  // 괄호 내부가 부가 정보(OST, Part, 리마스터, 버전, 피처링 등)인지 판별하는 정규식
  const bracketMetaNoiseRegex =
    /(?:\b(?:mv|m\/v|ost|part|pt|ver|version|inst|instrumental|live|audio|video|hd|4k|hq|official|lyrics?|feat|ft|with|prod|produced|remix|remaster(?:ed)?|edit|mix|acoustic|clean|explicit|session|clip|special|original|soundtrack|theme|from|intro|outro|solo|japanese|korean|english)\b|\d{4}|뮤직\s*비디오|뮤비|가사|공식|라이브|리마스터|녹음실|반주|음원|노래방|드라마|영화|웹툰|스페셜|버전|편곡)/i;

  const seeds = [cleanTitle, enTitle, rawTitle].filter(Boolean);

  // 각 언어의 대표 제목을 먼저 배치한다. 괄호 변형이 영문 제목을 밀어내지 않게 한다.
  for (const seed of seeds) {
    addUnique(String(seed).replace(/[\(\[\{【『（][^)\]}】』）]*[\)\]\}】』）]/g, ' ').replace(/\s{2,}/g, ' ').trim());
  }

  for (const seed of seeds) {
    const base = String(seed).trim();
    if (!base) continue;

    const withoutBrackets = base
      .replace(/[\(\[\{【『（][^)\]}】』）]*[\)\]\}】』）]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (withoutBrackets) {
      addUnique(withoutBrackets);
    }
    addUnique(base);

    const bracketMatches = [...base.matchAll(/[\(\[\{【『（]([^)\]}】』）]+)[\)\]\}】』）]/g)];
    for (const m of bracketMatches) {
      const inner = m[1].trim();
      // 순수 부제/영문 제목인 경우에만 후보에 추가하고, OST/버전/연도 등이 포함된 괄호는 절대 제목으로 쓰지 않음!
      if (inner.length >= 2 && !bracketMetaNoiseRegex.test(inner)) {
        addUnique(inner);
      }
    }
  }

  for (const v of [...ordered]) {
    const noPunct = v.replace(/[?!~.,'"’”`]+$/g, '').trim();
    if (noPunct && noPunct !== v) addUnique(noPunct);
  }

  return ordered;
}

function generateArtistVariants(rawArtist = '', cleanArtist = '', rawTitle = '', enArtist = '') {
  const variants = new Set();
  const seeds = [cleanArtist, enArtist, rawArtist].filter(Boolean);

  if (rawTitle) {
    const featMatch = rawTitle.match(/(?:feat|ft|with)\.?\s*([^)\]}]+)/i);
    if (featMatch && featMatch[1]) {
      seeds.push(featMatch[1].trim());
    }
  }

  for (const seed of seeds) {
    let base = String(seed)
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .split('•')[0]
      .trim();

    if (!base) continue;

    const splitParts = base
      .split(/\s*(?:,|&|\/|\s+및\s+|\band\b|\bwith\b|\bx\b|\bfeat\.?\b|\bft\.?\b)\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);

    const candidates = [...splitParts, base];

    for (const cand of candidates) {
      const outside = cand
        .replace(/[\(\[\{（][^)\]}）]+[\)\]\}）]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (outside) variants.add(outside);

      const insideMatches = [...cand.matchAll(/[\(\[\{（]([^)\]}）]+)[\)\]\}）]/g)];
      for (const m of insideMatches) {
        const inner = m[1].trim();
        if (inner) variants.add(inner);
      }

      variants.add(cand);
    }
  }

  for (const currentVar of [...variants]) {
    const normCur = normalizeForCompare(currentVar);
    if (!normCur) continue;

    for (const group of KOREAN_ARTIST_ALIAS_GROUPS) {
      const matched = group.some((alias) => normalizeForCompare(alias) === normCur);
      if (matched) {
        for (const alias of group) {
          variants.add(alias);
        }
      }
    }
  }

  return [...variants].filter(Boolean);
}

function isSubstringMatchSafe(strA = '', strB = '', minRatio = 0.6) {
  if (!strA || !strB) return false;
  const shorter = strA.length <= strB.length ? strA : strB;
  const longer = strA.length <= strB.length ? strB : strA;

  const isAsciiOnly = !/[^\x00-\x7F]/.test(shorter);
  const minChars = isAsciiOnly ? 4 : 2;
  if (shorter.length < minChars) return false;
  if (shorter.length / longer.length < minRatio) return false;

  return longer.includes(shorter);
}

function evaluateArtistSimilarity(itemArtist = '', targetArtistVariants = []) {
  if (!itemArtist || targetArtistVariants.length === 0) return 0;

  const normItem = normalizeForCompare(itemArtist);
  const normItemNoBracket = normalizeWithoutBrackets(itemArtist);
  if (!normItem) return 0;

  let bestSim = 0;

  for (const variant of targetArtistVariants) {
    const normVar = normalizeForCompare(variant);
    const normVarNoBracket = normalizeWithoutBrackets(variant);
    if (!normVar) continue;

    if (
      normItem === normVar ||
      normItemNoBracket === normVar ||
      (normItemNoBracket && normItemNoBracket === normVarNoBracket)
    ) {
      return 2;
    }

    if (
      isSubstringMatchSafe(normItem, normVar, 0.5) ||
      isSubstringMatchSafe(normItemNoBracket, normVarNoBracket, 0.5)
    ) {
      bestSim = Math.max(bestSim, 1);
    }
  }

  return bestSim;
}

function evaluateTitleSimilarity(itemTitle = '', targetTitleVariants = []) {
  if (!itemTitle || targetTitleVariants.length === 0) return 0;

  const normItem = normalizeForCompare(itemTitle);
  const normItemNoBracket = normalizeWithoutBrackets(itemTitle);
  if (!normItem) return 0;

  let bestSim = 0;

  for (const variant of targetTitleVariants) {
    const normVar = normalizeForCompare(variant);
    const normVarNoBracket = normalizeWithoutBrackets(variant);
    if (!normVar) continue;

    if (
      normItem === normVar ||
      normItemNoBracket === normVar ||
      (normItemNoBracket && normItemNoBracket === normVarNoBracket)
    ) {
      return 2;
    }

    // 1글자 제목("비", "너", "나")이나 짧은 단어가 전혀 다른 긴 곡 제목에 부분 포함되어 오매칭되는 현상 원천 차단!
    if (
      isSubstringMatchSafe(normItemNoBracket || normItem, normVarNoBracket || normVar, 0.62)
    ) {
      bestSim = Math.max(bestSim, 1);
    }
  }

  return bestSim;
}

function msToLrcTimestamp(ms) {
  const totalMs = Math.max(0, Math.round(Number(ms) || 0));
  const totalSec = totalMs / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  const millis = totalMs % 1000;
  return `[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}]`;
}

function isValidSyncedLrc(lrcText = '') {
  if (typeof lrcText !== 'string') return false;
  const matches = lrcText.match(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g);
  return Array.isArray(matches) && matches.length >= 3;
}

/* ==========================================================================
 * 유니코드 문자셋(Script) 기반 정밀 언어 판별 및 중국어 오매칭/번역줄 제거 엔진
 * - 일본곡(J-Pop: 히라가나/가타카나 포함) 100% 보존
 * - 중국곡(C-Pop: 제목/가수/앨범에 한자 포함 또는 중화권 아티스트) 100% 보존
 * - 한국곡/팝송/일본곡에서 엉뚱한 중국어 가사가 나오거나 중국어 번역줄이 섞이는 현상 완벽 차단
 * ========================================================================== */

const KNOWN_CPOP_ARTISTS = new Set([
  'jaychou',
  'mayday',
  'gem',
  'jjlin',
  'easonchan',
  'teresateng',
  'wangleehom',
  'jolintsai',
  'ericchou',
  'accusefive',
  'higherbrothers',
  'lexieliu',
  'fayewong',
  'jokerxue',
  'xuezhiqian',
  'layzhang',
  'jacksonwang',
  '9m88',
  'sunsetrollercoaster',
  'decajoins',
  'crowdlu',
  'sodagreen',
  'yogalin',
  'hebetien',
  'amei',
  'davidtao',
  'firdhaus',
  'stepjad',
  'knowknow',
  'masiwei',
  'dzknow'
]);

const HANGUL_REGEX = /[\uAC00-\uD7A3\u3131-\u318E]/g;
const KANA_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/g;
const HANZI_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF]/g;
const LATIN_REGEX = /[A-Za-z]/g;

// 일본어 상용한자에는 거의 쓰이지 않고 중국어(특히 간체/구어체)에서만 빈번하게 등장하는 문법 조사/글자
const CHINESE_SPECIFIC_CHARS_REGEX =
  /[这那们的了是在不我你他她它吗吧呢啊着过给让说爱觉现没听见动机电脑丧尸键盘复异议随时环播]/g;

function countRegexMatches(str, regex) {
  if (!str) return 0;
  const m = str.match(regex);
  return m ? m.length : 0;
}

/**
 * 현재 재생 중인 곡의 메타데이터(제목, 가수, 앨범)를 분석하여 언어 프로파일 산출
 */
function analyzeTrackLanguageProfile(meta = {}, artistVariants = []) {
  const combinedMeta = [
    meta.rawTitle,
    meta.cleanTitle,
    meta.rawArtist,
    meta.cleanArtist,
    meta.album
  ]
    .filter(Boolean)
    .join(' ');

  const hangulCount = countRegexMatches(combinedMeta, HANGUL_REGEX);
  const kanaCount = countRegexMatches(combinedMeta, KANA_REGEX);
  const hanziCount = countRegexMatches(combinedMeta, HANZI_REGEX);

  let isKoreanArtistAlias = false;
  let isKnownCpopArtist = false;

  for (const av of artistVariants) {
    const norm = normalizeForCompare(av);
    if (!norm) continue;
    if (KNOWN_CPOP_ARTISTS.has(norm)) {
      isKnownCpopArtist = true;
    }
    for (const group of KOREAN_ARTIST_ALIAS_GROUPS) {
      if (group.some((alias) => normalizeForCompare(alias) === norm)) {
        isKoreanArtistAlias = true;
        break;
      }
    }
  }

  const isKoreanTrack = hangulCount > 0 || isKoreanArtistAlias;
  const isJapaneseTrack = kanaCount > 0;
  // 제목/가수/앨범에 한자가 포함되어 있으면서 한글/히라가나/가타카나가 없거나, 알려진 중화권 아티스트인 경우 중국곡(C-Pop)으로 판정
  const isChineseTrack =
    (hanziCount > 0 && !isKoreanTrack && !isJapaneseTrack) || isKnownCpopArtist;

  return {
    isKoreanTrack,
    isJapaneseTrack,
    isChineseTrack,
    hangulCount,
    kanaCount,
    hanziCount
  };
}

function isIntroOrCreditText(text = '') {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(?:작사|작곡|편곡|노래|가수|보컬|코러스|프로듀서|프로듀싱|원곡|번역|개사|싱크|제작|출처|앨범|타이틀|등록자|감수|词|作词|曲|作曲|编曲|演唱|歌手|歌名|专辑|混音|制作人|プロデューサー|作詞|作曲|編曲|唄|歌|lyricist|composer|arranged\s*by|produced\s*by|prod\.?\s*by|lyrics?\s*by|music\s*by|written\s*by|vocal\s*by|mixed\s*by|mastered\s*by|translated\s*by|sync\s*by|lrc\s*by)\s*[:：\-]/i.test(
    trimmed
  );
}

/**
 * 한 줄 내에 병기된 중국어 번역(예: "원문 가사 / 中文翻译" 또는 "원문 가사 【中文翻译】")을 분리 제거
 */
function stripInlineChineseTranslation(text = '') {
  let cleaned = text;

  // 1. 【...】 또는 《...》 내부가 순수 한자(가나/한글 없음)이고 바깥에 원문이 있는 경우 괄호 번역 제거
  cleaned = cleaned.replace(/\s*[【《（\[]([^】》）\]]+)[】》）\]]\s*$/u, (full, inner) => {
    const innerHanzi = countRegexMatches(inner, HANZI_REGEX);
    const innerHangul = countRegexMatches(inner, HANGUL_REGEX);
    const innerKana = countRegexMatches(inner, KANA_REGEX);
    if (innerHanzi >= 2 && innerHangul === 0 && innerKana === 0) {
      return '';
    }
    return full;
  });

  // 2. "원문 / 중국어번역" 형태 분리
  const slashParts = cleaned.split(/\s+(?:\/|／／|｜|\|)\s+/);
  if (slashParts.length === 2) {
    const [left, right] = slashParts;
    const leftHangul = countRegexMatches(left, HANGUL_REGEX);
    const leftKana = countRegexMatches(left, KANA_REGEX);
    const leftLatin = countRegexMatches(left, LATIN_REGEX);
    const leftHanzi = countRegexMatches(left, HANZI_REGEX);

    const rightHanzi = countRegexMatches(right, HANZI_REGEX);
    const rightHangul = countRegexMatches(right, HANGUL_REGEX);
    const rightKana = countRegexMatches(right, KANA_REGEX);

    if (
      (leftHangul > 0 || leftKana > 0 || (leftLatin >= 2 && leftHanzi === 0)) &&
      rightHanzi >= 2 &&
      rightHangul === 0 &&
      rightKana === 0
    ) {
      cleaned = left.trim();
    }
  }

  return cleaned.trim();
}

/**
 * 가사 본문의 유니코드 문자셋 분포를 정밀 검사하여:
 * 1) 실제 중국곡(C-Pop)이나 YTM 공식 가사는 그대로 통과
 * 2) 일본곡(J-Pop: 히라가나/가타카나 포함)은 일본어 원문을 보존하되 중국어 번역 줄이 붙어있으면 번역 줄만 제거
 * 3) 한국곡/영어곡/일본곡인데 본문이 중국어 가사(동명이곡 중국 노래 또는 중국어 단독 번역본)인 경우 null 반환(즉시 기각)
 * 4) 한국곡/영어곡에 중국어 번역이 이중언어(Bilingual)로 함께 들어있는 경우 중국어 번역 줄만 깨끗이 제거 후 원문 반환
 */
function validateAndCleanLyricsLanguage(rawLrc, langProfile, sourceStage = '') {
  if (!rawLrc || typeof rawLrc !== 'string') return null;
  if (!isValidSyncedLrc(rawLrc)) return null;

  // 1. YouTube Music 공식 TimedLyrics(현재 재생 중인 videoId 직접 추출)이거나 실제 중국곡(C-Pop)이면 무조건 허용
  if (sourceStage === 'ytm_timed_lyrics' || (langProfile && langProfile.isChineseTrack)) {
    return rawLrc.trim();
  }

  const rawLines = rawLrc.split(/\r?\n/);
  const parsedEntries = [];
  const timeTagLineRegex = /^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/;
  const singleTimeRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/;

  let totalHangul = 0;
  let totalKana = 0;
  let totalHanzi = 0;
  let totalLatin = 0;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const match = trimmed.match(timeTagLineRegex);
    if (!match) {
      parsedEntries.push({ isMetaTag: true, rawLine: trimmed });
      continue;
    }

    const prefixTags = match[1];
    const tMatch = prefixTags.match(singleTimeRegex);
    let timeSec = 0;
    if (tMatch) {
      const m = parseInt(tMatch[1], 10);
      const s = parseInt(tMatch[2], 10);
      const msStr = (tMatch[3] || '0').padEnd(3, '0').slice(0, 3);
      timeSec = m * 60 + s + parseInt(msStr, 10) / 1000;
    }

    const text = stripInlineChineseTranslation(match[2] || '');
    const isCredit = isIntroOrCreditText(text);

    const hangul = countRegexMatches(text, HANGUL_REGEX);
    const kana = countRegexMatches(text, KANA_REGEX);
    const hanzi = countRegexMatches(text, HANZI_REGEX);
    const latin = countRegexMatches(text, LATIN_REGEX);
    const cnSpec = countRegexMatches(text, CHINESE_SPECIFIC_CHARS_REGEX);

    if (!isCredit && text.length > 0) {
      totalHangul += hangul;
      totalKana += kana;
      totalHanzi += hanzi;
      totalLatin += latin;
    }

    parsedEntries.push({
      isMetaTag: false,
      prefixTags,
      timeSec,
      text,
      isCredit,
      hangul,
      kana,
      hanzi,
      latin,
      cnSpec
    });
  }

  // 2. 일본어 가사(J-Pop) 판별:
  // 일본어 가사는 한자(Kanji)가 많아도 조사와 어미 때문에 히라가나/가타카나(kana)가 반드시 함께 등장함
  const isJapaneseLyricBody =
    (langProfile && langProfile.isJapaneseTrack && totalKana >= 3) ||
    (totalKana >= 8 && totalKana / Math.max(1, totalKana + totalHanzi) >= 0.12);

  if (isJapaneseLyricBody) {
    // 일본곡(J-Pop)인 경우:
    // 간혹 NetEase/QQ에서 [일본어 원문 줄] + [중국어 번역 줄(히라가나 0개, 한자만 가득)]이 쌍으로 들어있는 경우가 있으므로
    // 동일/인접 타임스탬프의 순수 중국어 번역 줄만 제거하고 일본어 원문은 100% 보존!
    const keptLines = [];
    for (let i = 0; i < parsedEntries.length; i++) {
      const cur = parsedEntries[i];
      if (cur.isMetaTag) {
        keptLines.push(cur.rawLine);
        continue;
      }

      const isPureChineseTranslationForJp =
        !cur.isCredit &&
        cur.kana === 0 &&
        cur.hangul === 0 &&
        cur.hanzi >= 3 &&
        (cur.cnSpec >= 1 ||
          parsedEntries.some(
            (other, idx) =>
              idx !== i &&
              !other.isMetaTag &&
              Math.abs(other.timeSec - cur.timeSec) <= 0.35 &&
              other.kana >= 1
          ));

      if (isPureChineseTranslationForJp) {
        continue;
      }

      keptLines.push(`${cur.prefixTags}${cur.text}`);
    }

    const joinedJp = keptLines.join('\n').trim();
    return isValidSyncedLrc(joinedJp) ? joinedJp : null;
  }

  // 3. 비(非)중국곡 & 비(非)일본어 본문 (즉, 한국곡 K-Pop, 영어 팝송, 혹은 일본곡인데 중국어 번역만 온 경우):
  // Step 3-A: 동일/인접 타임스탬프(<= 0.35s)에 원문(한글/영문) 줄과 중국어 번역(한자) 줄이 쌍으로 존재하는 이중언어(Bilingual) LRC인지 확인 후 번역 쌍 제거
  const nonBilingualEntries = [];
  for (let i = 0; i < parsedEntries.length; i++) {
    const cur = parsedEntries[i];
    if (cur.isMetaTag) {
      nonBilingualEntries.push(cur);
      continue;
    }

    const isChineseLine = cur.hanzi >= 1 && cur.hangul === 0 && cur.kana === 0;
    if (isChineseLine && !cur.isCredit) {
      const hasOriginalTwin = parsedEntries.some(
        (other, idx) =>
          idx !== i &&
          !other.isMetaTag &&
          Math.abs(other.timeSec - cur.timeSec) <= 0.4 &&
          other.hanzi === 0 &&
          (other.hangul >= 1 || other.kana >= 1 || other.latin >= 2)
      );
      if (hasOriginalTwin) {
        // 원문 줄과 같은 타임스탬프를 공유하는 중국어 번역 줄이므로 제거
        continue;
      }
    }

    nonBilingualEntries.push(cur);
  }

  // Step 3-B: 번역 쌍을 제거하고 남은 실제 가사 라인들의 문자셋 비율 검사
  const lyricEntries = nonBilingualEntries.filter(
    (e) => !e.isMetaTag && !e.isCredit && e.text.trim().length > 0
  );

  if (lyricEntries.length < 3) return null;

  let remainingChineseLines = 0;
  let remainingHangulChars = 0;
  let remainingKanaChars = 0;
  let remainingHanziChars = 0;

  for (const entry of lyricEntries) {
    remainingHangulChars += entry.hangul;
    remainingKanaChars += entry.kana;
    remainingHanziChars += entry.hanzi;

    if (entry.hanzi >= 1 && entry.hangul === 0 && entry.kana === 0) {
      remainingChineseLines++;
    }
  }

  const chineseLineRatio = remainingChineseLines / lyricEntries.length;

  // [핵심 차단 조건 1] 비중국곡인데 전체 가사 줄의 15% 이상이 중국어 한자 줄(예: 사용자 스크린샷처럼 영어가 조금 섞인 중국어 가사)인 경우 즉시 기각!
  if (chineseLineRatio >= 0.15) {
    return null;
  }

  // [핵심 차단 조건 2] 한국곡(제목/가수에 한글 포함)인데 가사에 한글이 전혀 없고 한자만 있는 경우 즉시 기각!
  if (langProfile && langProfile.isKoreanTrack && remainingHangulChars === 0 && remainingHanziChars >= 4) {
    return null;
  }

  // [핵심 차단 조건 3] 일본곡(제목/가수에 가나 포함)인데 가사에 히라가나/가타카나가 거의 없고 중국어 한자만 있는 경우 즉시 기각!
  if (langProfile && langProfile.isJapaneseTrack && remainingKanaChars < 3 && remainingHanziChars >= 4) {
    return null;
  }

  // Step 3-C: 혹시라도 1~2줄 남은 잔여 중국어 번역/크레딧 줄(한글/가나 0개, 한자 2개 이상)까지 깔끔하게 필터링
  const finalLines = [];
  for (const entry of nonBilingualEntries) {
    if (entry.isMetaTag) {
      finalLines.push(entry.rawLine);
      continue;
    }
    if (entry.hanzi >= 2 && entry.hangul === 0 && entry.kana === 0) {
      continue;
    }
    finalLines.push(`${entry.prefixTags}${entry.text}`);
  }

  const finalLrc = finalLines.join('\n').trim();
  return isValidSyncedLrc(finalLrc) ? finalLrc : null;
}

/* ==========================================================================
 * [Source 1] YouTube Music 모바일 TimedLyrics API
 * ========================================================================== */

function findNestedKey(obj, targetKey) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, targetKey) && obj[targetKey]) {
    return obj[targetKey];
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findNestedKey(val, targetKey);
      if (found) return found;
    }
  }
  return null;
}

// WEB_REMIX와 ANDROID_MUSIC은 같은 lyrics browseId를 사용할 수 있다.
// 응답 형식은 browse 요청의 client context로 결정된다.
function extractYtmLyrics(browseData) {
  const timed = findNestedKey(browseData, 'timedLyricsData');
  const readText = (value) => typeof value === 'string' ? value
    : value?.simpleText || value?.runs?.map((r) => r.text || '').join('') || '';
  const rows = Array.isArray(timed) ? timed : [];
  const lines = rows.filter((item) => item && typeof item === 'object').map((item) => ({
    text: readText(item.lyricLine ?? item.text).trim(),
    time: item.cueRange?.startTimeMilliseconds ?? item.startTimeMs ?? item.cueRange?.startTimeMs
  })).filter((row) => row.text);
  if (lines.length && lines.every((row) => row.time !== undefined && row.time !== null &&
      row.time !== '' && Number.isFinite(Number(row.time)) && Number(row.time) >= 0)) {
    return {
      status: 'synced',
      syncedLyrics: lines.map((row) => `${msToLrcTimestamp(row.time)}${row.text}`).join('\n'),
      plainLyrics: null,
      sourceStage: 'ytm_timed_lyrics'
    };
  }
  const shelf = findNestedKey(browseData, 'musicDescriptionShelfRenderer');
  const plain = lines.map((row) => row.text).join('\n') || readText(shelf?.description).trim();
  return plain ? {
    status: 'plain', syncedLyrics: null, plainLyrics: plain, sourceStage: 'ytm_timed_lyrics'
  } : null;
}

function findLyricsBrowseId(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.browseId === 'string' && data.browseId.startsWith('MPLYt')) return data.browseId;
  for (const value of Object.values(data)) {
    const id = findLyricsBrowseId(value);
    if (id) return id;
  }
  return '';
}

async function trySource1YtmTimedLyrics(
  videoId,
  preFetchedBrowseId = '',
  signal = null,
  titleVariants = [],
  artistVariants = []
) {
  if (!videoId && !preFetchedBrowseId) return null;
  await ensureDeclarativeNetRequestRules();
  const android = { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50', hl: 'ko', gl: 'KR' };
  const web = {
    clientName: 'WEB_REMIX',
    clientVersion: `1.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.01.00`,
    hl: 'ko', gl: 'KR'
  };
  let hadError = false;
  let plainFallback = null;
  let visitorData = '';
  const tried = new Set();

  const request = async (endpoint, client, body) => {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
      const response = await fetchWithTimeout(
        `https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false${client.clientName === 'ANDROID_MUSIC' ? '&ytm_mobile=1' : ''}`,
        {
          method: 'POST', credentials: 'omit', headers,
          body: JSON.stringify({ context: { client: { ...client, ...(visitorData ? { visitorData } : {}) } }, ...body })
        },
        6500, signal
      );
      if (!response.ok) throw new Error(`YTM HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error('YTM API error');
      visitorData = data.responseContext?.visitorData || visitorData;
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      hadError = true;
      return null;
    }
  };
  const browse = async (id, client) => {
    const key = `${client.clientName}:${id}`;
    if (!id || tried.has(key)) return null;
    tried.add(key);
    const result = extractYtmLyrics(await request('browse', client, { browseId: id }));
    if (result?.status === 'plain') plainFallback ||= result;
    return result?.status === 'synced' ? { ...result, videoId } : null;
  };

  // 이미 얻은 ID부터 사용한다. 모바일 next 실패가 이 경로를 막으면 안 된다.
  if (preFetchedBrowseId) {
    const result = await browse(preFetchedBrowseId, android);
    if (result) return result;
  }
  let resolvedId = preFetchedBrowseId;
  if (videoId) {
    for (const client of [web, android]) {
      const next = await request('next', client, {
        videoId, playlistId: `RDAMVM${videoId}`, isAudioOnly: true,
        enablePersistentPlaylistPanel: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
        watchEndpointMusicSupportedConfigs: {
          watchEndpointMusicConfig: { hasPersistentPlaylistPanel: true, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' }
        }
      });
      const id = findLyricsBrowseId(next);
      if (!id) continue;
      resolvedId = id;
      const result = await browse(id, android);
      if (result) return result;
      if (plainFallback) break;
    }
  }
  // 다른 녹음/MV를 검색해서 현재 트랙에 그 타임스탬프를 적용하지 않는다.
  if (!plainFallback && resolvedId) {
    const result = await browse(resolvedId, web);
    if (result) return result;
  }
  if (plainFallback) return { ...plainFallback, videoId };
  return hadError ? { status: 'error', sourceStage: 'ytm_timed_lyrics' } : null;
}

/* ==========================================================================
 * [Source 2] 알송(Alsong) 국내 음원 실시간 싱크 가사 SOAP API (병렬 다중 쿼리 + 엄격 검증)
 * ========================================================================== */

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(str = '') {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

async function queryAlsongSoapSingle(title, artist, signal) {
  await ensureDeclarativeNetRequestRules();

  const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:SOAP-ENC="http://www.w3.org/2003/05/soap-encoding" xmlns:ns1="ALSongWebServer/Service1Soap" xmlns:ns2="ALSongWebServer">
  <SOAP-ENV:Body>
    <ns2:GetResembleLyric2>
      <ns2:stQuery>
        <ns2:strTitle>${escapeXml(title)}</ns2:strTitle>
        <ns2:strArtistName>${escapeXml(artist)}</ns2:strArtistName>
        <ns2:nCurPage>0</ns2:nCurPage>
      </ns2:stQuery>
    </ns2:GetResembleLyric2>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

  const reqInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      'SOAPAction': 'ALSongWebServer/GetResembleLyric2'
    },
    body: soapBody
  };

  for (const url of [ALSONG_HTTPS_URL, ALSONG_HTTP_URL]) {
    try {
      const res = await fetchWithTimeout(url, reqInit, 2200, signal);
      if (res.ok) return await res.text();
    } catch (e) {}
  }

  return null;
}

async function trySource2AlsongLyrics(titleVariants, artistVariants, langProfile = null, signal = null) {
  const primaryTitle = titleVariants[0];
  if (!primaryTitle) return null;

  const pairMap = new Map();
  const addPair = (t, a) => {
    if (!t) return;
    const key = `${t}:::${a || ''}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, { title: t, artist: a || '' });
    }
  };

  if (artistVariants[0]) addPair(primaryTitle, artistVariants[0]);
  if (artistVariants[1]) addPair(primaryTitle, artistVariants[1]);
  if (titleVariants[1] && artistVariants[0]) addPair(titleVariants[1], artistVariants[0]);
  // 아티스트 표기가 알송 DB와 미세하게 다른 곡을 위해 제목 단독 쿼리도 함께 병렬 실행하되,
  // 결과 채택 시에는 반드시 artistSim >= 1을 통과한 곡만 허용!
  addPair(primaryTitle, '');

  const pairs = [...pairMap.values()].slice(0, 4);

  const xmlResults = await Promise.all(
    pairs.map((p) => queryAlsongSoapSingle(p.title, p.artist, signal))
  );

  const scoredCandidates = [];

  for (const xmlText of xmlResults) {
    if (!xmlText) continue;

    const itemBlocks = [
      ...xmlText.matchAll(
        /<ST_GET_RESEMBLELYRIC2_RETURN>([\s\S]*?)<\/ST_GET_RESEMBLELYRIC2_RETURN>/g
      )
    ];

    for (const blockMatch of itemBlocks) {
      const block = blockMatch[1];
      const titleMatch = block.match(/<strTitle>([\s\S]*?)<\/strTitle>/);
      const artistMatch = block.match(/<strArtist(?:Name)?>([\s\S]*?)<\/strArtist(?:Name)?>/);
      const lyricMatch = block.match(/<strLyric>([\s\S]*?)<\/strLyric>/);

      if (!lyricMatch) continue;

      const itemTitle = decodeXmlEntities(titleMatch ? titleMatch[1] : '');
      const itemArtist = decodeXmlEntities(artistMatch ? artistMatch[1] : '');

      const titleSim = evaluateTitleSimilarity(itemTitle, titleVariants);
      const artistSim = evaluateArtistSimilarity(itemArtist, artistVariants);

      // [핵심 버그 수정] 알송에서 아티스트가 일치하지 않는 동명이곡(artistSim === 0)을 반환하면
      // 아예 다른 가수의 노래 가사가 나오는 문제가 발생하므로, 반드시 제목과 아티스트가 모두 매칭되어야만 채택!
      if (titleSim === 0 || artistSim === 0) continue;

      const rawLyric = decodeXmlEntities(lyricMatch[1])
        .replace(/<br\s*\/?>/gi, '\n')
        .trim();

      const validatedLrc = validateAndCleanLyricsLanguage(rawLyric, langProfile, 'alsong_lrc');
      if (!validatedLrc) continue;

      const score = titleSim * 50 + artistSim * 50;
      scoredCandidates.push({
        score,
        resultObj: {
          status: 'synced',
          syncedLyrics: validatedLrc,
          plainLyrics: null,
          trackName: itemTitle,
          artistName: itemArtist,
          sourceStage: 'alsong_lrc'
        }
      });
    }
  }

  if (scoredCandidates.length === 0) return null;
  scoredCandidates.sort((a, b) => b.score - a.score);
  return scoredCandidates[0].resultObj;
}

function decodeBase64Utf8(base64Str) {
  const binaryStr = atob(base64Str.replace(/\s/g, ''));
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/* ==========================================================================
 * [Source 3] NetEase Cloud Music LRC API (병렬 쿼리 + 아티스트 검증 강화 + 언어 필터)
 * ========================================================================== */

async function searchNetEaseSingleQuery(
  keyword,
  titleVariants,
  artistVariants,
  targetDurSec,
  langProfile,
  signal
) {
  try {
    const bodyParams = new URLSearchParams({
      s: keyword,
      type: '1',
      offset: '0',
      total: 'true',
      limit: '10'
    });

    const searchRes = await fetchWithTimeout(
      NETEASE_SEARCH_URL,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: bodyParams.toString()
      },
      2300,
      signal
    );

    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const songs = searchData?.result?.songs;
    if (!Array.isArray(songs) || songs.length === 0) return null;

    const scoredSongs = [];

    for (const song of songs) {
      const allSongTitles = [
        song.name || '',
        ...(Array.isArray(song.alias) ? song.alias : []),
        ...(Array.isArray(song.transNames) ? song.transNames : [])
      ].filter(Boolean);

      let titleSim = 0;
      for (const st of allSongTitles) {
        const sim = evaluateTitleSimilarity(st, titleVariants);
        if (sim > titleSim) titleSim = sim;
      }

      const songArtists = Array.isArray(song.artists)
        ? song.artists
            .flatMap((a) => [a.name, ...(Array.isArray(a.alias) ? a.alias : [])])
            .filter(Boolean)
            .join(' ')
        : '';
      const songDurSec = song.duration ? Number(song.duration) / 1000 : 0;

      const artistSim = evaluateArtistSimilarity(songArtists, artistVariants);
      const hasDur = targetDurSec > 0 && songDurSec > 0;
      const durDiff = hasDur ? Math.abs(songDurSec - targetDurSec) : 0;

      // [핵심 버그 수정]
      // 1) 제목 유사도가 0인 곡(titleSim === 0)은 같은 가수의 다른 곡이 길이만 비슷한 경우이므로 무조건 차단!
      if (titleSim === 0) {
        continue;
      }
      // 2) 길이 오차가 7초를 초과하는 다른 버전/다른 곡은 즉시 차단!
      if (hasDur && durDiff > 7.0) {
        continue;
      }
      // 3) 아티스트가 전혀 일치하지 않는 경우(artistSim === 0)는
      //    5글자 이상 긴 고유 제목 완전 일치(titleSim === 2) + 길이 오차 1.5초 이내일 때만 예외 허용!
      const normPrimaryLen = normalizeWithoutBrackets(titleVariants[0] || '').length;
      if (artistSim === 0 && !(titleSim === 2 && hasDur && durDiff <= 1.5 && normPrimaryLen >= 5)) {
        continue;
      }

      let score = titleSim * 30 + artistSim * 32;
      if (hasDur) {
        if (durDiff <= 2.5) score += 45;
        else if (durDiff <= 5) score += 25;
        else if (durDiff <= 7) score += 8;
        else score -= 40;
      }

      if (score >= 60) {
        scoredSongs.push({ song, score });
      }
    }

    scoredSongs.sort((a, b) => b.score - a.score);
    if (scoredSongs.length === 0) return null;

    // 상위 3개 후보까지 검사하여 원어 검증을 통과하는 첫 후보 채택
    for (const candidate of scoredSongs.slice(0, 3)) {
      const lyricParams = new URLSearchParams({
        os: 'pc',
        id: String(candidate.song.id),
        lv: '-1',
        kv: '-1',
        tv: '-1'
      });

      const lyricRes = await fetchWithTimeout(
        `${NETEASE_LYRIC_URL}?${lyricParams.toString()}`,
        { method: 'GET', headers: { 'Accept': 'application/json' } },
        2200,
        signal
      );

      if (!lyricRes.ok) continue;
      const lyricData = await lyricRes.json();
      const rawLrc = lyricData?.lrc?.lyric;

      if (typeof rawLrc === 'string') {
        const validatedLrc = validateAndCleanLyricsLanguage(rawLrc, langProfile, 'netease_lrc');
        if (validatedLrc) {
          return {
            status: 'synced',
            syncedLyrics: validatedLrc,
            plainLyrics: null,
            trackName: candidate.song.name || titleVariants[0],
            artistName: artistVariants[0] || '',
            sourceStage: 'netease_lrc'
          };
        }
      }
    }
  } catch (e) {}

  return null;
}

async function trySource4NetEaseLyrics(
  titleVariants,
  artistVariants,
  duration,
  langProfile = null,
  signal = null
) {
  if (titleVariants.length === 0) return null;

  await ensureDeclarativeNetRequestRules();

  const targetDurSec = Number(duration) || 0;
  const queries = [];
  if (artistVariants[0]) queries.push(`${titleVariants[0]} ${artistVariants[0]}`.trim());
  if (titleVariants[1]) {
    queries.push(`${titleVariants[1]} ${artistVariants[1] || artistVariants[0] || ''}`.trim());
  }
  queries.push(titleVariants[0]);

  const uniqueQueries = [...new Set(queries.filter(Boolean))].slice(0, 3);
  const results = await Promise.all(
    uniqueQueries.map((q) =>
      searchNetEaseSingleQuery(q, titleVariants, artistVariants, targetDurSec, langProfile, signal)
    )
  );

  return results.find((r) => r && r.status === 'synced') || null;
}

/* ==========================================================================
 * [Source 4] QQ Music LRC API (병렬 쿼리 + 아티스트 검증 강화 + 언어 필터)
 * ========================================================================== */

async function searchQQSingleQuery(
  keyword,
  titleVariants,
  artistVariants,
  targetDurSec,
  langProfile,
  signal
) {
  try {
    const searchParams = new URLSearchParams({
      ct: '24',
      qqmusic_ver: '1298',
      new_json: '1',
      remoteplace: 'txt.yqq.song',
      t: '0',
      aggr: '1',
      cr: '1',
      catZhida: '1',
      lossless: '0',
      flag_qc: '0',
      p: '1',
      n: '8',
      w: keyword,
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8'
    });

    const searchRes = await fetchWithTimeout(
      `${QQ_SEARCH_URL}?${searchParams.toString()}`,
      { method: 'GET', headers: { 'Accept': 'application/json' } },
      2300,
      signal
    );

    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const songs = searchData?.data?.song?.list;
    if (!Array.isArray(songs) || songs.length === 0) return null;

    const scored = [];
    for (const song of songs) {
      const songMid = song.mid || song.songmid;
      if (!songMid) continue;

      const songTitles = [song.name, song.title, song.subtitle].filter(Boolean);
      let titleSim = 0;
      for (const st of songTitles) {
        const sim = evaluateTitleSimilarity(st, titleVariants);
        if (sim > titleSim) titleSim = sim;
      }

      const singerText = Array.isArray(song.singer)
        ? song.singer.map((s) => s.name || s.title).join(' ')
        : '';
      const artistSim = evaluateArtistSimilarity(singerText, artistVariants);
      const songDurSec = Number(song.interval) || 0;
      const hasDur = targetDurSec > 0 && songDurSec > 0;
      const durDiff = hasDur ? Math.abs(songDurSec - targetDurSec) : 0;

      // [핵심 버그 수정] 제목 불일치(titleSim === 0) 및 길이 오차 초과 즉시 차단!
      if (titleSim === 0) {
        continue;
      }
      if (hasDur && durDiff > 7.0) {
        continue;
      }
      const normPrimaryLen = normalizeWithoutBrackets(titleVariants[0] || '').length;
      if (artistSim === 0 && !(titleSim === 2 && hasDur && durDiff <= 1.5 && normPrimaryLen >= 5)) {
        continue;
      }

      let score = titleSim * 30 + artistSim * 32;
      if (hasDur) {
        if (durDiff <= 2.5) score += 45;
        else if (durDiff <= 5) score += 25;
        else if (durDiff <= 7) score += 8;
        else score -= 40;
      }

      if (score >= 60) {
        scored.push({ songMid, songName: song.name || song.title, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;

    for (const candidate of scored.slice(0, 3)) {
      const lyricParams = new URLSearchParams({
        songmid: candidate.songMid,
        g_tk: '5381',
        loginUin: '0',
        hostUin: '0',
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0'
      });

      const lyricRes = await fetchWithTimeout(
        `${QQ_LYRIC_URL}?${lyricParams.toString()}`,
        { method: 'GET', headers: { 'Accept': 'application/json' } },
        2200,
        signal
      );

      if (!lyricRes.ok) continue;
      const lyricData = await lyricRes.json();
      if (lyricData?.lyric) {
        const decoded = decodeXmlEntities(decodeBase64Utf8(lyricData.lyric));
        const validatedLrc = validateAndCleanLyricsLanguage(decoded, langProfile, 'qq_lrc');
        if (validatedLrc) {
          return {
            status: 'synced',
            syncedLyrics: validatedLrc,
            plainLyrics: null,
            trackName: candidate.songName || titleVariants[0],
            artistName: artistVariants[0] || '',
            sourceStage: 'qq_lrc'
          };
        }
      }
    }
  } catch (e) {}

  return null;
}

async function trySource5QQMusicLyrics(
  titleVariants,
  artistVariants,
  duration,
  langProfile = null,
  signal = null
) {
  if (titleVariants.length === 0) return null;

  await ensureDeclarativeNetRequestRules();

  const targetDurSec = Number(duration) || 0;
  const queries = [];
  if (artistVariants[0]) queries.push(`${titleVariants[0]} ${artistVariants[0]}`.trim());
  if (titleVariants[1]) {
    queries.push(`${titleVariants[1]} ${artistVariants[1] || artistVariants[0] || ''}`.trim());
  }
  queries.push(titleVariants[0]);

  const uniqueQueries = [...new Set(queries.filter(Boolean))].slice(0, 3);
  const results = await Promise.all(
    uniqueQueries.map((q) =>
      searchQQSingleQuery(q, titleVariants, artistVariants, targetDurSec, langProfile, signal)
    )
  );

  return results.find((r) => r && r.status === 'synced') || null;
}

/* ==========================================================================
 * [Source 5] LRCLIB 병렬 검색 파이프라인 (+ 언어 검증 필터 + 실시간 싱크 최우선 채택)
 * ========================================================================== */

function formatLrclibResult(item, sourceStage, langProfile = null) {
  if (!item) return null;

  if (item.instrumental) {
    return {
      status: 'instrumental',
      syncedLyrics: null,
      plainLyrics: null,
      trackName: item.trackName || '',
      artistName: item.artistName || '',
      sourceStage
    };
  }

  const validatedSynced =
    typeof item.syncedLyrics === 'string'
      ? validateAndCleanLyricsLanguage(item.syncedLyrics, langProfile, sourceStage)
      : null;
  const plain =
    typeof item.plainLyrics === 'string' && item.plainLyrics.trim().length > 0
      ? item.plainLyrics.trim()
      : null;

  if (!validatedSynced && !plain) return null;

  return {
    status: validatedSynced ? 'synced' : 'plain',
    syncedLyrics: validatedSynced,
    plainLyrics: plain,
    trackName: item.trackName || '',
    artistName: item.artistName || '',
    albumName: item.albumName || '',
    duration: item.duration || 0,
    sourceStage
  };
}

function pickBestLrclibMatch(items, context) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const { titleVariants = [], artistVariants = [], duration = 0, langProfile = null } = context;
  const targetDuration = Number(duration) || 0;
  const normPrimaryLen = normalizeWithoutBrackets(titleVariants[0] || '').length;

  const validCandidates = items.filter(
    (item) =>
      item &&
      ((typeof item.syncedLyrics === 'string' && item.syncedLyrics.trim().length > 0) ||
        (typeof item.plainLyrics === 'string' && item.plainLyrics.trim().length > 0))
  );

  if (validCandidates.length === 0) return null;

  const syncedScored = [];
  const plainScored = [];

  for (const item of validCandidates) {
    const validatedSynced =
      typeof item.syncedLyrics === 'string'
        ? validateAndCleanLyricsLanguage(item.syncedLyrics, langProfile, 'lrclib_structured')
        : null;
    const hasSynced = Boolean(validatedSynced);
    const itemDur = Number(item.duration) || 0;
    const titleSim = evaluateTitleSimilarity(item.trackName, titleVariants);
    const artistSim = evaluateArtistSimilarity(item.artistName, artistVariants);
    const hasDur = targetDuration > 0 && itemDur > 0;
    const durDiff = hasDur ? Math.abs(itemDur - targetDuration) : 0;

    // 1. 제목 불일치 즉시 제외
    if (titleSim === 0) continue;

    // 2. 길이 오차 8초 초과 즉시 제외
    if (hasDur && durDiff > 8.0) continue;

    // 3. 아티스트가 전혀 일치하지 않는 동명이곡(artistSim === 0) 차단:
    //    4글자 이상의 고유 제목이 완전 일치(titleSim === 2)하고 곡 길이가 2.0초 이내로 일치할 때만 예외 허용!
    if (artistSim === 0 && !(titleSim === 2 && hasDur && durDiff <= 2.0 && normPrimaryLen >= 4)) {
      continue;
    }

    let score = 0;
    if (titleSim === 2) score += 55;
    else if (titleSim === 1) score += 30;

    if (artistSim === 2) score += 55;
    else if (artistSim === 1) score += 35;

    if (hasDur) {
      if (durDiff <= 2) score += 45;
      else if (durDiff <= 5) score += 30;
      else if (durDiff <= 8) score += 12;
    }

    if (score < 60) continue;

    if (hasSynced) {
      syncedScored.push({ item, score });
    } else {
      plainScored.push({ item, score });
    }
  }

  // [핵심 버그 수정] 실시간 싱크 가사(syncedLyrics)가 있는 후보를 무조건 일반 가사(plainLyrics)보다 최우선 채택!
  if (syncedScored.length > 0) {
    syncedScored.sort((a, b) => b.score - a.score);
    return syncedScored[0].item;
  }

  if (plainScored.length > 0) {
    plainScored.sort((a, b) => b.score - a.score);
    return plainScored[0].item;
  }

  return null;
}

async function trySource6LrclibPipeline(
  titleVariants,
  artistVariants,
  duration,
  langProfile = null,
  signal = null,
  plainCollector = []
) {
  if (titleVariants.length === 0) return null;

  const paramList = [];
  const seenParams = new Set();
  const pushParams = (obj) => {
    const sp = new URLSearchParams(obj);
    const key = sp.toString();
    if (!seenParams.has(key)) {
      seenParams.add(key);
      paramList.push(sp);
    }
  };

  // 한글 원제(titleVariants[0])와 영문 제목(titleVariants[1])이 모두 상위 병렬 쿼리에 포함되도록 교차 배치!
  if (titleVariants[0] && artistVariants[0]) {
    pushParams({ track_name: titleVariants[0], artist_name: artistVariants[0] });
  }
  if (titleVariants[1] && (artistVariants[1] || artistVariants[0])) {
    pushParams({
      track_name: titleVariants[1],
      artist_name: artistVariants[1] || artistVariants[0]
    });
  }
  if (titleVariants[0] && artistVariants[1]) {
    pushParams({ track_name: titleVariants[0], artist_name: artistVariants[1] });
  }
  if (titleVariants[0]) {
    pushParams({ q: `${titleVariants[0]} ${artistVariants[0] || ''}`.trim() });
  }
  if (titleVariants[1]) {
    pushParams({ q: `${titleVariants[1]} ${artistVariants[1] || artistVariants[0] || ''}`.trim() });
  }

  const fetchOne = async (params) => {
    try {
      const res = await fetchWithTimeout(
        `${LRCLIB_BASE_URL}/search?${params.toString()}`,
        { method: 'GET', headers: LRCLIB_HEADERS },
        2300,
        signal
      );
      if (!res.ok) return null;
      const list = await res.json();
      const best = pickBestLrclibMatch(list, {
        titleVariants,
        artistVariants,
        duration,
        langProfile
      });
      const formatted = formatLrclibResult(best, 'lrclib_structured', langProfile);
      if (formatted) {
        if (formatted.status === 'synced') return formatted;
        plainCollector.push(formatted);
      }
    } catch (e) {}
    return null;
  };

  // 제목만으로도 조회하되 후보 선택 시 제목·아티스트·길이는 계속 검증한다.
  for (const title of titleVariants.slice(0, 3)) pushParams({ track_name: title });
  const results = await Promise.all(paramList.map(fetchOne));
  return results.find((r) => r && r.status === 'synced') || null;
}

/* ==========================================================================
 * 2-Tier 우선순위 선착순 레이싱 파이프라인 (Tier 1 원어 서버 우선권 + Tier 2 보완)
 * - 1군(Tier 1): YTM 공식 TimedLyrics + LRCLIB + 알송(Alsong)
 * - 2군(Tier 2): NetEase + QQ Music (언어 검증 통과 가사만 허용)
 * ========================================================================== */

function requireSyncedResult(promise) {
  return promise.then((res) => {
    if (res && res.status === 'synced' && res.syncedLyrics) {
      return res;
    }
    throw new Error('NoSyncedLyrics');
  });
}

async function fetchLyricsFromPreferredSource(meta, titleVariants, artistVariants, langProfile, canonicalKey) {
  const source = meta.preferredSource;
  const controller = new AbortController();
  const { signal } = controller;
  const plainCollector = [];

  // 사용자가 우클릭 메뉴에서 직접 특정 제공자를 지정한 경우
  const manualProfile =
    source === 'netease' || source === 'qq'
      ? { ...langProfile, isChineseTrack: true }
      : langProfile;

  let res = null;
  if (source === 'ytm') {
    res = await trySource1YtmTimedLyrics(
      meta.videoId,
      meta.lyricsBrowseId,
      signal,
      titleVariants,
      artistVariants
    );
  } else if (source === 'alsong') {
    res = await trySource2AlsongLyrics(titleVariants, artistVariants, manualProfile, signal);
  } else if (source === 'lrclib') {
    res = await trySource6LrclibPipeline(
      titleVariants,
      artistVariants,
      meta.duration,
      manualProfile,
      signal,
      plainCollector
    );
    if (!res && plainCollector.length > 0) {
      res = plainCollector[0];
    }
  } else if (source === 'netease') {
    res = await trySource4NetEaseLyrics(
      titleVariants,
      artistVariants,
      meta.duration,
      manualProfile,
      signal
    );
  } else if (source === 'qq') {
    res = await trySource5QQMusicLyrics(
      titleVariants,
      artistVariants,
      meta.duration,
      manualProfile,
      signal
    );
  }

  if (res?.status === 'error') return res;

  if (res && (res.status === 'synced' || res.status === 'plain')) {
    setSessionCache(canonicalKey, res);
    if (
      isPersistentCacheEnabled &&
      res.status === 'synced' &&
      (meta.persistToStorage || persistentLyricsCache.has(canonicalKey))
    ) {
      saveToPersistentStorage(canonicalKey, res, meta);
    }
    return res;
  }

  return {
    status: 'not_found',
    syncedLyrics: null,
    plainLyrics: null,
    trackName: titleVariants[0] || meta.rawTitle || '',
    artistName: artistVariants[0] || meta.rawArtist || '',
    sourceStage: 'none'
  };
}

async function fetchLyricsPipeline(meta) {
  await ensurePersistentStorageLoaded();

  const titleVariants = generateTitleVariants(meta.rawTitle, meta.cleanTitle, meta.enTitle);
  const artistVariants = generateArtistVariants(
    meta.rawArtist,
    meta.cleanArtist,
    meta.rawTitle,
    meta.enArtist
  );

  const langProfile = analyzeTrackLanguageProfile(meta, artistVariants);
  const canonicalKey = buildCanonicalTrackKey(meta, titleVariants, artistVariants);

  // 0. 사용자가 우클릭 메뉴에서 특정 가사 제공자를 직접 선택한 경우 즉시 해당 제공자에서 호출
  if (meta.preferredSource && meta.preferredSource !== 'auto') {
    return fetchLyricsFromPreferredSource(
      meta,
      titleVariants,
      artistVariants,
      langProfile,
      canonicalKey
    );
  }

  if (meta.forceRefresh) {
    sessionLyricsCache.delete(canonicalKey);
    persistentLyricsCache.delete(canonicalKey);
  }

  // 캐시 엔트리가 과거 잘못된 매칭(다른 곡 제목 또는 알송 동명이곡 타 가수)으로 저장되었는지 교차 검증
  const isCachedTrackMismatched = (entry) => {
    if (!entry) return true;
    if (
      entry.sourceStage === 'ytm_timed_lyrics' &&
      entry.videoId &&
      meta.videoId &&
      entry.videoId !== meta.videoId
    ) {
      return true;
    }
    if (entry.sourceStage !== 'ytm_timed_lyrics' && entry.trackName) {
      if (evaluateTitleSimilarity(entry.trackName, titleVariants) === 0) {
        return true;
      }
      if (
        entry.sourceStage === 'alsong_lrc' &&
        entry.artistName &&
        evaluateArtistSimilarity(entry.artistName, artistVariants) === 0
      ) {
        return true;
      }
    }
    return false;
  };

  // 1. 영구 로컬 캐시(좋아요/저장목록 곡) 또는 현재 세션 캐시(프리페칭 포함) 즉시 히트 (0.01초!)
  if (isPersistentCacheEnabled && persistentLyricsCache.has(canonicalKey)) {
    const pCached = persistentLyricsCache.get(canonicalKey);

    if (!isCachedTrackMismatched(pCached)) {
      const verified = validateAndCleanLyricsLanguage(
        pCached.syncedLyrics,
        langProfile,
        pCached.sourceStage
      );
      if (verified) {
        if (meta.videoId && !pCached.videoId) {
          saveToPersistentStorage(canonicalKey, { ...pCached, syncedLyrics: verified }, meta);
        }
        return { ...pCached, syncedLyrics: verified, fromCache: true, fromPersistent: true };
      }
    }
    persistentLyricsCache.delete(canonicalKey);
    sessionLyricsCache.delete(canonicalKey);
  }

  if (sessionLyricsCache.has(canonicalKey)) {
    const cached = sessionLyricsCache.get(canonicalKey);
    const mismatched = isCachedTrackMismatched(cached);

    if (cached.status === 'synced' && !mismatched) {
      const verified = validateAndCleanLyricsLanguage(
        cached.syncedLyrics,
        langProfile,
        cached.sourceStage
      );
      if (verified) {
        const cleanCached = { ...cached, syncedLyrics: verified };
        if (isPersistentCacheEnabled && meta.persistToStorage) {
          saveToPersistentStorage(canonicalKey, cleanCached, meta);
        }
        return { ...cleanCached, fromCache: true };
      }
      sessionLyricsCache.delete(canonicalKey);
    } else if (mismatched) {
      sessionLyricsCache.delete(canonicalKey);
    } else if (meta.isPrefetch) {
      return { ...cached, fromCache: true };
    }
  }

  // 2. 동일 곡에 대해 이미 진행 중인 요청이 있다면 중복 호출하지 않고 공유
  if (inFlightRequests.has(canonicalKey)) {
    return inFlightRequests.get(canonicalKey);
  }

  const pipelinePromise = (async () => {
    const raceController = new AbortController();
    const { signal } = raceController;
    const plainCollector = [];

    try {
      // 5대 가사 서버를 동시에 출발!
      // 1군(Tier 1 - 원어 신뢰도 최상): YTM TimedLyrics, LRCLIB, 알송(Alsong)
      const tier1List = [
        requireSyncedResult(
          trySource1YtmTimedLyrics(
            meta.videoId,
            meta.lyricsBrowseId,
            signal,
            titleVariants,
            artistVariants
          ).then((result) => {
            if (result?.status === 'plain') plainCollector.push(result);
            return result;
          })
        ),
        requireSyncedResult(
          trySource6LrclibPipeline(
            titleVariants,
            artistVariants,
            meta.duration,
            langProfile,
            signal,
            plainCollector
          )
        ),
        requireSyncedResult(
          trySource2AlsongLyrics(titleVariants, artistVariants, langProfile, signal)
        )
      ];

      // 2군(Tier 2 - 글로벌/J-Pop/C-Pop 보완): NetEase, QQ Music
      const tier2List = [
        requireSyncedResult(
          trySource4NetEaseLyrics(titleVariants, artistVariants, meta.duration, langProfile, signal)
        ),
        requireSyncedResult(
          trySource5QQMusicLyrics(titleVariants, artistVariants, meta.duration, langProfile, signal)
        )
      ];

      let winner = null;

      if (langProfile.isChineseTrack) {
        // 실제 중국곡(C-Pop)인 경우 1군·2군 구분 없이 가장 먼저 도착하는 서버 채택
        winner = await Promise.any([...tier1List, ...tier2List]);
      } else {
        // 비중국곡(한국곡, 팝송, 일본곡 등)인 경우:
        // 1군 서버가 성공하면 0ms 지연으로 즉시 채택하고,
        // 만약 2군(NetEase/QQ)이 먼저 도착하더라도 1군 서버에 최대 450ms(또는 1군 전체 종료 시점)의 우선권을 부여하여
        // 중화권 서버가 YTM/LRCLIB/알송보다 먼저 가로채는 현상을 원천 방지!
        const tier1Race = Promise.any(tier1List);
        const tier1AllSettled = Promise.allSettled(tier1List);

        const delayedTier2Race = Promise.any(tier2List).then(async (tier2Winner) => {
          const graceWinner = await Promise.race([
            tier1Race.catch(() => null),
            tier1AllSettled.then(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), 450))
          ]);
          return graceWinner || tier2Winner;
        });

        winner = await Promise.any([tier1Race, delayedTier2Race]);
      }

      // 승자가 결정되면 나머지 느린 서버 요청들을 즉시 취소(Abort)!
      raceController.abort();

      setSessionCache(canonicalKey, winner);
      if (isPersistentCacheEnabled && meta.persistToStorage) {
        saveToPersistentStorage(canonicalKey, winner, meta);
      }
      return winner;
    } catch (aggregateErr) {
      // 5대 소스 모두에서 싱크 가사를 못 찾았을 때만 일반 가사(plain) 폴백 확인
      if (plainCollector.length > 0) {
        return plainCollector[0];
      }

      return {
        status: 'not_found',
        syncedLyrics: null,
        plainLyrics: null,
        trackName: titleVariants[0] || meta.rawTitle || '',
        artistName: artistVariants[0] || meta.rawArtist || '',
        sourceStage: 'none'
      };
    }
  })();

  inFlightRequests.set(canonicalKey, pipelinePromise);
  try {
    return await pipelinePromise;
  } finally {
    inFlightRequests.delete(canonicalKey);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'PARSE_YTM_LYRICS') {
    if (!sender.url?.startsWith('https://music.youtube.com/')) return false;
    const result = extractYtmLyrics(message.payload?.browseData);
    sendResponse({ ok: true, data: result ? { ...result, videoId: message.payload?.videoId || '' } : null });
    return false;
  }

  if (message.type === 'FETCH_LYRICS' || message.type === 'PREFETCH_LYRICS') {
    const meta = message.payload || {};
    if (message.type === 'PREFETCH_LYRICS') {
      meta.isPrefetch = true;
    }
    fetchLyricsPipeline(meta)
      .then((result) => {
        sendResponse({ ok: true, data: result });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || '가사 서버 통신 중 오류가 발생했습니다.'
        });
      });
    return true;
  }

  // 사용자가 현재 재생 중인 곡에 '좋아요' 또는 '저장목록 추가'를 눌렀을 때 즉시 영구 캐시에 저장
  if (message.type === 'PERSIST_LYRICS_TO_STORAGE') {
    const { meta } = message.payload || {};
    if (meta && isPersistentCacheEnabled) {
      const titleVariants = generateTitleVariants(meta.rawTitle, meta.cleanTitle, meta.enTitle);
      const artistVariants = generateArtistVariants(
        meta.rawArtist,
        meta.cleanArtist,
        meta.rawTitle,
        meta.enArtist
      );
      const canonicalKey = buildCanonicalTrackKey(meta, titleVariants, artistVariants);
      const existing = sessionLyricsCache.get(canonicalKey);
      if (existing && existing.status === 'synced') {
        saveToPersistentStorage(canonicalKey, existing, meta);
        sendResponse({ ok: true, persisted: true });
        return false;
      }
    }
    sendResponse({ ok: true, persisted: false });
    return false;
  }

  if (message.type === 'CLEAR_LYRICS_CACHE') {
    sessionLyricsCache.clear();
    persistentLyricsCache.clear();
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove([STORAGE_KEY]);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
