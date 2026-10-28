/**
 * content.js
 * 1) 기존 YouTube Music '가사(Lyrics)' 탭 내부 실시간 싱크 가사 완벽 통합 (기본 YTM UI 100% 보존)
 * 2) 앨범 아트에 마우스 오버 시 나타나는 기존 전체화면 버튼(<path d="M7 3H1v6...">) 클릭 시
 *    Apple Music 전체화면 플레이어로 즉시 전환 (ESC 또는 ✕/⧉ 클릭 시 복귀)
 * 3) 5대 멀티 소스 실시간 싱크 가사 파이프라인 (YTM TimedLyrics + 알송 + LRCLIB + Kugou + NetEase)
 * 4) YouTube Music Trusted Types CSP 보안 정책 100% 호환 (순수 DOM API)
 */

(() => {
  'use strict';

  if (window.__YTM_APPLE_LYRICS_INITIALIZED__) return;
  window.__YTM_APPLE_LYRICS_INITIALIZED__ = true;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * 전역 상태 관리 객체
   */
  const STATE = {
    currentTrackKey: '',            // 현재 트랙 고유 식별 키
    videoId: '',                    // 현재 YouTube videoId
    isAdPlaying: false,             // 광고 재생 여부
    isVideoPaused: false,           // 재생/일시정지 상태
    isAppleFullscreen: false,       // 별도 Apple Music 전체화면 모드 열림 여부 (기본값 false: 기존 YTM UI 유지)
    rightViewMode: 'lyrics',        // 전체화면 우측 뷰 모드: 'lyrics' (가사) | 'queue' (다음 트랙 목록)
    isSyncPopoverOpen: false,       // 전체화면 좌측 ••• 버튼의 싱크 조절 팝오버 열림 여부
    isScrubbing: false,             // 전체화면 시크바 드래그 중 여부
    meta: {
      videoId: '',
      rawTitle: '',
      cleanTitle: '',
      rawArtist: '',
      cleanArtist: '',
      album: '',
      coverUrl: '',
      duration: 0
    },
    lyricsStatus: 'idle',           // 'idle' | 'loading' | 'synced' | 'plain' | 'not_found' | 'ad' | 'instrumental'
    lyricsSourceLabel: '',          // 가사 출처 라벨
    lyricsLines: [],                // 파싱된 싱크 가사 배열: [{ time: Float, text: String, isInterlude: Boolean }]
    plainLyricsText: '',            // 일반 가사 텍스트
    prevTrackNativeLyrics: '',      // 이전 곡의 YTM 기본 가사 텍스트
    activeLineIndex: -1,            // 현재 활성 가사 줄 인덱스
    offsetSec: 0.0,                 // 사용자 지정 싱크 오프셋 (초)
    trackOffsets: {},               // 곡별 오프셋 저장소
    isUserScrolling: false,         // 수동 스크롤 중 여부
    userScrollTimer: null,          // 수동 스크롤 3.5초 해제 타이머
    programmaticScrollLock: false,  // 자동 스크롤 이벤트 잠금 플래그
    resumeCooldownUntil: 0,         // 복귀 클릭 직후 관성 스크롤 무시 시각
    rafId: null,                    // requestAnimationFrame ID
    lastSyncCheckTime: 0,           // 고주사율 타이머 스로틀 시각
    lastUiTickTime: 0,              // 프로그레스 바 갱신 타임스탬프
    videoElement: null,             // <video> 참조
    lastTrackVideoId: '',           // 직전 트랙의 videoId (자동재생 전환 시 이전 곡 videoId 오염 방지)
    lastTrackDuration: 0,           // 직전 트랙의 duration (자동재생 전환 직후 재생바 길이 오염 방지)
    trackTransitionTime: 0,         // 트랙 전환 발생 시각 (performance.now)
    lastWatchdogTime: 0,            // syncLoop 내 자동재생 트랙 전환 워치독 타임스탬프
    userSelectedLyricsTab: false,   // 사용자가 '가사' 탭을 열어둔 상태인지 여부 (자동재생 시 탭 풀림 방지)
    fetchedWithVideoId: '',         // 현재 트랙 가사 검색 시 사용된 videoId
    fetchedWithDuration: 0,         // 현재 트랙 가사 검색 시 사용된 duration
    requestSeq: 0,                  // 비동기 요청 시퀀스 번호
    retryTimer: null,               // 메타데이터 안정화 대기 타이머
    nativeLyricsPollTimer: null     // YTM 기본 가사 폴백 타이머
  };

  /**
   * UI DOM 참조 객체
   */
  const UI = {
    // 1. 일반 플레이어 페이지(ytmusic-player-page) 은은한 배경 및 통합 '가사' 탭 요소
    pageBackdrop: null,             // 플레이어 페이지 배경 은은한 앰비언트 글로우
    pageBlobs: [],                  // 플레이어 페이지 블롭
    tabIntegratedBox: null,         // 기존 #side-panel '가사' 탭 내부 컨테이너
    tabSourceBadgeEl: null,         // '가사' 탭 상단 소스 배지
    tabOffsetValueEl: null,         // '가사' 탭 상단 오프셋 표시
    tabResetBtnEl: null,            // '가사' 탭 상단 리셋 버튼
    tabLyricsViewport: null,        // '가사' 탭 내부 가사 스크롤 뷰포트
    tabLyricsContent: null,         // '가사' 탭 내부 가사 컨텐츠
    tabLineElements: [],            // '가사' 탭 내부 가사 라인 DOM 배열
    tabResumeScrollBtn: null,       // '가사' 탭 내부 '현재 위치로 복귀' 버튼
    boundTabsContainer: null,

    // 2. 별도 독립형 Apple Music 전체화면 플레이어 모달
    amOverlay: null,                // 독립형 Apple Music 전체화면 오버레이 (#ytm-apple-music-fullscreen)
    backdropBlobs: [],              // 전체화면 앰비언트 배경 블롭 3개
    artImg: null,                   // 전체화면 좌측 정사각형 앨범 커버
    songTitleEl: null,              // 전체화면 좌측 곡 제목
    songSubtitleEl: null,           // 전체화면 좌측 아티스트 — 앨범명
    favBtn: null,                   // 전체화면 좌측 ☆ 좋아요 버튼
    moreBtn: null,                  // 전체화면 좌측 ••• 싱크 조절/정보 버튼
    syncPopover: null,              // 전체화면 ••• 클릭 시 열리는 싱크 오프셋 조절 팝오버
    sourceBadgeEl: null,            // 전체화면 팝오버 내부 가사 소스 배지
    offsetValueEl: null,            // 전체화면 팝오버 내부 오프셋 값 텍스트
    resetBtnEl: null,               // 전체화면 팝오버 내부 리셋 버튼
    scrubberWrap: null,             // 전체화면 프로그레스 바 트랙
    scrubberFill: null,             // 전체화면 프로그레스 바 채움 영역
    timeCurrentEl: null,            // 전체화면 좌측 경과 시간 (0:20)
    timeRemainingEl: null,          // 전체화면 우측 남은 시간 (-4:16)
    playPauseBtn: null,             // 전체화면 중앙 재생/일시정지 버튼
    shuffleBtn: null,               // 전체화면 셔플 버튼
    repeatBtn: null,                // 전체화면 반복 버튼
    volumeSlider: null,             // 전체화면 우상단 볼륨 슬라이더
    volumeMuteBtn: null,            // 전체화면 우상단 볼륨 아이콘 버튼
    lyricsViewport: null,           // 전체화면 우측 가사 스크롤 뷰포트
    lyricsContent: null,            // 전체화면 우측 가사 컨텐츠 래퍼
    lineElements: [],               // 전체화면 가사 라인 DOM 배열
    queueViewport: null,            // 전체화면 우측 ☰ (다음 트랙) 재생목록 뷰포트
    queueListEl: null,              // 전체화면 우측 ☰ 재생목록 리스트
    resumeScrollBtn: null,          // 전체화면 '현재 위치로 복귀' 버튼
    modeLyricsBtn: null,            // 전체화면 우하단 💬 (가사) 버튼
    modeQueueBtn: null             // 전체화면 우하단 ☰ (재생목록) 버튼
  };

  /* ==========================================================================
   * 0. Trusted Types CSP 호환 순수 DOM / SVG 생성 헬퍼
   * ========================================================================== */

  function createEl(tag, options = {}, children = []) {
    const el = document.createElement(tag);
    if (options.id) el.id = options.id;
    if (options.className) el.className = options.className;
    if (typeof options.text === 'string') el.textContent = options.text;
    if (options.attrs) {
      for (const [k, v] of Object.entries(options.attrs)) {
        const attrName = String(k).trim();
        if (attrName) el.setAttribute(attrName, String(v));
      }
    }
    if (options.dataset) {
      for (const [k, v] of Object.entries(options.dataset)) {
        el.dataset[k] = String(v);
      }
    }
    for (const child of children) {
      if (child) el.appendChild(child);
    }
    return el;
  }

  function createSvgIcon(size, shapes, viewBox = '0 0 24 24', fill = 'none', strokeWidth = '2') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', fill);
    svg.setAttribute('stroke', fill === 'currentColor' ? 'none' : 'currentColor');
    svg.setAttribute('stroke-width', strokeWidth);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    for (const shape of shapes) {
      const node = document.createElementNS(SVG_NS, shape.tag);
      for (const [k, v] of Object.entries(shape.attrs || {})) {
        const attrName = String(k).trim();
        if (attrName) node.setAttribute(attrName, String(v));
      }
      svg.appendChild(node);
    }
    return svg;
  }

  /* ==========================================================================
   * 1. 메타데이터 정제, 추출 및 YouTube Music 자체 모바일 TimedLyrics 호출
   * ========================================================================== */

  function sanitizeTrackTitle(rawTitle = '') {
    if (!rawTitle || typeof rawTitle !== 'string') return '';

    let cleaned = rawTitle;

    // 1. 괄호 (), [], {}, 【】, 『』 내부의 부가 정보 제거
    const bracketNoisePattern = /[\(\[\{【『（][^)\]}】』）]*?(?:(?:\b(?:official\s*(?:music\s*)?video|official\s*audio|official\s*lyric\s*video|lyric\s*video|lyrics?|m\/?v|music\s*video|visualizer|audio|live(?:\s*clip|\s*ver\.?|\s*performance)?|performance(?:\s*video)?|clip\s*officiel|video\s*oficial|en\s*vivo|remaster(?:ed)?(?:\s*\d{4})?|feat(?:uring)?|ft|with|prod(?:uced)?(?:\s*by)?|narr(?:ation)?|intro|outro|inst(?:rumental)?|explicit|clean|acoustic|radio\s*edit|ver(?:sion)?|korean\s*ver|japanese\s*ver|english\s*ver|edit|ost|original\s*soundtrack|part\.?\s*\d+|pt\.?\s*\d+|hd|4k|hq)\b)|(?:스페셜\s*클립|뮤직\s*비디오|가사|공식\s*비디오|라이브|리마스터|녹음실|내레이션|나레이션|반주|음원|노래방|19금))[^)\]}】』）]*?[\)\]\}】』）]/gi;
    cleaned = cleaned.replace(bracketNoisePattern, ' ');

    // 2. 하이픈(-, –, —)이나 슬래시(|, /) 뒤 부가 정보 제거
    const dashNoisePattern = /\s+[-–—|/]\s*.*?(?:(?:\b(?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|m\/?v|music\s*video|visualizer|remaster(?:ed)?(?:\s*\d{4})?|live|inst(?:rumental)?|ver(?:sion)?|ost|part\.?\s*\d+|pt\.?\s*\d+)\b)|(?:뮤직\s*비디오|스페셜\s*클립|가사|리마스터|반주)).*$/gi;
    cleaned = cleaned.replace(dashNoisePattern, ' ');

    // 3. 문장 끝에 붙은 Feat. / ft. / Prod. / Narr. 제거
    const trailingFeatProdPattern = /\s+(?:feat(?:uring)?|ft|prod(?:uced)?(?:\s*by)?|narr(?:ation)?)(?:\.|\b)\s*.*$/gi;
    cleaned = cleaned.replace(trailingFeatProdPattern, ' ');

    // 4. 단독 리마스터 연도 제거
    cleaned = cleaned.replace(/\bremaster(?:ed)?(?:\s+\d{4})?\b/gi, ' ');

    cleaned = cleaned
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, '')
      .trim();

    return cleaned.length > 0 ? cleaned : rawTitle.trim();
  }

  function sanitizeArtistName(rawArtist = '') {
    if (!rawArtist || typeof rawArtist !== 'string') return '';

    let cleaned = rawArtist
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .trim();

    if (cleaned.includes('•')) {
      cleaned = cleaned.split('•')[0].trim();
    }

    // "에픽하이 (EPIK HIGH) 및 다비치" -> 대표 아티스트 "에픽하이 (EPIK HIGH)" 추출
    cleaned = cleaned.split(/\s*(?:,|&|\/|\s+및\s+|\band\b|\bwith\b)\s*/i)[0].trim();

    return cleaned || rawArtist.trim();
  }

  /**
   * 현재 활성화된 <video> 엘리먼트를 항상 최신 상태로 반환 및 이벤트 바인딩 보장
   */
  function getActiveVideoElement() {
    const current = STATE.videoElement;
    if (current && current.isConnected && !current.ended) {
      return current;
    }

    const activeVid =
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video');

    if (activeVid && STATE.videoElement !== activeVid) {
      bindVideoElement(activeVid);
    }
    return activeVid || current || null;
  }

  /**
   * 하단 재생바(ytmusic-player-bar)의 .time-info 및 #progress-bar 슬라이더에서
   * 실제 표시 중인 경과 시간(cur)과 전체 길이(dur)를 추출
   */
  function readPlayerBarTimeState() {
    let barCur = -1;
    let barDur = 0;

    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return { barCur, barDur };

    const timeInfoEl = playerBar.querySelector('.time-info.ytmusic-player-bar');
    if (timeInfoEl && timeInfoEl.textContent) {
      const parts = timeInfoEl.textContent.split('/');
      if (parts.length === 2) {
        const parsedCur = parseTimeLabelToSeconds(parts[0].trim());
        const parsedDur = parseTimeLabelToSeconds(parts[1].trim());
        if (parsedCur >= 0) barCur = parsedCur;
        if (parsedDur > 0) barDur = parsedDur;
      }
    }

    const slider = playerBar.querySelector('tp-yt-paper-slider#progress-bar, #progress-bar');
    if (slider) {
      const valAttr = Number(slider.getAttribute('value') ?? slider.value);
      const maxAttr = Number(
        slider.getAttribute('aria-valuemax') ?? slider.getAttribute('max') ?? slider.max
      );
      if (barDur <= 0 && Number.isFinite(maxAttr) && maxAttr > 1) {
        barDur = maxAttr;
      }
      if (barCur < 0 && Number.isFinite(valAttr) && valAttr >= 0) {
        barCur = valAttr;
      }
    }

    return { barCur, barDur };
  }

  /**
   * 자동재생(Autoplay) 전환 직후 <video>의 currentTime이나 duration이
   * 이전 곡의 끝부분(예: 240s/240s)에 잠시 머물러 있거나 NaN이 되는 현상을 보정하여
   * 정확한 { cur, dur } 재생 상태를 반환
   */
  function getEffectivePlaybackState(video) {
    const vid = video || getActiveVideoElement();
    const { barCur, barDur } = readPlayerBarTimeState();
    const inTransitionWindow =
      STATE.trackTransitionTime > 0 && performance.now() - STATE.trackTransitionTime < 2200;

    const videoDur =
      vid && Number.isFinite(vid.duration) && vid.duration > 1 ? vid.duration : 0;

    let dur = 0;
    if (
      inTransitionWindow &&
      STATE.lastTrackDuration > 0 &&
      Math.abs(videoDur - STATE.lastTrackDuration) < 0.6 &&
      barDur > 0 &&
      Math.abs(barDur - videoDur) > 1.5
    ) {
      // 자동재생 직후 <video>.duration이 아직 이전 곡 길이에 머물러 있는 경우 하단 바의 새 곡 길이 사용
      dur = barDur;
    } else if (videoDur > 0) {
      dur = videoDur;
    } else if (barDur > 0) {
      dur = barDur;
    } else {
      dur = STATE.meta.duration || 0;
    }

    let cur =
      vid && Number.isFinite(vid.currentTime) && vid.currentTime >= 0 ? vid.currentTime : 0;

    if (inTransitionWindow) {
      const isStuckAtPrevEnd =
        cur > 4 &&
        ((barCur >= 0 && barCur <= 3) ||
          (STATE.lastTrackDuration > 0 && Math.abs(cur - STATE.lastTrackDuration) < 3.5) ||
          (dur > 0 && cur >= dur - 1.5));

      if (isStuckAtPrevEnd) {
        cur = barCur >= 0 && barCur <= 3 ? barCur : 0;
      }
    } else if (cur === 0 && barCur > 0 && (!vid || vid.readyState < 2)) {
      cur = barCur;
    }

    return { cur, dur };
  }

  /**
   * 현재 재생 중인 곡의 YouTube videoId 추출
   * - 자동재생(Autoplay) 시 URL(?v=...)이나 플레이어 큐 첫 번째 항목 링크가 이전 곡의 videoId를
   *   그대로 유지하여 이전 곡 가사를 불러오는 버그를 원천 차단!
   */
  function extractCurrentVideoId(rawTitle = '') {
    const normTargetTitle = rawTitle
      ? sanitizeTrackTitle(rawTitle).toLowerCase().replace(/\s+/g, '')
      : '';

    // 1. 하단 플레이어 바(ytmusic-player-bar) 내부에 현재 곡 전용 watch?v= 링크가 있는 경우 최우선
    const barLink = document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
    if (barLink) {
      const href = barLink.getAttribute('href') || '';
      const match = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (match && match[1] && match[1] !== STATE.lastTrackVideoId) {
        return match[1];
      }
    }

    // 2. 현재 재생목록 큐(ytmusic-player-queue-item)에서 실제 재생 중(selected / playing)인 아이템 확인
    const activeQueueItems = document.querySelectorAll(
      'ytmusic-player-queue-item[play-button-state="playing"], ytmusic-player-queue-item[selected]'
    );
    for (const item of activeQueueItems) {
      const itemTitleEl = item.querySelector('.song-title');
      const itemTitle = itemTitleEl ? itemTitleEl.textContent.trim() : '';
      const normItemTitle = itemTitle
        ? sanitizeTrackTitle(itemTitle).toLowerCase().replace(/\s+/g, '')
        : '';

      if (normTargetTitle && normItemTitle && normTargetTitle !== normItemTitle) {
        continue;
      }

      const itemLink = item.querySelector('a[href*="watch?v="]');
      if (itemLink) {
        const href = itemLink.getAttribute('href') || '';
        const match = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (match && match[1] && match[1] !== STATE.lastTrackVideoId) {
          return match[1];
        }
      }
    }

    // 3. HTML5 플레이어(#movie_player) 내부의 현재 재생 영상 링크에서 추출
    //    단, 자동재생 전환 직후에는 이전 곡의 videoId가 남아 있을 수 있으므로 검증 후 채택!
    const ytpTitleLink = document.querySelector('#movie_player a.ytp-title-link[href*="watch?v="]');
    if (ytpTitleLink) {
      const href = ytpTitleLink.getAttribute('href') || '';
      const match = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      if (match && match[1]) {
        const candidateVid = match[1];
        const linkTitle = (ytpTitleLink.textContent || '').trim();
        const normLinkTitle = linkTitle
          ? sanitizeTrackTitle(linkTitle).toLowerCase().replace(/\s+/g, '')
          : '';

        const titleMatches =
          normTargetTitle &&
          normLinkTitle &&
          (normLinkTitle.includes(normTargetTitle) || normTargetTitle.includes(normLinkTitle));

        if (candidateVid !== STATE.lastTrackVideoId || titleMatches) {
          return candidateVid;
        }
      }
    }

    // 4. URL 쿼리 파라미터(?v=...)에서 추출 (단, 이전 트랙의 videoId와 다를 때만 채택)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const fromUrl = urlParams.get('v');
      if (fromUrl && fromUrl !== STATE.lastTrackVideoId) {
        return fromUrl;
      }
    } catch (e) {}

    return '';
  }

  function detectAdPlaying() {
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return false;

    const moviePlayer = document.querySelector('#movie_player');
    if (
      moviePlayer &&
      (moviePlayer.classList.contains('ad-showing') ||
        moviePlayer.classList.contains('ad-interrupting'))
    ) {
      return true;
    }

    const bylineEl = playerBar.querySelector(
      '.byline.ytmusic-player-bar, .subtitle.ytmusic-player-bar'
    );
    const bylineText = bylineEl ? bylineEl.textContent.trim() : '';
    if (/^(Ad|광고|Sponsored)\b/i.test(bylineText)) {
      return true;
    }

    return false;
  }

  function extractTrackMetadata() {
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return null;

    const video = getActiveVideoElement();

    if (detectAdPlaying()) {
      return { isAd: true };
    }

    const titleEl =
      playerBar.querySelector('yt-formatted-string.title.ytmusic-player-bar') ||
      playerBar.querySelector('.title.ytmusic-player-bar');
    let rawTitle = titleEl ? titleEl.textContent.trim() : '';

    const ms =
      navigator.mediaSession && navigator.mediaSession.metadata
        ? navigator.mediaSession.metadata
        : null;
    if (!rawTitle && ms && ms.title) {
      rawTitle = ms.title.trim();
    }

    if (!rawTitle) return null;

    const bylineEl =
      playerBar.querySelector('yt-formatted-string.byline.ytmusic-player-bar') ||
      playerBar.querySelector('.subtitle .byline.ytmusic-player-bar') ||
      playerBar.querySelector('.byline.ytmusic-player-bar');

    let rawArtist = '';
    let album = '';

    if (bylineEl) {
      const fullBylineText = bylineEl.textContent || '';
      const bulletParts = fullBylineText
        .split('•')
        .map((s) => s.trim())
        .filter(Boolean);

      if (bulletParts.length > 0) {
        rawArtist = bulletParts[0];
      }
      if (
        bulletParts.length > 1 &&
        !/^\d+년?$/.test(bulletParts[1]) &&
        !/조회수|views|likes|만회|천회/i.test(bulletParts[1])
      ) {
        album = bulletParts[1];
      }
    }

    if (ms) {
      if (!rawArtist && ms.artist) rawArtist = ms.artist;
      if (!album && ms.album) album = ms.album;
    }

    const mainPlayerImg = document.querySelector('ytmusic-player #song-image img#img');
    const barImg =
      playerBar.querySelector('img.image.ytmusic-player-bar') ||
      playerBar.querySelector('.thumbnail-image-wrapper img');

    let coverUrl = '';
    if (
      mainPlayerImg &&
      mainPlayerImg.getAttribute('src') &&
      !mainPlayerImg.getAttribute('src').startsWith('data:')
    ) {
      coverUrl = mainPlayerImg.getAttribute('src');
    } else if (barImg && barImg.getAttribute('src')) {
      coverUrl = barImg.getAttribute('src');
    } else if (ms && Array.isArray(ms.artwork) && ms.artwork.length > 0) {
      coverUrl = ms.artwork[ms.artwork.length - 1].src || '';
    }

    if (coverUrl && coverUrl.startsWith('http')) {
      coverUrl = coverUrl.replace(/=w\d+-h\d+[^&?]*/i, '=w1000-h1000-l95-rj');
    }

    const { dur: duration } = getEffectivePlaybackState(video);

    const cleanTitle = sanitizeTrackTitle(rawTitle);
    const cleanArtist = sanitizeArtistName(rawArtist);
    const videoId = extractCurrentVideoId(rawTitle);

    return {
      isAd: false,
      videoId,
      rawTitle,
      cleanTitle,
      rawArtist,
      cleanArtist,
      album,
      coverUrl,
      duration
    };
  }

  function parseTimeLabelToSeconds(label) {
    if (!label) return 0;
    const nums = label.split(':').map((n) => parseInt(n.trim(), 10));
    if (nums.some((n) => Number.isNaN(n))) return 0;
    if (nums.length === 2) return nums[0] * 60 + nums[1];
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
    return 0;
  }

  function formatSecondsToLabel(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const total = Math.floor(sec);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  /**
   * 로그인 상태에서 YouTube InnerTube API 호출 시 필요한 SAPISIDHASH 인증 헤더 생성
   */
  async function buildYouTubeSapisidHeaders() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
      if (!match) return { 'Content-Type': 'application/json' };
      const sapisid = decodeURIComponent(match[1]);
      const origin = 'https://music.youtube.com';
      const timestamp = Math.floor(Date.now() / 1000);
      const input = `${timestamp} ${sapisid} ${origin}`;
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
      const hash = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return {
        'Content-Type': 'application/json',
        'Authorization': `SAPISIDHASH ${timestamp}_${hash}`,
        'X-Origin': origin,
        'X-Goog-AuthUser': '0'
      };
    } catch (e) {
      return { 'Content-Type': 'application/json' };
    }
  }

  /**
   * 동일 출처(https://music.youtube.com)에서:
   * 1) 현재 곡의 가사 탭 browseId (MPLYt_...) 추출
   * 2) 영어 로케일(hl: 'en', gl: 'US')로 공식 영문 곡 제목(enTitle) 및 영문 아티스트명(enArtist) 추출
   * 3) 만약 WEB_REMIX 자체에 timedLyricsData가 포함되어 있으면 즉시 반환
   */
  async function fetchYtmWebRemixMetadata(videoId, meta) {
    const result = {
      lyricsBrowseId: '',
      enTitle: '',
      enArtist: '',
      timedLyricsResult: null
    };

    const findKey = (obj, key) => {
      if (!obj || typeof obj !== 'object') return null;
      if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key]) return obj[key];
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
          const r = findKey(v, key);
          if (r) return r;
        }
      }
      return null;
    };

    const webKoContext = {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20250101.01.00',
        hl: 'ko',
        gl: 'KR'
      }
    };

    const webEnContext = {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20250101.01.00',
        hl: 'en',
        gl: 'US'
      }
    };

    try {
      let targetVid = videoId;

      // 만약 홈 화면 등에서 재생하여 videoId가 아직 없다면 동일 출처 검색으로 공식 음원 videoId 확보
      if (!targetVid) {
        const qTitle = (meta?.cleanTitle || meta?.rawTitle || '').trim();
        const qArtist = (meta?.cleanArtist || meta?.rawArtist || '').trim();
        if (qTitle) {
          const searchRes = await fetch('/youtubei/v1/search?prettyPrint=false', {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context: webKoContext,
              query: `${qTitle} ${qArtist}`.trim(),
              params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D'
            })
          });
          if (searchRes.ok) {
            const searchText = await searchRes.text();
            const m = searchText.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
            if (m) targetVid = m[1];
          }
        }
      }

      if (!targetVid) return result;
      result.resolvedVideoId = targetVid;

      // 병렬로 (1) 가사 browseId(MPLYt_...) 조회 및 (2) 영문 제목/아티스트(hl: 'en') 조회 실행
      const authHeaders = await buildYouTubeSapisidHeaders();

      const nextPromise = fetch('/youtubei/v1/next?prettyPrint=false', {
        method: 'POST',
        credentials: 'same-origin',
        headers: authHeaders,
        body: JSON.stringify({
          context: webKoContext,
          videoId: targetVid
        })
      }).catch(() => null);

      const enNextPromise = fetch('/youtubei/v1/next?prettyPrint=false', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: webEnContext,
          videoId: targetVid
        })
      }).catch(() => null);

      const [nextRes, enNextRes] = await Promise.all([nextPromise, enNextPromise]);

      if (nextRes && nextRes.ok) {
        const nextText = await nextRes.text();
        const browseMatch = nextText.match(/"browseId"\s*:\s*"(MPLYt_[^"]+)"/);
        if (browseMatch) {
          result.lyricsBrowseId = browseMatch[1];
        }
      }

      if (enNextRes && enNextRes.ok) {
        const enText = await enNextRes.text();
        if (!result.lyricsBrowseId) {
          const browseMatch = enText.match(/"browseId"\s*:\s*"(MPLYt_[^"]+)"/);
          if (browseMatch) {
            result.lyricsBrowseId = browseMatch[1];
          }
        }
        try {
          const enData = JSON.parse(enText);
          const panelVideo = findKey(enData, 'playlistPanelVideoRenderer');
          if (panelVideo) {
            const tRuns = panelVideo?.title?.runs;
            if (Array.isArray(tRuns) && tRuns[0]?.text) {
              result.enTitle = sanitizeTrackTitle(tRuns[0].text);
            }
            const bRuns = panelVideo?.longBylineText?.runs || panelVideo?.shortBylineText?.runs;
            if (Array.isArray(bRuns) && bRuns[0]?.text) {
              result.enArtist = sanitizeArtistName(bRuns[0].text);
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    return result;
  }

  /**
   * YouTube Music 기본 가사 탭 DOM에서 일반 가사 텍스트 추출 (모든 실시간 가사 소스에 없을 때만 최후 폴백)
   */
  function extractNativeYtmLyrics() {
    const sidePanel = document.querySelector('ytmusic-player-page #side-panel');
    if (!sidePanel) return null;

    const descEl = sidePanel.querySelector(
      'ytmusic-description-shelf-renderer .description.ytmusic-description-shelf-renderer'
    );
    if (!descEl) return null;

    const text = (descEl.innerText || descEl.textContent || '').trim();
    if (!text || text.length < 10) return null;

    if (STATE.prevTrackNativeLyrics && text === STATE.prevTrackNativeLyrics) {
      return null;
    }

    return text;
  }

  /* ==========================================================================
   * 2. LRC 정밀 파서 및 이진 탐색(Binary Search) 초고주사율 동기화 엔진
   * ========================================================================== */

  function isMetadataCreditLine(text = '') {
    if (!text) return false;
    const t = text.trim();

    // 1. 한/중/일/영 작사·작곡·편곡·보컬·세션·제작 크레딧 접두어 패턴 (예: "词：...", "曲：...", "编曲：...", "작사: ...")
    const creditPrefixRegex =
      /^(?:작사|작곡|편곡|노래|가수|보컬|코러스|프로듀서|프로듀싱|믹싱|마스터링|연주|기타|베이스|드럼|피아노|스트링|녹음|기획|제작|배급|원곡|번안|개사|수록곡|앨범|타이틀|가사\s*등록|등록자|수정|싱크|출처|제공|词|作词|作詞|曲|作曲|编曲|編曲|演唱|歌手|歌|原唱|翻唱|プロデューサー|制作人|製作人|制作|製作|混音|缩混|母带|母帶|和声|和聲|和音|吉他|木吉他|电吉他|贝斯|貝斯|鼓|键盘|鍵盤|钢琴|鋼琴|弦乐|弦樂|录音|錄音|录音室|錄音室|配唱|监制|監製|统筹|統籌|出品|发行|發行|企划|企劃|宣传|宣傳|鸣谢|文案|海报|封面|OP|SP|歌词编辑|LRC(?:编辑|制作)?|by|Lyricist|Lyrics?\s*by|Composer|Composed\s*by|Arranger|Arranged\s*by|Producer|Produced\s*by|Vocal(?:s)?|Mixed\s*by|Mastered\s*by|Guitar|Bass|Drum(?:s)?|Written\s*by|Performed\s*by)\s*[:：｜|]/i;

    if (creditPrefixRegex.test(t)) return true;

    // 2. 대괄호나 괄호로 감싸진 LRC 제작자/출처 안내문 제거
    if (/^(?:lrc\s*by|lyrics?\s*by|synced\s*by|www\.|http|qq\s*[:：]|텐센트|쿠거우|알송)/i.test(t)) {
      return true;
    }

    return false;
  }

  function isIntroTitleArtistHeader(text = '', time = 0) {
    if (!text || time > 6.0) return false;
    const t = text.trim();
    if (!/\s*[-–—~:/]\s*/.test(t)) return false;

    const normLine = t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const normTitle = (STATE.meta.cleanTitle || STATE.meta.rawTitle || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
    const normArtist = (STATE.meta.cleanArtist || STATE.meta.rawArtist || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');

    if (normTitle && normLine.includes(normTitle)) return true;
    if (normArtist && normLine.includes(normArtist) && time <= 2.0) return true;

    return false;
  }

  function parseLRC(lrcText) {
    if (!lrcText || typeof lrcText !== 'string') return [];

    const rawLines = lrcText.split(/\r?\n/);
    const rawEntries = [];
    const timeTagRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

    let embeddedOffsetSec = 0;
    const offsetTagMatch = lrcText.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetTagMatch) {
      embeddedOffsetSec = parseInt(offsetTagMatch[1], 10) / 1000;
    }

    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const matches = [...trimmed.matchAll(timeTagRegex)];
      if (matches.length === 0) continue;

      const lyricText = trimmed.replace(timeTagRegex, '').trim();

      for (const match of matches) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        let fraction = 0;
        if (match[3]) {
          fraction = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) / 1000;
        }

        const totalTime = Math.max(0, minutes * 60 + seconds + fraction - embeddedOffsetSec);
        rawEntries.push({
          time: Number(totalTime.toFixed(3)),
          text: lyricText
        });
      }
    }

    rawEntries.sort((a, b) => a.time - b.time);

    // Kugou / NetEase / 알송 도입부 크레딧 블록 감지:
    // 도입부(처음 12줄 이내, 25초 이하)에 "词：...", "曲：...", "编曲：..." 같은 크레딧 줄이 존재하면,
    // 그 첫 크레딧 줄 바로 앞에 위치한 0~5초 사이의 곡 제목/아티스트 헤더 줄("Butter-Fly - 전영호" 등)도 함께 제거!
    let firstIntroCreditIdx = -1;
    for (let i = 0; i < Math.min(rawEntries.length, 12); i++) {
      if (rawEntries[i].time <= 25.0 && isMetadataCreditLine(rawEntries[i].text)) {
        firstIntroCreditIdx = i;
        break;
      }
    }

    const parsedEntries = rawEntries.filter((entry, idx) => {
      if (isMetadataCreditLine(entry.text)) return false;
      if (firstIntroCreditIdx > 0 && idx < firstIntroCreditIdx && entry.time <= 5.0) {
        return false;
      }
      if (idx === 0 && isIntroTitleArtistHeader(entry.text, entry.time)) {
        return false;
      }
      return true;
    });

    const finalLines = [];

    if (parsedEntries.length > 0 && parsedEntries[0].time >= 5.0 && parsedEntries[0].text !== '') {
      finalLines.push({
        time: 0.0,
        text: '•••',
        isInterlude: true
      });
    }

    for (let i = 0; i < parsedEntries.length; i++) {
      const current = parsedEntries[i];
      const next = parsedEntries[i + 1];

      if (
        current.text === '' ||
        current.text === '•••' ||
        current.text === '...' ||
        current.text === '//'
      ) {
        const gapToNext = next ? next.time - current.time : 0;
        if (gapToNext >= 5.0) {
          if (finalLines.length === 0 || !finalLines[finalLines.length - 1].isInterlude) {
            finalLines.push({
              time: current.time,
              text: '•••',
              isInterlude: true
            });
          }
        }
        continue;
      }

      finalLines.push({
        time: current.time,
        text: current.text,
        isInterlude: false
      });

      if (next && next.text !== '') {
        const gap = next.time - current.time;
        if (gap >= 12.0) {
          const interludeStart = Number((current.time + 5.5).toFixed(3));
          if (next.time - interludeStart >= 5.0) {
            finalLines.push({
              time: interludeStart,
              text: '•••',
              isInterlude: true
            });
          }
        }
      }
    }

    return finalLines;
  }

  function findActiveLineIndexBinarySearch(lines, targetTime) {
    const n = lines.length;
    if (n === 0 || targetTime < lines[0].time) {
      return -1;
    }

    let low = 0;
    let high = n - 1;
    let resultIndex = -1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (lines[mid].time <= targetTime) {
        resultIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return resultIndex;
  }

  /**
   * 초고주사율 동기화 루프 (50ms 주기 가사 이진 탐색 + 150ms 주기 프로그레스 바 갱신 + 400ms 자동재생 워치독)
   */
  function syncLoop(timestamp) {
    STATE.rafId = requestAnimationFrame(syncLoop);

    const video = getActiveVideoElement();

    // 0. 자동재생(Autoplay) 전환 워치독 (400ms 주기):
    //    MutationObserver가 연속적인 플레이어 바 이벤트나 백그라운드 전환으로 지연되더라도
    //    곡 변경 및 지연 로드된 videoId/duration을 100% 즉시 감지!
    if (timestamp - STATE.lastWatchdogTime >= 400) {
      STATE.lastWatchdogTime = timestamp;
      const playerBar = document.querySelector('ytmusic-player-bar');
      if (playerBar) {
        const titleEl =
          playerBar.querySelector('yt-formatted-string.title.ytmusic-player-bar') ||
          playerBar.querySelector('.title.ytmusic-player-bar');
        const curRawTitle = titleEl ? titleEl.textContent.trim() : '';
        if (
          (curRawTitle && curRawTitle !== STATE.meta.rawTitle) ||
          (!STATE.meta.videoId && curRawTitle)
        ) {
          handleDOMMutation();
        }
      }
    }

    if (!video) return;

    // 1. 좌측 프로그레스 시크바 및 경과/남은 시간 업데이트 (150ms 주기)
    if (!STATE.isScrubbing && timestamp - STATE.lastUiTickTime >= 150) {
      STATE.lastUiTickTime = timestamp;
      updateProgressBarUI(video);
    }

    // 2. 실시간 싱크 가사 이진 탐색 (50ms 주기)
    if (STATE.lyricsStatus !== 'synced' || STATE.lyricsLines.length === 0) {
      return;
    }

    if (timestamp - STATE.lastSyncCheckTime < 50) {
      return;
    }
    STATE.lastSyncCheckTime = timestamp;

    const { cur } = getEffectivePlaybackState(video);
    const effectiveTime = cur + STATE.offsetSec + 0.06;
    const newIndex = findActiveLineIndexBinarySearch(STATE.lyricsLines, effectiveTime);

    if (newIndex !== STATE.activeLineIndex) {
      updateActiveLyricLine(newIndex);
    }
  }

  /**
   * Apple Music 전체화면 좌측 프로그레스 바 및 시간(0:20 / -4:16) 갱신
   */
  function updateProgressBarUI(video) {
    if (!UI.scrubberFill || !UI.timeCurrentEl || !UI.timeRemainingEl) return;

    const { cur, dur } = getEffectivePlaybackState(video);
    if (dur > 0 && (!STATE.meta.duration || Math.abs(STATE.meta.duration - dur) > 2)) {
      STATE.meta.duration = dur;
    }

    const ratio = dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0;
    UI.scrubberFill.style.width = `${(ratio * 100).toFixed(2)}%`;

    UI.timeCurrentEl.textContent = formatSecondsToLabel(cur);
    const remain = Math.max(0, dur - cur);
    UI.timeRemainingEl.textContent = `-${formatSecondsToLabel(remain)}`;
  }

  /**
   * 활성화된 가사 줄의 거리별 블러/투명도 클래스 갱신 및 중앙 스크롤
   */
  function updateActiveLyricLine(newIndex) {
    STATE.activeLineIndex = newIndex;

    const applyToElements = (elements) => {
      if (!elements || elements.length === 0) return;
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const dist = newIndex >= 0 ? Math.abs(i - newIndex) : 99;
        el.classList.toggle('is-active', i === newIndex);
        el.classList.toggle('is-passed', newIndex > i);
        el.classList.toggle('is-near-1', dist === 1);
        el.classList.toggle('is-near-2', dist === 2);
        el.classList.toggle('is-near-3', dist === 3);
      }
    };

    applyToElements(UI.lineElements);
    applyToElements(UI.tabLineElements);

    if (!STATE.isUserScrolling && newIndex >= 0) {
      scrollToActiveLine(false);
    }
  }

  /**
   * 활성 가사 줄을 뷰포트의 시선 중심점(38% 지점)으로 스크롤
   */
  function scrollToActiveLine(instant = false) {
    const scrollTargetViewport = (viewport, elements) => {
      if (!viewport || !elements || !elements[STATE.activeLineIndex]) return;
      const vh = viewport.clientHeight;
      if (vh === 0) return;
      const activeEl = elements[STATE.activeLineIndex];
      const targetTop = Math.max(
        0,
        activeEl.offsetTop - vh * 0.38 + activeEl.offsetHeight * 0.5
      );
      viewport.scrollTo({
        top: targetTop,
        behavior: instant ? 'instant' : 'smooth'
      });
    };

    STATE.programmaticScrollLock = true;
    scrollTargetViewport(UI.lyricsViewport, UI.lineElements);
    scrollTargetViewport(UI.tabLyricsViewport, UI.tabLineElements);

    setTimeout(() => {
      STATE.programmaticScrollLock = false;
    }, 450);
  }

  /* ==========================================================================
   * 3. UI 주입 및 앨범 아트 위 기존 전체화면 버튼(<path d="M7 3H1v6...">) 연동
   * ========================================================================== */

  function ensureUIInjected() {
    // 1. 불필요한 구버전 버튼들 완전 제거 (하단 재생바 버튼 & 앨범 밑 Apple Music 전체화면 버튼 제거)
    document
      .querySelectorAll('.ytm-apple-lyrics-toggle-btn, .ytm-am-enter-fullscreen-btn')
      .forEach((btn) => btn.remove());
    const oldFloating = document.getElementById('ytm-apple-lyrics-panel');
    if (oldFloating) oldFloating.remove();

    // 2. 별도 독립형 Apple Music 전체화면 모달을 document.body에 주입 (평소엔 display: none)
    if (!UI.amOverlay || !document.body.contains(UI.amOverlay)) {
      const staleOverlay = document.getElementById('ytm-apple-music-fullscreen');
      if (staleOverlay) staleOverlay.remove();
      createStandaloneAppleFullscreenModal();
    }

    // 3. 기존 YouTube Music 플레이어 페이지(ytmusic-player-page) 내부:
    //    - 은은한 배경 글로우
    //    - 앨범에 마우스 올렸을 때 나오는 기존 전체화면 버튼(<path d="M7 3H1v6...">)에 Apple Music 전체화면 연동!
    //    - 우측 #side-panel의 기존 '가사' 탭 내부에 실시간 싱크 가사 통합
    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage) {
      ensureNormalPlayerPageEnhancements(playerPage);
      bindNativeAlbumFullscreenButton(playerPage);

      const sidePanel = playerPage.querySelector('#side-panel');
      if (sidePanel) {
        if (!UI.tabIntegratedBox || !sidePanel.contains(UI.tabIntegratedBox)) {
          createSidePanelIntegratedDOM(sidePanel);
        }
        unlockAndSyncNativeLyricsTab(sidePanel);
      }
    }
  }

  /**
   * 앨범 아트에 마우스를 올렸을 때 나타나는 YouTube Music 기본 전체화면 버튼(<path d="M7 3H1v6...">)을 찾아
   * 클릭 시 우리가 만든 Apple Music 전체화면 플레이어가 열리도록 바인딩
   */
  function isNativeFullscreenButtonNode(node) {
    if (!node || !(node instanceof Element)) return null;
    if (UI.amOverlay && UI.amOverlay.contains(node)) return null;

    const btn = node.closest(
      'tp-yt-paper-icon-button, yt-icon-button, button, .fullscreen-button, [role="button"]'
    );
    if (!btn) return null;
    if (UI.amOverlay && UI.amOverlay.contains(btn)) return null;

    // 1. 사용자가 제공한 정확한 SVG path(d="M7 3H1v6...") 포함 여부 확인
    const exactPath = btn.querySelector('path[d^="M7 3H1v6"]');
    if (exactPath) return btn;

    // 2. 클래스명 또는 aria-label / title 확인
    if (btn.classList.contains('fullscreen-button')) return btn;
    const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`;
    if (/전체\s*화면|full\s*screen/i.test(label) && btn.closest('ytmusic-player, ytmusic-player-page, ytmusic-player-bar')) {
      return btn;
    }

    return null;
  }

  function bindNativeAlbumFullscreenButton(rootEl = document) {
    // <path d="M7 3H1v6..."> 아이콘을 가진 기존 전체화면 버튼 탐색
    const paths = rootEl.querySelectorAll('path[d^="M7 3H1v6"], .fullscreen-button');
    paths.forEach((el) => {
      const btn =
        el.closest('tp-yt-paper-icon-button, yt-icon-button, button, .fullscreen-button, [role="button"]') ||
        el.parentElement;
      if (!btn || btn.dataset.ytmAmFsBound === 'true') return;
      if (UI.amOverlay && UI.amOverlay.contains(btn)) return;

      btn.dataset.ytmAmFsBound = 'true';
      btn.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          openAppleFullscreen(true);
        },
        true
      );
    });
  }

  /**
   * 전체화면 창에서 3초 이상 마우스 움직임이 없으면:
   * - 마우스 커서 숨김 (cursor: none)
   * - 좌상단 플레이어 크기 설정 알약(.ytm-am-top-left-pill) 숨김
   * - 우상단 음량 바 알약(.ytm-am-top-right-pill) 숨김
   */
  let fsMouseIdleTimer = null;

  function resetFullscreenMouseIdleTimer() {
    if (fsMouseIdleTimer) {
      clearTimeout(fsMouseIdleTimer);
      fsMouseIdleTimer = null;
    }

    if (UI.amOverlay) {
      UI.amOverlay.classList.remove('is-mouse-idle');
    }

    if (!STATE.isAppleFullscreen) return;

    fsMouseIdleTimer = setTimeout(() => {
      if (
        STATE.isAppleFullscreen &&
        !STATE.isScrubbing &&
        !STATE.isSyncPopoverOpen &&
        !STATE.isContextMenuOpen &&
        UI.amOverlay
      ) {
        UI.amOverlay.classList.add('is-mouse-idle');
      }
    }, 3000);
  }

  /**
   * 가사 영역 우클릭(Context Menu) 가사 제공자 변경 메뉴 생성 및 제어
   */
  const LYRICS_PROVIDERS = [
    { key: 'auto', label: '자동 탐색 (기본 추천)', stages: [] },
    { key: 'ytm', label: 'YouTube Music 공식 (실시간)', stages: ['ytm_timed_lyrics'] },
    { key: 'alsong', label: '알송 (Alsong)', stages: ['alsong_lrc'] },
    { key: 'lrclib', label: 'LRCLIB (글로벌)', stages: ['lrclib_structured', 'lrclib_query'] },
    { key: 'netease', label: 'NetEase (왕이윈)', stages: ['netease_lrc'] },
    { key: 'qq', label: 'QQ Music', stages: ['qq_lrc'] },
    { key: 'ytm_native', label: 'YouTube Music 기본 정적 가사', stages: ['ytm_native'] }
  ];

  function ensureProviderContextMenu() {
    if (UI.providerContextMenu && document.body.contains(UI.providerContextMenu)) {
      return UI.providerContextMenu;
    }

    const headerEl = createEl('div', {
      className: 'ytm-al-ctx-header',
      text: '가사 제공자 변경'
    });

    const listEl = createEl('div', { className: 'ytm-al-ctx-list' });

    const menuEl = createEl(
      'div',
      {
        id: 'ytm-al-provider-context-menu',
        className: 'ytm-al-provider-context-menu',
        attrs: { role: 'menu', 'aria-label': '가사 제공자 변경 메뉴' }
      },
      [headerEl, listEl]
    );

    document.body.appendChild(menuEl);
    UI.providerContextMenu = menuEl;
    UI.providerContextList = listEl;

    document.addEventListener('click', (e) => {
      if (STATE.isContextMenuOpen && !menuEl.contains(e.target)) {
        closeProviderContextMenu();
      }
    });

    window.addEventListener('blur', () => {
      if (STATE.isContextMenuOpen) closeProviderContextMenu();
    });

    return menuEl;
  }

  function closeProviderContextMenu() {
    STATE.isContextMenuOpen = false;
    if (UI.providerContextMenu) {
      UI.providerContextMenu.classList.remove('is-open');
    }
  }

  function openProviderContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();

    const menuEl = ensureProviderContextMenu();
    const listEl = UI.providerContextList;
    listEl.replaceChildren();

    // 전체화면 엘리먼트 호스트 내부로 이동 (브라우저 전체화면에서도 메뉴가 보이도록 보장)
    const fsHost =
      STATE.isAppleFullscreen && UI.amOverlay
        ? UI.amOverlay
        : document.fullscreenElement && document.fullscreenElement !== document.documentElement
          ? document.fullscreenElement
          : document.body;
    if (menuEl.parentElement !== fsHost) {
      fsHost.appendChild(menuEl);
    }

    LYRICS_PROVIDERS.forEach((prov) => {
      const isCurrentStage =
        (prov.key === STATE.preferredProviderKey && prov.key !== 'auto') ||
        (STATE.currentSourceStage && prov.stages.includes(STATE.currentSourceStage));

      const checkMark = createEl('span', {
        className: 'ytm-al-ctx-check',
        text: isCurrentStage ? '✓' : ''
      });
      const labelSpan = createEl('span', {
        className: 'ytm-al-ctx-label',
        text: prov.label
      });

      const itemBtn = createEl(
        'button',
        {
          className: `ytm-al-ctx-item ${isCurrentStage ? 'is-active' : ''}`,
          attrs: { type: 'button', role: 'menuitem' }
        },
        [checkMark, labelSpan]
      );

      itemBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeProviderContextMenu();
        switchLyricsProviderManual(prov.key);
      });

      listEl.appendChild(itemBtn);
    });

    STATE.isContextMenuOpen = true;
    menuEl.classList.add('is-open');

    // 화면 밖으로 나가지 않도록 좌표 보정
    const menuWidth = 228;
    const menuHeight = 290;
    const maxX = Math.max(12, window.innerWidth - menuWidth - 12);
    const maxY = Math.max(12, window.innerHeight - menuHeight - 12);
    const posX = Math.min(Math.max(12, e.clientX), maxX);
    const posY = Math.min(Math.max(12, e.clientY), maxY);

    menuEl.style.left = `${posX}px`;
    menuEl.style.top = `${posY}px`;
  }

  function switchLyricsProviderManual(providerKey) {
    if (!STATE.meta || !STATE.meta.rawTitle) return;

    STATE.preferredProviderKey = providerKey;

    if (providerKey === 'ytm_native') {
      const nativeText = extractNativeYtmLyrics();
      if (nativeText) {
        STATE.plainLyricsText = nativeText;
        STATE.lyricsStatus = 'plain';
        STATE.currentSourceStage = 'ytm_native';
        STATE.lyricsSourceLabel = 'YouTube Music 가사';
      } else {
        STATE.lyricsStatus = 'not_found';
        STATE.currentSourceStage = 'none';
        STATE.lyricsSourceLabel = 'YouTube Music 가사 없음';
      }
      renderLyricsView();
      return;
    }

    if (providerKey === 'auto') {
      requestMultiSourceLyrics(STATE.meta, { preferredSource: 'auto', forceRefresh: true });
      return;
    }

    requestMultiSourceLyrics(STATE.meta, { preferredSource: providerKey });
  }

  /**
   * 별도 독립형 Apple Music 전체화면 모드 열기 / 닫기
   */
  function openAppleFullscreen(requestBrowserFs = true) {
    STATE.isAppleFullscreen = true;

    if (UI.amOverlay) {
      // 만약 브라우저가 특정 엘리먼트(ytmusic-player 등)를 fullscreenElement로 잡고 있다면 그 안으로 이동
      const fsHost =
        document.fullscreenElement && document.fullscreenElement !== document.documentElement
          ? document.fullscreenElement
          : document.body;
      if (UI.amOverlay.parentElement !== fsHost) {
        fsHost.appendChild(UI.amOverlay);
      }
      UI.amOverlay.classList.add('is-open');
    }

    resetFullscreenMouseIdleTimer();

    if (requestBrowserFs && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }

    const video = STATE.videoElement || document.querySelector('video');
    if (video) {
      updateProgressBarUI(video);
      updatePlayPauseButtonIcon(video.paused);
    }
    if (STATE.rightViewMode === 'queue') {
      renderFullscreenQueueList();
    } else {
      setTimeout(() => scrollToActiveLine(true), 60);
    }
  }

  function closeAppleFullscreen(exitBrowserFs = true) {
    STATE.isAppleFullscreen = false;
    STATE.isSyncPopoverOpen = false;
    if (fsMouseIdleTimer) {
      clearTimeout(fsMouseIdleTimer);
      fsMouseIdleTimer = null;
    }
    if (UI.syncPopover) {
      UI.syncPopover.classList.remove('is-open');
    }
    if (UI.amOverlay) {
      UI.amOverlay.classList.remove('is-open', 'is-mouse-idle');
      if (UI.amOverlay.parentElement !== document.body) {
        document.body.appendChild(UI.amOverlay);
      }
    }
    if (exitBrowserFs && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
    setTimeout(() => scrollToActiveLine(true), 60);
  }

  /**
   * 일반 플레이어 페이지(ytmusic-player-page)의 기존 UI를 해치지 않으면서 은은한 앨범 컬러 배경만 추가
   */
  function ensureNormalPlayerPageEnhancements(playerPage) {
    if (!UI.pageBackdrop || !playerPage.contains(UI.pageBackdrop)) {
      const pBlob1 = createEl('div', { className: 'ytm-al-page-blob ytm-al-page-blob-1' });
      const pBlob2 = createEl('div', { className: 'ytm-al-page-blob ytm-al-page-blob-2' });
      const pScrim = createEl('div', { className: 'ytm-al-page-scrim' });
      const pageBackdrop = createEl(
        'div',
        {
          id: 'ytm-al-page-backdrop',
          className: 'ytm-al-page-backdrop'
        },
        [pBlob1, pBlob2, pScrim]
      );
      playerPage.prepend(pageBackdrop);
      UI.pageBackdrop = pageBackdrop;
      UI.pageBlobs = [pBlob1, pBlob2];
    }
  }

  /**
   * 기존 YouTube Music #side-panel의 '가사(Lyrics)' 탭 내부에 실시간 싱크 가사 뷰어 + 상단 툴바 통합
   */
  function createSidePanelIntegratedDOM(sidePanel) {
    // 상단 미니 툴바: [가사 출처 배지] + [싱크 오프셋 조절 버튼] + [전체화면 버튼]
    const tabSourceBadgeEl = createEl('span', {
      className: 'ytm-al-tab-source-badge',
      text: '실시간 싱크'
    });

    const tMinus05 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '-0.5s',
      attrs: { type: 'button', title: '가사 0.5초 빠르게' },
      dataset: { delta: '-0.5' }
    });
    const tMinus01 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '-0.1s',
      attrs: { type: 'button', title: '가사 0.1초 빠르게' },
      dataset: { delta: '-0.1' }
    });
    const tabOffsetValueEl = createEl('span', {
      className: 'ytm-al-offset-value',
      text: '0.0s'
    });
    const tReset = createEl(
      'button',
      {
        className: 'ytm-al-sync-btn ytm-al-sync-reset',
        attrs: { type: 'button', title: '싱크 오프셋 초기화' },
        dataset: { reset: 'true' }
      },
      [tabOffsetValueEl]
    );
    const tPlus01 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '+0.1s',
      attrs: { type: 'button', title: '가사 0.1초 느리게' },
      dataset: { delta: '0.1' }
    });
    const tPlus05 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '+0.5s',
      attrs: { type: 'button', title: '가사 0.5초 느리게' },
      dataset: { delta: '0.5' }
    });

    const syncButtonsWrap = createEl('div', { className: 'ytm-al-sync-buttons' }, [
      tMinus05,
      tMinus01,
      tReset,
      tPlus01,
      tPlus05
    ]);

    const fsIcon = createSvgIcon(13, [
      { tag: 'polyline', attrs: { points: '15 3 21 3 21 9' } },
      { tag: 'polyline', attrs: { points: '9 21 3 21 3 15' } },
      { tag: 'line', attrs: { x1: '21', y1: '3', x2: '14', y2: '10' } },
      { tag: 'line', attrs: { x1: '3', y1: '21', x2: '10', y2: '14' } }
    ]);
    const tabOpenFsBtn = createEl(
      'button',
      {
        className: 'ytm-al-tab-fs-btn',
        attrs: { type: 'button', title: 'Apple Music 전체화면 플레이어로 열기' }
      },
      [fsIcon, createEl('span', { text: '전체화면' })]
    );
    tabOpenFsBtn.addEventListener('click', () => {
      openAppleFullscreen(true);
    });

    const tabToolbar = createEl('div', { className: 'ytm-al-tab-toolbar' }, [
      tabSourceBadgeEl,
      syncButtonsWrap,
      tabOpenFsBtn
    ]);

    const tabLyricsContent = createEl('div', { className: 'ytm-al-content' });
    const tabLyricsViewport = createEl(
      'div',
      { className: 'ytm-al-viewport ytm-al-tab-viewport' },
      [tabLyricsContent]
    );

    const resumeIcon = createSvgIcon(14, [{ tag: 'polyline', attrs: { points: '6 9 12 15 18 9' } }]);
    const tabResumeScrollBtn = createEl(
      'button',
      {
        className: 'ytm-al-resume-btn',
        attrs: { type: 'button' }
      },
      [resumeIcon, createEl('span', { text: '현재 위치로 복귀' })]
    );

    const tabIntegratedBox = createEl(
      'section',
      {
        id: 'ytm-apple-lyrics-integrated',
        className: 'ytm-apple-lyrics-integrated',
        attrs: { 'aria-label': '가사 탭 통합 실시간 싱크 가사' }
      },
      [tabToolbar, tabLyricsViewport, tabResumeScrollBtn]
    );

    const tabsHeader = sidePanel.querySelector('tp-yt-paper-tabs');
    if (tabsHeader && tabsHeader.nextSibling) {
      sidePanel.insertBefore(tabIntegratedBox, tabsHeader.nextSibling);
    } else {
      sidePanel.appendChild(tabIntegratedBox);
    }

    UI.tabIntegratedBox = tabIntegratedBox;
    UI.tabSourceBadgeEl = tabSourceBadgeEl;
    UI.tabOffsetValueEl = tabOffsetValueEl;
    UI.tabResetBtnEl = tReset;
    UI.tabLyricsViewport = tabLyricsViewport;
    UI.tabLyricsContent = tabLyricsContent;
    UI.tabResumeScrollBtn = tabResumeScrollBtn;

    [tMinus05, tMinus01, tReset, tPlus01, tPlus05].forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.reset === 'true') {
          adjustSyncOffset(0, true);
        } else {
          adjustSyncOffset(parseFloat(btn.dataset.delta || '0'), false);
        }
      });
    });

    bindManualScrollHandlers(tabLyricsViewport, tabResumeScrollBtn);

    // 가사 탭에서 우클릭 시 가사 제공자 변경 메뉴 표시
    tabIntegratedBox.addEventListener('contextmenu', openProviderContextMenu);
  }

  /**
   * 별도 독립형 Apple Music 전체화면 플레이어 모달
   */
  function createStandaloneAppleFullscreenModal() {
    // A. 전체화면 앰비언트 앨범 컬러 배경 (3중 블롭 + 스크림)
    const blob1 = createEl('div', { className: 'ytm-am-blob ytm-am-blob-1' });
    const blob2 = createEl('div', { className: 'ytm-am-blob ytm-am-blob-2' });
    const blob3 = createEl('div', { className: 'ytm-am-blob ytm-am-blob-3' });
    const scrim = createEl('div', { className: 'ytm-am-scrim' });
    const backdrop = createEl('div', { className: 'ytm-am-backdrop' }, [
      blob1,
      blob2,
      blob3,
      scrim
    ]);

    // B. 좌상단 알약 컨트롤러: [ ✕ (전체화면 닫기) | ⧉ (기본 YTM 화면으로 복귀) ]
    const closeIcon = createSvgIcon(15, [
      { tag: 'line', attrs: { x1: '18', y1: '6', x2: '6', y2: '18' } },
      { tag: 'line', attrs: { x1: '6', y1: '6', x2: '18', y2: '18' } }
    ]);
    const btnCloseFs = createEl(
      'button',
      {
        className: 'ytm-am-pill-icon-btn',
        attrs: { type: 'button', title: '전체화면 가사 모드 닫기 (ESC)' }
      },
      [closeIcon]
    );

    const pipIcon = createSvgIcon(15, [
      { tag: 'rect', attrs: { x: '3', y: '3', width: '18', height: '18', rx: '3' } },
      { tag: 'rect', attrs: { x: '11', y: '11', width: '7', height: '7', rx: '1.5' } }
    ]);
    const btnMinimizeFs = createEl(
      'button',
      {
        className: 'ytm-am-pill-icon-btn',
        attrs: { type: 'button', title: '기본 YouTube Music 화면으로 돌아가기' }
      },
      [pipIcon]
    );

    const topLeftPill = createEl('div', { className: 'ytm-am-top-left-pill' }, [
      btnCloseFs,
      createEl('div', { className: 'ytm-am-pill-divider' }),
      btnMinimizeFs
    ]);

    // C. 우상단 볼륨 알약 컨트롤러: [ 📡 | ━━━━━━●━━ | 🔊 ]
    const castIcon = createSvgIcon(15, [
      { tag: 'circle', attrs: { cx: '12', cy: '11', r: '2' } },
      { tag: 'path', attrs: { d: 'M8.5 14.5a5 5 0 0 1 0-7' } },
      { tag: 'path', attrs: { d: 'M15.5 7.5a5 5 0 0 1 0 7' } },
      { tag: 'path', attrs: { d: 'M9 20h6l-3-5-3 5z' } }
    ]);
    const castSpan = createEl('span', { className: 'ytm-am-vol-cast-icon' }, [castIcon]);

    const volumeSlider = createEl('input', {
      className: 'ytm-am-volume-slider',
      attrs: {
        type: 'range',
        min: '0',
        max: '100',
        value: '100',
        'aria-label': '볼륨 조절'
      }
    });

    const speakerIcon = createSvgIcon(15, [
      { tag: 'polygon', attrs: { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5', fill: 'currentColor' } },
      { tag: 'path', attrs: { d: 'M15.54 8.46a5 5 0 0 1 0 7.07' } },
      { tag: 'path', attrs: { d: 'M19.07 4.93a10 10 0 0 1 0 14.14' } }
    ]);
    const volumeMuteBtn = createEl(
      'button',
      {
        className: 'ytm-am-vol-speaker-btn',
        attrs: { type: 'button', title: '음소거 전환' }
      },
      [speakerIcon]
    );

    const topRightPill = createEl('div', { className: 'ytm-am-top-right-pill' }, [
      castSpan,
      createEl('div', { className: 'ytm-am-pill-divider' }),
      volumeSlider,
      volumeMuteBtn
    ]);

    // D. 좌측 컬럼: 정사각형 앨범 아트 + 곡 정보/액션 버튼 + 프로그레스 바 + 재생 컨트롤
    const artImg = createEl('img', {
      className: 'ytm-am-artwork-img',
      attrs: { alt: '앨범 커버' }
    });
    const artWrap = createEl('div', { className: 'ytm-am-artwork-wrap' }, [artImg]);

    const songTitleEl = createEl('div', {
      className: 'ytm-am-song-title',
      text: '재생 중인 곡 없음'
    });
    const songSubtitleEl = createEl('div', {
      className: 'ytm-am-song-subtitle',
      text: 'YouTube Music'
    });
    const metaTextCol = createEl('div', { className: 'ytm-am-meta-text-col' }, [
      songTitleEl,
      songSubtitleEl
    ]);

    // ☆ 좋아요 버튼
    const starIcon = createSvgIcon(15, [
      {
        tag: 'polygon',
        attrs: {
          points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2'
        }
      }
    ]);
    const favBtn = createEl(
      'button',
      {
        className: 'ytm-am-circle-action-btn',
        attrs: { type: 'button', title: '좋아요 표시' }
      },
      [starIcon]
    );

    // ••• 더보기 / 싱크 미세 조절 버튼
    const dotsIcon = createSvgIcon(
      15,
      [
        { tag: 'circle', attrs: { cx: '5', cy: '12', r: '1.8' } },
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '1.8' } },
        { tag: 'circle', attrs: { cx: '19', cy: '12', r: '1.8' } }
      ],
      '0 0 24 24',
      'currentColor',
      '0'
    );
    const moreBtn = createEl(
      'button',
      {
        className: 'ytm-am-circle-action-btn',
        attrs: { type: 'button', title: '가사 싱크 미세 조절 및 정보' }
      },
      [dotsIcon]
    );

    // 싱크 미세 조절 팝오버 (••• 클릭 시 표시)
    const sourceBadgeEl = createEl('span', {
      className: 'ytm-am-source-badge',
      text: '실시간 싱크'
    });
    const btnMinus05 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '-0.5s',
      attrs: { type: 'button' },
      dataset: { delta: '-0.5' }
    });
    const btnMinus01 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '-0.1s',
      attrs: { type: 'button' },
      dataset: { delta: '-0.1' }
    });
    const offsetValueEl = createEl('span', {
      className: 'ytm-al-offset-value',
      text: '0.0s'
    });
    const btnReset = createEl(
      'button',
      {
        className: 'ytm-al-sync-btn ytm-al-sync-reset',
        attrs: { type: 'button', title: '오프셋 초기화' },
        dataset: { reset: 'true' }
      },
      [offsetValueEl]
    );
    const btnPlus01 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '+0.1s',
      attrs: { type: 'button' },
      dataset: { delta: '0.1' }
    });
    const btnPlus05 = createEl('button', {
      className: 'ytm-al-sync-btn',
      text: '+0.5s',
      attrs: { type: 'button' },
      dataset: { delta: '0.5' }
    });

    const syncPopover = createEl('div', { className: 'ytm-am-sync-popover' }, [
      createEl('div', { className: 'ytm-am-popover-header' }, [
        createEl('span', { text: '가사 싱크 미세 조절' }),
        sourceBadgeEl
      ]),
      createEl('div', { className: 'ytm-al-sync-buttons' }, [
        btnMinus05,
        btnMinus01,
        btnReset,
        btnPlus01,
        btnPlus05
      ])
    ]);

    const actionBtnsCol = createEl('div', { className: 'ytm-am-meta-actions' }, [
      favBtn,
      moreBtn,
      syncPopover
    ]);

    const metaRow = createEl('div', { className: 'ytm-am-meta-row' }, [
      metaTextCol,
      actionBtnsCol
    ]);

    // 프로그레스 시크바 + 경과/남은 시간
    const scrubberFill = createEl('div', { className: 'ytm-am-scrubber-fill' });
    const scrubberTrack = createEl('div', { className: 'ytm-am-scrubber-track' }, [scrubberFill]);
    const timeCurrentEl = createEl('span', { className: 'ytm-am-time-label', text: '0:00' });
    const timeRemainingEl = createEl('span', { className: 'ytm-am-time-label', text: '-0:00' });
    const timeRow = createEl('div', { className: 'ytm-am-time-row' }, [
      timeCurrentEl,
      timeRemainingEl
    ]);
    const scrubberSection = createEl('div', { className: 'ytm-am-scrubber-section' }, [
      scrubberTrack,
      timeRow
    ]);

    // 재생 컨트롤러 (셔플 · 이전 · 재생/일시정지 · 다음 · 반복)
    const shuffleIcon = createSvgIcon(17, [
      { tag: 'polyline', attrs: { points: '16 3 21 3 21 8' } },
      { tag: 'line', attrs: { x1: '4', y1: '20', x2: '21', y2: '3' } },
      { tag: 'polyline', attrs: { points: '21 16 21 21 16 21' } },
      { tag: 'line', attrs: { x1: '15', y1: '15', x2: '21', y2: '21' } },
      { tag: 'line', attrs: { x1: '4', y1: '4', x2: '9', y2: '9' } }
    ]);
    const shuffleBtn = createEl(
      'button',
      { className: 'ytm-am-transport-btn is-small', attrs: { type: 'button', title: '셔플' } },
      [shuffleIcon]
    );

    const prevIcon = createSvgIcon(
      24,
      [
        { tag: 'path', attrs: { d: 'M19 20L9 12l10-8v16z' } },
        { tag: 'rect', attrs: { x: '5', y: '4', width: '2.4', height: '16', rx: '1' } }
      ],
      '0 0 24 24',
      'currentColor',
      '0'
    );
    const prevBtn = createEl(
      'button',
      { className: 'ytm-am-transport-btn', attrs: { type: 'button', title: '이전 곡' } },
      [prevIcon]
    );

    const playPauseBtn = createEl('button', {
      className: 'ytm-am-transport-btn is-play-pause',
      attrs: { type: 'button', title: '재생 / 일시정지' }
    });

    const nextIcon = createSvgIcon(
      24,
      [
        { tag: 'path', attrs: { d: 'M5 4l10 8-10 8V4z' } },
        { tag: 'rect', attrs: { x: '16.6', y: '4', width: '2.4', height: '16', rx: '1' } }
      ],
      '0 0 24 24',
      'currentColor',
      '0'
    );
    const nextBtn = createEl(
      'button',
      { className: 'ytm-am-transport-btn', attrs: { type: 'button', title: '다음 곡' } },
      [nextIcon]
    );

    const repeatIcon = createSvgIcon(17, [
      { tag: 'polyline', attrs: { points: '17 1 21 5 17 9' } },
      { tag: 'path', attrs: { d: 'M3 11V9a4 4 0 0 1 4-4h14' } },
      { tag: 'polyline', attrs: { points: '7 23 3 19 7 15' } },
      { tag: 'path', attrs: { d: 'M21 13v2a4 4 0 0 1-4 4H3' } }
    ]);
    const repeatBtn = createEl(
      'button',
      { className: 'ytm-am-transport-btn is-small', attrs: { type: 'button', title: '반복 재생' } },
      [repeatIcon]
    );

    const transportRow = createEl('div', { className: 'ytm-am-transport-row' }, [
      shuffleBtn,
      prevBtn,
      playPauseBtn,
      nextBtn,
      repeatBtn
    ]);

    const leftColumn = createEl('div', { className: 'ytm-am-left-col' }, [
      artWrap,
      metaRow,
      scrubberSection,
      transportRow
    ]);

    // E. 우측 컬럼:
    //    1) 테두리 없는 순수 Apple Music 싱크 가사 뷰포트 (💬 모드)
    //    2) 다음 트랙(Up Next) 큐 뷰포트 (☰ 모드)
    const lyricsContent = createEl('div', { className: 'ytm-al-content' });
    const lyricsViewport = createEl(
      'div',
      { className: 'ytm-al-viewport ytm-am-fullscreen-viewport' },
      [lyricsContent]
    );

    const queueHeader = createEl('div', {
      className: 'ytm-am-queue-header',
      text: '다음 트랙 (재생목록)'
    });
    const queueListEl = createEl('div', { className: 'ytm-am-queue-list' });
    const queueViewport = createEl('div', { className: 'ytm-am-queue-viewport' }, [
      queueHeader,
      queueListEl
    ]);

    const resumeIcon = createSvgIcon(15, [{ tag: 'polyline', attrs: { points: '6 9 12 15 18 9' } }]);
    const resumeScrollBtn = createEl(
      'button',
      {
        className: 'ytm-al-resume-btn',
        attrs: { type: 'button', 'aria-live': 'polite' }
      },
      [resumeIcon, createEl('span', { text: '현재 위치로 복귀' })]
    );

    const rightColumn = createEl('div', { className: 'ytm-am-right-col' }, [
      lyricsViewport,
      queueViewport,
      resumeScrollBtn
    ]);

    // F. 우하단 모드 전환 알약: [ 💬 (가사) | ☰ (다음 트랙) ]
    const quoteIcon = createSvgIcon(15, [
      {
        tag: 'path',
        attrs: { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }
      }
    ]);
    const modeLyricsBtn = createEl(
      'button',
      {
        className: 'ytm-am-bottom-pill-btn is-active',
        attrs: { type: 'button', title: '실시간 싱크 가사 보기' }
      },
      [quoteIcon]
    );

    const listIcon = createSvgIcon(15, [
      { tag: 'line', attrs: { x1: '8', y1: '6', x2: '21', y2: '6' } },
      { tag: 'line', attrs: { x1: '8', y1: '12', x2: '21', y2: '12' } },
      { tag: 'line', attrs: { x1: '8', y1: '18', x2: '21', y2: '18' } },
      { tag: 'line', attrs: { x1: '3', y1: '6', x2: '3.01', y2: '6' } },
      { tag: 'line', attrs: { x1: '3', y1: '12', x2: '3.01', y2: '12' } },
      { tag: 'line', attrs: { x1: '3', y1: '18', x2: '3.01', y2: '18' } }
    ]);
    const modeQueueBtn = createEl(
      'button',
      {
        className: 'ytm-am-bottom-pill-btn',
        attrs: { type: 'button', title: '다음 트랙(재생목록) 보기' }
      },
      [listIcon]
    );

    const bottomRightPill = createEl('div', { className: 'ytm-am-bottom-right-pill' }, [
      modeLyricsBtn,
      modeQueueBtn
    ]);

    // G. 전체 오버레이 조립 및 document.body 직속 주입
    const amOverlay = createEl(
      'div',
      {
        id: 'ytm-apple-music-fullscreen',
        className: `ytm-apple-music-fullscreen ${STATE.isAppleFullscreen ? 'is-open' : ''}`
      },
      [
        backdrop,
        topLeftPill,
        topRightPill,
        createEl('div', { className: 'ytm-am-main-grid' }, [leftColumn, rightColumn]),
        bottomRightPill
      ]
    );

    document.body.appendChild(amOverlay);

    // 참조 저장
    UI.amOverlay = amOverlay;
    UI.backdropBlobs = [blob1, blob2, blob3];
    UI.artImg = artImg;
    UI.songTitleEl = songTitleEl;
    UI.songSubtitleEl = songSubtitleEl;
    UI.favBtn = favBtn;
    UI.moreBtn = moreBtn;
    UI.syncPopover = syncPopover;
    UI.sourceBadgeEl = sourceBadgeEl;
    UI.offsetValueEl = offsetValueEl;
    UI.resetBtnEl = btnReset;
    UI.scrubberWrap = scrubberTrack;
    UI.scrubberFill = scrubberFill;
    UI.timeCurrentEl = timeCurrentEl;
    UI.timeRemainingEl = timeRemainingEl;
    UI.playPauseBtn = playPauseBtn;
    UI.shuffleBtn = shuffleBtn;
    UI.repeatBtn = repeatBtn;
    UI.volumeSlider = volumeSlider;
    UI.volumeMuteBtn = volumeMuteBtn;
    UI.lyricsViewport = lyricsViewport;
    UI.lyricsContent = lyricsContent;
    UI.queueViewport = queueViewport;
    UI.queueListEl = queueListEl;
    UI.resumeScrollBtn = resumeScrollBtn;
    UI.modeLyricsBtn = modeLyricsBtn;
    UI.modeQueueBtn = modeQueueBtn;

    updatePlayPauseButtonIcon(false);

    // === 이벤트 바인딩 ===

    // 1. 좌상단 ✕ 및 ⧉ 버튼: 독립 전체화면 모드 닫기 (기본 YouTube Music 화면으로 즉시 복귀)
    btnCloseFs.addEventListener('click', () => {
      closeAppleFullscreen(true);
    });
    btnMinimizeFs.addEventListener('click', () => {
      closeAppleFullscreen(true);
    });

    // 2. 우상단 볼륨 조절 슬라이더 & 음소거
    volumeSlider.addEventListener('input', () => {
      const val = Number(volumeSlider.value);
      const video = STATE.videoElement || document.querySelector('video');
      if (video) {
        video.volume = Math.min(1, Math.max(0, val / 100));
        video.muted = val === 0;
      }
    });
    volumeMuteBtn.addEventListener('click', () => {
      const video = STATE.videoElement || document.querySelector('video');
      if (video) {
        video.muted = !video.muted;
        volumeSlider.value = video.muted ? '0' : String(Math.round(video.volume * 100));
      }
    });

    // 3. ☆ 좋아요 버튼: YTM의 좋아요 버튼 트리거 + 좋아요 활성화 시 현재 곡 가사를 영구 로컬 캐시(chrome.storage.local)에 즉시 저장
    favBtn.addEventListener('click', () => {
      const ytmLikeBtn = document.querySelector(
        'ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like button, ytmusic-player-bar .like'
      );
      if (ytmLikeBtn) ytmLikeBtn.click();
      const isLikedNow = favBtn.classList.toggle('is-active');
      if (isLikedNow) {
        notifyPersistCurrentTrackLyrics();
      }
    });

    // 4. ••• 버튼: 싱크 미세 조절 팝오버 토글
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.isSyncPopoverOpen = !STATE.isSyncPopoverOpen;
      syncPopover.classList.toggle('is-open', STATE.isSyncPopoverOpen);
    });
    document.addEventListener('click', (e) => {
      if (STATE.isSyncPopoverOpen && !syncPopover.contains(e.target) && e.target !== moreBtn) {
        STATE.isSyncPopoverOpen = false;
        syncPopover.classList.remove('is-open');
      }
    });

    // 싱크 미세 조절 버튼 이벤트
    [btnMinus05, btnMinus01, btnReset, btnPlus01, btnPlus05].forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.reset === 'true') {
          adjustSyncOffset(0, true);
        } else {
          adjustSyncOffset(parseFloat(btn.dataset.delta || '0'), false);
        }
      });
    });

    // 5. 프로그레스 바 클릭/드래그 시크(Seek)
    const seekFromPointer = (clientX) => {
      const video = getActiveVideoElement();
      if (!video) return;
      const { dur } = getEffectivePlaybackState(video);
      if (dur <= 0) return;

      const rect = scrubberTrack.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      video.currentTime = ratio * dur;
      updateProgressBarUI(video);
    };

    scrubberTrack.addEventListener('mousedown', (e) => {
      STATE.isScrubbing = true;
      seekFromPointer(e.clientX);
      const onMove = (ev) => seekFromPointer(ev.clientX);
      const onUp = () => {
        STATE.isScrubbing = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // 6. 재생 컨트롤러 버튼 (YTM 플레이어 버튼 연동)
    playPauseBtn.addEventListener('click', () => {
      const video = STATE.videoElement || document.querySelector('video');
      if (video) {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      } else {
        const ytmPlay = document.querySelector('ytmusic-player-bar #play-pause-button');
        if (ytmPlay) ytmPlay.click();
      }
    });

    prevBtn.addEventListener('click', () => {
      const ytmPrev = document.querySelector('ytmusic-player-bar .previous-button');
      if (ytmPrev) ytmPrev.click();
    });

    nextBtn.addEventListener('click', () => {
      const ytmNext = document.querySelector('ytmusic-player-bar .next-button');
      if (ytmNext) ytmNext.click();
    });

    shuffleBtn.addEventListener('click', () => {
      const ytmShuffle = document.querySelector('ytmusic-player-bar .shuffle');
      if (ytmShuffle) ytmShuffle.click();
      shuffleBtn.classList.toggle('is-active');
    });

    repeatBtn.addEventListener('click', () => {
      const ytmRepeat = document.querySelector('ytmusic-player-bar .repeat');
      if (ytmRepeat) ytmRepeat.click();
      repeatBtn.classList.toggle('is-active');
    });

    // 7. 우하단 [ 💬 (가사) | ☰ (다음 트랙) ] 모드 전환
    modeLyricsBtn.addEventListener('click', () => {
      STATE.rightViewMode = 'lyrics';
      modeLyricsBtn.classList.add('is-active');
      modeQueueBtn.classList.remove('is-active');
      amOverlay.classList.remove('is-queue-mode');
      setTimeout(() => scrollToActiveLine(true), 50);
    });

    modeQueueBtn.addEventListener('click', () => {
      STATE.rightViewMode = 'queue';
      modeQueueBtn.classList.add('is-active');
      modeLyricsBtn.classList.remove('is-active');
      amOverlay.classList.add('is-queue-mode');
      renderFullscreenQueueList();
    });

    // 8. 수동 스크롤 감지 및 '현재 위치로 복귀'
    bindManualScrollHandlers(lyricsViewport, resumeScrollBtn);

    // 가사 뷰포트에서 우클릭 시 가사 제공자 변경 메뉴 표시
    lyricsViewport.addEventListener('contextmenu', openProviderContextMenu);

    // 9. 전체화면 3초 마우스 유휴(Idle) 감지 이벤트 바인딩
    ['mousemove', 'mousedown', 'wheel', 'touchstart', 'pointermove'].forEach((evtName) => {
      amOverlay.addEventListener(evtName, resetFullscreenMouseIdleTimer, { passive: true });
    });
  }

  /**
   * 전체화면 모드 우하단 ☰ 버튼 클릭 시 현재 재생목록(Up Next)을 깔끔한 Apple Music 스타일 리스트로 렌더링
   */
  function renderFullscreenQueueList() {
    if (!UI.queueListEl) return;
    UI.queueListEl.replaceChildren();

    const queueItems = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
    if (queueItems.length === 0) {
      UI.queueListEl.appendChild(
        createEl('div', {
          className: 'ytm-am-queue-empty',
          text: '재생목록을 불러오려면 플레이어 페이지를 한 번 열어주세요.'
        })
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    queueItems.slice(0, 60).forEach((item) => {
      const titleEl = item.querySelector('.song-title');
      const bylineEl = item.querySelector('.byline');
      const durationEl = item.querySelector('.duration');
      const imgEl = item.querySelector('img');
      const isSelected =
        item.hasAttribute('selected') || item.getAttribute('play-button-state') === 'playing';

      const title = titleEl ? titleEl.textContent.trim() : '';
      const artist = bylineEl ? bylineEl.textContent.trim() : '';
      const dur = durationEl ? durationEl.textContent.trim() : '';
      const thumb = imgEl ? imgEl.getAttribute('src') || '' : '';

      if (!title) return;

      const thumbNode = thumb
        ? createEl('img', { className: 'ytm-am-queue-thumb', attrs: { src: thumb, alt: '' } })
        : createEl('div', { className: 'ytm-am-queue-thumb' });
      const thumbWrap = createEl('div', { className: 'ytm-am-queue-thumb-wrap' }, [thumbNode]);

      const row = createEl(
        'div',
        {
          className: `ytm-am-queue-item ${isSelected ? 'is-current' : ''}`
        },
        [
          thumbWrap,
          createEl('div', { className: 'ytm-am-queue-meta' }, [
            createEl('div', { className: 'ytm-am-queue-title', text: title }),
            createEl('div', { className: 'ytm-am-queue-artist', text: artist })
          ]),
          createEl('div', { className: 'ytm-am-queue-duration', text: dur })
        ]
      );

      row.addEventListener('click', () => {
        const playBtn = item.querySelector('ytmusic-play-button-renderer');
        if (playBtn) {
          playBtn.click();
        } else {
          item.click();
        }
        setTimeout(() => renderFullscreenQueueList(), 350);
      });

      fragment.appendChild(row);
    });

    UI.queueListEl.appendChild(fragment);
    updateSavedLyricsBadgesOnPage(UI.queueListEl);
  }

  function bindManualScrollHandlers(viewport, resumeBtn) {
    if (!viewport) return;

    const triggerManual = () => {
      if (STATE.lyricsStatus !== 'synced') return;
      if (performance.now() < STATE.resumeCooldownUntil) return;

      STATE.isUserScrolling = true;
      if (UI.resumeScrollBtn) UI.resumeScrollBtn.classList.add('is-visible');
      if (UI.tabResumeScrollBtn) UI.tabResumeScrollBtn.classList.add('is-visible');

      if (STATE.userScrollTimer) clearTimeout(STATE.userScrollTimer);
      STATE.userScrollTimer = setTimeout(() => {
        resumeAutoScroll();
      }, 3500);
    };

    viewport.addEventListener('wheel', triggerManual, { passive: true });
    viewport.addEventListener('touchmove', triggerManual, { passive: true });
    viewport.addEventListener(
      'scroll',
      () => {
        if (!STATE.programmaticScrollLock && STATE.isUserScrolling) {
          if (STATE.userScrollTimer) clearTimeout(STATE.userScrollTimer);
          STATE.userScrollTimer = setTimeout(() => {
            resumeAutoScroll();
          }, 3500);
        }
      },
      { passive: true }
    );

    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => {
        STATE.resumeCooldownUntil = performance.now() + 700;
        resumeAutoScroll();
      });
    }
  }

  /**
   * 기존 #side-panel의 '가사' 탭 잠금 해제 및 선택 상태 동기화
   * - 자동재생(Autoplay)으로 다음 곡에 넘어갈 때 YTM 내부 컨트롤러가 '가사' 탭을 강제로 비활성화하고
   *   '다음 트랙' 탭으로 되돌려 가사창이 닫히는 현상을 방지!
   */
  function unlockAndSyncNativeLyricsTab(sidePanel) {
    const tabsContainer = sidePanel.querySelector('tp-yt-paper-tabs');
    if (!tabsContainer) return;

    const tabs = Array.from(tabsContainer.querySelectorAll('tp-yt-paper-tab'));
    if (tabs.length < 2) return;

    const lyricsTab = tabs[1];
    if (lyricsTab.hasAttribute('disabled')) {
      lyricsTab.removeAttribute('disabled');
    }
    if (lyricsTab.getAttribute('aria-disabled') === 'true') {
      lyricsTab.setAttribute('aria-disabled', 'false');
    }
    lyricsTab.classList.remove('iron-disabled');
    lyricsTab.style.pointerEvents = 'auto';
    lyricsTab.style.opacity = '1';

    if (UI.boundTabsContainer !== tabsContainer) {
      UI.boundTabsContainer = tabsContainer;

      const initiallySelected =
        lyricsTab.classList.contains('iron-selected') ||
        lyricsTab.getAttribute('aria-selected') === 'true';
      if (initiallySelected) {
        STATE.userSelectedLyricsTab = true;
      }

      lyricsTab.addEventListener(
        'click',
        () => {
          STATE.userSelectedLyricsTab = true;
          sidePanel.classList.add('ytm-al-lyrics-tab-active');
          setTimeout(() => scrollToActiveLine(true), 50);
        },
        true
      );

      tabs.forEach((t, idx) => {
        if (idx !== 1) {
          t.addEventListener(
            'click',
            (e) => {
              // 사용자가 직접 마우스/키보드로 다른 탭('다음 트랙' 등)을 클릭한 경우에만 가사 탭 해제
              if (e.isTrusted) {
                STATE.userSelectedLyricsTab = false;
                sidePanel.classList.remove('ytm-al-lyrics-tab-active');
              }
            },
            true
          );
        }
      });
    }

    let isLyricsSelected =
      lyricsTab.classList.contains('iron-selected') ||
      lyricsTab.getAttribute('aria-selected') === 'true';

    // 사용자가 '가사' 탭을 열어둔 상태였는데 자동재생 전환 시 YTM이 강제로 탭 선택을 풀어버린 경우 즉시 복구!
    if (STATE.userSelectedLyricsTab && !isLyricsSelected) {
      tabs.forEach((t, idx) => {
        const active = idx === 1;
        t.classList.toggle('iron-selected', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      try {
        if (typeof tabsContainer.select === 'function') {
          tabsContainer.select(1);
        } else {
          tabsContainer.selected = 1;
        }
      } catch (e) {}
      isLyricsSelected = true;
    } else if (isLyricsSelected) {
      STATE.userSelectedLyricsTab = true;
    }

    sidePanel.classList.toggle('ytm-al-lyrics-tab-active', isLyricsSelected);
  }

  /**
   * 재생/일시정지 아이콘 업데이트
   */
  function updatePlayPauseButtonIcon(isPaused) {
    if (!UI.playPauseBtn) return;
    UI.playPauseBtn.replaceChildren();

    if (isPaused) {
      const playSvg = createSvgIcon(
        34,
        [{ tag: 'path', attrs: { d: 'M7 4v16l13-8L7 4z' } }],
        '0 0 24 24',
        'currentColor',
        '0'
      );
      UI.playPauseBtn.appendChild(playSvg);
    } else {
      const pauseSvg = createSvgIcon(
        34,
        [
          { tag: 'rect', attrs: { x: '6', y: '4', width: '4.5', height: '16', rx: '1.5' } },
          { tag: 'rect', attrs: { x: '13.5', y: '4', width: '4.5', height: '16', rx: '1.5' } }
        ],
        '0 0 24 24',
        'currentColor',
        '0'
      );
      UI.playPauseBtn.appendChild(pauseSvg);
    }
  }

  function resumeAutoScroll() {
    if (STATE.userScrollTimer) {
      clearTimeout(STATE.userScrollTimer);
      STATE.userScrollTimer = null;
    }
    STATE.isUserScrolling = false;
    if (UI.resumeScrollBtn) {
      UI.resumeScrollBtn.classList.remove('is-visible');
    }
    if (UI.tabResumeScrollBtn) {
      UI.tabResumeScrollBtn.classList.remove('is-visible');
    }
    if (STATE.activeLineIndex >= 0) {
      scrollToActiveLine(false);
    }
  }

  function adjustSyncOffset(deltaSec, isReset = false) {
    if (isReset) {
      STATE.offsetSec = 0.0;
    } else {
      STATE.offsetSec = Number((STATE.offsetSec + deltaSec).toFixed(2));
    }

    if (STATE.currentTrackKey) {
      STATE.trackOffsets[STATE.currentTrackKey] = STATE.offsetSec;
    }

    updateOffsetDisplay();

    const video = STATE.videoElement || document.querySelector('video');
    if (STATE.lyricsStatus === 'synced' && video) {
      const effectiveTime = video.currentTime + STATE.offsetSec + 0.06;
      const newIndex = findActiveLineIndexBinarySearch(STATE.lyricsLines, effectiveTime);
      updateActiveLyricLine(newIndex);
    }
  }

  function updateOffsetDisplay() {
    const val = STATE.offsetSec;
    const sign = val > 0 ? '+' : '';
    const text = val === 0 ? '0.0s' : `${sign}${val.toFixed(1)}s`;

    if (UI.offsetValueEl && UI.resetBtnEl) {
      UI.offsetValueEl.textContent = text;
      UI.resetBtnEl.classList.toggle('is-modified', val !== 0);
    }
    if (UI.tabOffsetValueEl && UI.tabResetBtnEl) {
      UI.tabOffsetValueEl.textContent = text;
      UI.tabResetBtnEl.classList.toggle('is-modified', val !== 0);
    }
  }

  /**
   * 앨범 커버, 배경 블롭, 곡 제목 및 아티스트 — 앨범명 UI 갱신
   */
  function updatePlayerPageVisuals() {
    const { cleanTitle, rawTitle, cleanArtist, rawArtist, album, coverUrl } = STATE.meta;

    // 1. 독립 전체화면 모달 배경 블롭
    if (UI.backdropBlobs && UI.backdropBlobs.length > 0) {
      UI.backdropBlobs.forEach((blob) => {
        blob.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : 'none';
      });
    }

    // 2. 일반 플레이어 페이지 은은한 배경 블롭
    if (UI.pageBlobs && UI.pageBlobs.length > 0) {
      UI.pageBlobs.forEach((blob) => {
        blob.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : 'none';
      });
    }

    // 3. 전체화면 앨범 커버 이미지
    if (UI.artImg) {
      if (coverUrl) {
        UI.artImg.src = coverUrl;
        UI.artImg.style.opacity = '1';
      } else {
        UI.artImg.style.opacity = '0';
      }
    }

    // 4. 전체화면 곡 제목 / 아티스트 — 앨범명
    if (UI.songTitleEl && UI.songSubtitleEl) {
      UI.songTitleEl.textContent = cleanTitle || rawTitle || '재생 중인 곡 없음';
      const artistText = cleanArtist || rawArtist || '';
      UI.songSubtitleEl.textContent =
        album && album !== artistText ? `${artistText} — ${album}` : artistText;
    }

    if (STATE.isAppleFullscreen && STATE.rightViewMode === 'queue') {
      renderFullscreenQueueList();
    }

    updateOffsetDisplay();
  }

  function buildStateBox({ iconText, isSpinner = false, titleText, descNodeOrText }) {
    const children = [];
    if (isSpinner) {
      children.push(createEl('div', { className: 'ytm-al-spinner' }));
    } else if (iconText) {
      children.push(createEl('div', { className: 'ytm-al-state-icon', text: iconText }));
    }

    children.push(createEl('div', { className: 'ytm-al-state-title', text: titleText }));

    if (typeof descNodeOrText === 'string') {
      children.push(createEl('div', { className: 'ytm-al-state-desc', text: descNodeOrText }));
    } else if (descNodeOrText instanceof Node) {
      children.push(descNodeOrText);
    }

    return createEl('div', { className: 'ytm-al-state-box' }, children);
  }

  /**
   * 특정 컨테이너에 가사 목록을 렌더링하는 공통 렌더러
   */
  function populateLyricsContainer(contentEl, lineElementsStore) {
    if (!contentEl) return;
    contentEl.replaceChildren();
    lineElementsStore.length = 0;

    if (STATE.lyricsStatus === 'ad') {
      contentEl.appendChild(
        buildStateBox({
          iconText: '📢',
          titleText: '광고 재생 중입니다',
          descNodeOrText: '음원 재생이 시작되면 실시간 가사를 자동으로 불러옵니다.'
        })
      );
      return;
    }

    if (STATE.lyricsStatus === 'loading') {
      contentEl.appendChild(
        buildStateBox({
          isSpinner: true,
          titleText: '실시간 싱크 가사를 찾는 중...',
          descNodeOrText: `${STATE.meta.cleanTitle || STATE.meta.rawTitle} — ${STATE.meta.cleanArtist || STATE.meta.rawArtist}`
        })
      );
      return;
    }

    if (STATE.lyricsStatus === 'synced' && STATE.lyricsLines.length > 0) {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(createEl('div', { className: 'ytm-al-spacer' }));

      STATE.lyricsLines.forEach((lineObj, idx) => {
        const lineEl = createEl('div', {
          className: `ytm-al-line ${lineObj.isInterlude ? 'is-interlude' : ''}`,
          dataset: {
            index: String(idx),
            time: String(lineObj.time)
          }
        });

        if (lineObj.isInterlude) {
          const dotsWrap = createEl(
            'span',
            {
              className: 'ytm-al-interlude-dots',
              attrs: { 'aria-label': '간주 구간' }
            },
            [
              createEl('span', { className: 'dot' }),
              createEl('span', { className: 'dot' }),
              createEl('span', { className: 'dot' })
            ]
          );
          lineEl.appendChild(dotsWrap);
        } else {
          lineEl.textContent = lineObj.text;
        }

        lineEl.addEventListener('click', () => {
          seekToLyricTime(lineObj.time);
        });

        fragment.appendChild(lineEl);
        lineElementsStore.push(lineEl);
      });

      fragment.appendChild(createEl('div', { className: 'ytm-al-spacer' }));
      contentEl.appendChild(fragment);
      return;
    }

    if (STATE.lyricsStatus === 'plain' && STATE.plainLyricsText) {
      const wrapper = createEl('div', { className: 'ytm-al-plain-container' });
      wrapper.appendChild(
        createEl('div', {
          className: 'ytm-al-plain-banner',
          text: '실시간 싱크가 지원되지 않는 가사입니다'
        })
      );

      const lines = STATE.plainLyricsText.split(/\r?\n/);
      lines.forEach((lineText) => {
        wrapper.appendChild(
          createEl('p', {
            className: 'ytm-al-plain-line',
            text: lineText.trim() || '\u00A0'
          })
        );
      });

      contentEl.appendChild(wrapper);
      return;
    }

    if (STATE.lyricsStatus === 'instrumental') {
      contentEl.appendChild(
        buildStateBox({
          iconText: '🎵',
          titleText: '가사가 없는 연주곡(Instrumental)입니다',
          descNodeOrText: '음악을 감상해 보세요.'
        })
      );
      return;
    }

    const descEl = createEl('div', { className: 'ytm-al-state-desc' }, [
      document.createTextNode('정제된 제목: '),
      createEl('strong', { text: STATE.meta.cleanTitle || '-' }),
      createEl('br'),
      document.createTextNode('아티스트: '),
      createEl('strong', { text: STATE.meta.cleanArtist || '-' })
    ]);

    contentEl.appendChild(
      buildStateBox({
        iconText: '🔍',
        titleText: '가사를 찾을 수 없습니다',
        descNodeOrText: descEl
      })
    );
  }

  /**
   * Apple Music 전체화면 뷰포트 & 기존 '가사' 탭 뷰포트 동시 렌더링
   */
  function renderLyricsView() {
    STATE.activeLineIndex = -1;
    resumeAutoScroll();

    const badgeText = STATE.lyricsSourceLabel || '검색 중';
    if (UI.sourceBadgeEl) {
      UI.sourceBadgeEl.textContent = badgeText;
    }
    if (UI.tabSourceBadgeEl) {
      UI.tabSourceBadgeEl.textContent = badgeText;
      UI.tabSourceBadgeEl.className = `ytm-al-tab-source-badge is-${STATE.lyricsStatus}`;
    }

    populateLyricsContainer(UI.lyricsContent, UI.lineElements);
    populateLyricsContainer(UI.tabLyricsContent, UI.tabLineElements);

    if (STATE.lyricsStatus === 'synced' && STATE.lyricsLines.length > 0) {
      const video = getActiveVideoElement();
      if (video) {
        const { cur } = getEffectivePlaybackState(video);
        const idx = findActiveLineIndexBinarySearch(
          STATE.lyricsLines,
          cur + STATE.offsetSec + 0.06
        );
        updateActiveLyricLine(idx);
        if (idx < 0) {
          if (UI.lyricsViewport) UI.lyricsViewport.scrollTop = 0;
          if (UI.tabLyricsViewport) UI.tabLyricsViewport.scrollTop = 0;
        } else {
          setTimeout(() => scrollToActiveLine(true), 60);
        }
      }
    } else {
      if (UI.lyricsViewport) UI.lyricsViewport.scrollTop = 0;
      if (UI.tabLyricsViewport) UI.tabLyricsViewport.scrollTop = 0;
    }
  }

  function seekToLyricTime(timeSec) {
    const video = getActiveVideoElement();
    if (!video || !Number.isFinite(timeSec)) return;

    const targetVideoTime = Math.max(0, timeSec - STATE.offsetSec);
    video.currentTime = targetVideoTime;

    if (video.paused) {
      video.play().catch(() => {});
    }

    STATE.resumeCooldownUntil = performance.now() + 700;
    resumeAutoScroll();
    const idx = findActiveLineIndexBinarySearch(STATE.lyricsLines, timeSec + 0.01);
    updateActiveLyricLine(idx);
  }

  /* ==========================================================================
   * 4. 트랙 변경 감지 및 5대 멀티 소스 파이프라인 실행
   * ========================================================================== */

  function bindVideoElement(video) {
    if (!video || STATE.videoElement === video) return;
    STATE.videoElement = video;

    const updatePlayState = () => {
      STATE.isVideoPaused = video.paused;
      document.body.classList.toggle('ytm-al-is-paused', video.paused);
      document.body.classList.toggle('ytm-al-is-playing', !video.paused);
      updatePlayPauseButtonIcon(video.paused);
    };

    video.addEventListener('play', updatePlayState);
    video.addEventListener('playing', () => {
      updatePlayState();
      updateProgressBarUI(video);
      handleDOMMutation();
    });
    video.addEventListener('pause', updatePlayState);
    updatePlayState();

    if (UI.volumeSlider) {
      UI.volumeSlider.value = video.muted ? '0' : String(Math.round(video.volume * 100));
    }

    video.addEventListener('timeupdate', () => {
      if (!STATE.isScrubbing) {
        updateProgressBarUI(video);
      }
    });

    video.addEventListener('seeked', () => {
      updateProgressBarUI(video);
      if (STATE.lyricsStatus === 'synced') {
        const { cur } = getEffectivePlaybackState(video);
        const effectiveTime = cur + STATE.offsetSec + 0.06;
        const idx = findActiveLineIndexBinarySearch(STATE.lyricsLines, effectiveTime);
        updateActiveLyricLine(idx);
      }
    });

    video.addEventListener('loadeddata', () => {
      updateProgressBarUI(video);
      handleDOMMutation();
    });

    video.addEventListener('loadedmetadata', () => {
      updateProgressBarUI(video);
      handleDOMMutation();
    });

    video.addEventListener('durationchange', () => {
      updateProgressBarUI(video);
      handleDOMMutation();
    });

    video.addEventListener('ended', () => {
      setTimeout(() => handleDOMMutation(), 120);
      setTimeout(() => handleDOMMutation(), 450);
    });
  }

  function handleDOMMutation() {
    ensureUIInjected();

    const extracted = extractTrackMetadata();
    if (!extracted) return;

    if (extracted.isAd) {
      if (!STATE.isAdPlaying) {
        STATE.isAdPlaying = true;
        STATE.currentTrackKey = '__AD_PLAYING__';
        STATE.lyricsStatus = 'ad';
        STATE.lyricsLines = [];
        renderLyricsView();
      }
      return;
    }

    STATE.isAdPlaying = false;

    const newTrackKey = `${extracted.rawTitle}:::${extracted.rawArtist}`;

    if (newTrackKey === STATE.currentTrackKey) {
      if (extracted.coverUrl && STATE.meta.coverUrl !== extracted.coverUrl) {
        STATE.meta.coverUrl = extracted.coverUrl;
        updatePlayerPageVisuals();
      }

      let videoIdJustResolved = false;
      let durationJustResolved = false;

      if (extracted.videoId && STATE.meta.videoId !== extracted.videoId) {
        STATE.meta.videoId = extracted.videoId;
        videoIdJustResolved = true;
      }
      if (extracted.duration > 0 && Math.abs(STATE.meta.duration - extracted.duration) > 2) {
        STATE.meta.duration = extracted.duration;
        durationJustResolved = true;
        updateProgressBarUI(getActiveVideoElement());
      }

      // 1) 자동재생 직후 videoId가 뒤늦게 갱신되었는데, 이전 검색이 다른 videoId로 수행되었거나 아직 싱크 가사를 못 찾은 경우 즉시 재요청!
      if (
        videoIdJustResolved &&
        STATE.fetchedWithVideoId !== extracted.videoId &&
        (STATE.lyricsStatus !== 'synced' ||
          (STATE.fetchedWithVideoId && STATE.currentSourceStage === 'ytm_timed_lyrics'))
      ) {
        STATE.meta.lyricsBrowseId = '';
        requestMultiSourceLyrics(STATE.meta, { forceRefresh: true });
        return;
      }

      // 2) 이전 요청 시점에 videoId나 duration이 아직 로드되지 않아 일반 가사(plain)나 not_found로 빠졌다면 즉시 재검색!
      if (
        (videoIdJustResolved || durationJustResolved) &&
        STATE.lyricsStatus !== 'synced' &&
        STATE.lyricsStatus !== 'loading'
      ) {
        requestMultiSourceLyrics(STATE.meta);
        return;
      }

      if (STATE.lyricsStatus === 'not_found') {
        const nativeText = extractNativeYtmLyrics();
        if (nativeText) {
          STATE.plainLyricsText = nativeText;
          STATE.lyricsStatus = 'plain';
          STATE.lyricsSourceLabel = 'YouTube Music 가사';
          renderLyricsView();
        }
      }
      return;
    }

    // === 새로운 곡으로 전환됨 (수동 선택 또는 자동재생 전환) ===
    const currentDomNative = document.querySelector(
      'ytmusic-player-page #side-panel ytmusic-description-shelf-renderer .description'
    );
    STATE.prevTrackNativeLyrics = currentDomNative
      ? (currentDomNative.innerText || currentDomNative.textContent || '').trim()
      : '';

    if (STATE.meta && STATE.meta.videoId) {
      STATE.lastTrackVideoId = STATE.meta.videoId;
    }
    if (STATE.meta && STATE.meta.duration > 0) {
      STATE.lastTrackDuration = STATE.meta.duration;
    }
    STATE.trackTransitionTime = performance.now();
    STATE.isScrubbing = false;

    // 만약 방금 추출된 videoId가 이전 곡의 videoId와 동일하다면(자동재생 전환 직후 DOM 미갱신 상태) 비워둠
    const safeInitialVideoId =
      extracted.videoId && extracted.videoId !== STATE.lastTrackVideoId ? extracted.videoId : '';

    STATE.currentTrackKey = newTrackKey;
    STATE.preferredProviderKey = 'auto';
    STATE.currentSourceStage = '';
    STATE.fetchedWithVideoId = safeInitialVideoId;
    STATE.fetchedWithDuration = extracted.duration;

    STATE.meta = {
      videoId: safeInitialVideoId,
      rawTitle: extracted.rawTitle,
      cleanTitle: extracted.cleanTitle,
      rawArtist: extracted.rawArtist,
      cleanArtist: extracted.cleanArtist,
      album: extracted.album,
      coverUrl: extracted.coverUrl,
      duration: extracted.duration,
      lyricsBrowseId: '',
      enTitle: '',
      enArtist: ''
    };

    STATE.offsetSec = STATE.trackOffsets[newTrackKey] || 0.0;

    // 프로그레스 바 즉시 0:00 (0%)으로 리셋 및 새 곡 길이 반영
    if (UI.scrubberFill) UI.scrubberFill.style.width = '0%';
    if (UI.timeCurrentEl) UI.timeCurrentEl.textContent = '0:00';
    if (UI.timeRemainingEl) {
      UI.timeRemainingEl.textContent = `-${formatSecondsToLabel(extracted.duration || 0)}`;
    }
    updateProgressBarUI(getActiveVideoElement());

    updatePlayerPageVisuals();
    requestMultiSourceLyrics(STATE.meta);
  }

  /**
   * 영구 저장된 가사 목록 동기화 및 앨범 표지 우측 상단 음표(♪) 배지 렌더링 엔진
   * - 사용자 요청: 가사가 저장된 곡은 플레이어를 제외한 곳에서 앨범 표지 오른쪽 위에 작게 음표 모양 표시
   * - 확장프로그램 설정창(popup)에서 가사 저장 기능을 켜고 끌 수 있도록 실시간 연동
   */
  const STORAGE_KEY_SAVED = 'ytm_liked_saved_lyrics_cache_v2';
  const SETTINGS_KEY_SAVED = 'ytm_lyrics_settings_v1';

  const SAVED_LYRICS_STATE = {
    enabled: true,
    canonicalKeys: new Set(),
    videoIds: new Set(),
    normTitlesWithArtist: new Map()
  };

  function normalizeForSavedKey(str = '') {
    return String(str)
      .replace(/[\(\[\{【『（][^)\]}】』）]*[\)\]\}】』）]/g, ' ')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .trim();
  }

  function applySavedStorageSnapshot(storedObj, settingsObj) {
    if (settingsObj && typeof settingsObj.enablePersistentCache === 'boolean') {
      SAVED_LYRICS_STATE.enabled = settingsObj.enablePersistentCache;
    }

    SAVED_LYRICS_STATE.canonicalKeys.clear();
    SAVED_LYRICS_STATE.videoIds.clear();
    SAVED_LYRICS_STATE.normTitlesWithArtist.clear();

    if (storedObj && typeof storedObj === 'object') {
      for (const [key, val] of Object.entries(storedObj)) {
        if (!val || val.status !== 'synced') continue;
        SAVED_LYRICS_STATE.canonicalKeys.add(key);

        if (val.videoId) {
          SAVED_LYRICS_STATE.videoIds.add(String(val.videoId).trim());
        }

        const tRaw = val.cleanTitle || val.rawTitle || val.trackName || key.split('::')[0] || '';
        const aRaw = val.cleanArtist || val.rawArtist || val.artistName || key.split('::')[1] || '';
        const normT = normalizeForSavedKey(sanitizeTrackTitle(tRaw));
        const normA = normalizeForSavedKey(sanitizeArtistName(aRaw));

        if (normT && normA) {
          SAVED_LYRICS_STATE.canonicalKeys.add(`${normT}::${normA}`);
        }
        if (normT) {
          if (!SAVED_LYRICS_STATE.normTitlesWithArtist.has(normT)) {
            SAVED_LYRICS_STATE.normTitlesWithArtist.set(normT, new Set());
          }
          if (normA) {
            SAVED_LYRICS_STATE.normTitlesWithArtist.get(normT).add(normA);
          }
        }
      }
    }

    scheduleSavedBadgesUpdate();
  }

  function initSavedLyricsStorageSync() {
    try {
      if (!chrome.storage || !chrome.storage.local) return;

      chrome.storage.local.get([STORAGE_KEY_SAVED, SETTINGS_KEY_SAVED], (res) => {
        applySavedStorageSnapshot(
          res ? res[STORAGE_KEY_SAVED] : null,
          res ? res[SETTINGS_KEY_SAVED] : null
        );
      });

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        if (changes[STORAGE_KEY_SAVED] || changes[SETTINGS_KEY_SAVED]) {
          chrome.storage.local.get([STORAGE_KEY_SAVED, SETTINGS_KEY_SAVED], (res) => {
            applySavedStorageSnapshot(
              res ? res[STORAGE_KEY_SAVED] : null,
              res ? res[SETTINGS_KEY_SAVED] : null
            );
          });
        }
      });
    } catch (e) {}
  }

  function isTrackInSavedCache(videoId, rawTitle, rawArtist) {
    if (!SAVED_LYRICS_STATE.enabled) return false;
    if (videoId && SAVED_LYRICS_STATE.videoIds.has(videoId)) {
      return true;
    }

    if (!rawTitle) return false;
    const normT = normalizeForSavedKey(sanitizeTrackTitle(rawTitle));
    if (!normT) return false;

    const cleanA = sanitizeArtistName(rawArtist || '');
    const normA = normalizeForSavedKey(cleanA);

    if (normA && SAVED_LYRICS_STATE.canonicalKeys.has(`${normT}::${normA}`)) {
      return true;
    }

    const savedArtistsForTitle = SAVED_LYRICS_STATE.normTitlesWithArtist.get(normT);
    if (savedArtistsForTitle && normA) {
      for (const savedA of savedArtistsForTitle) {
        if (savedA && (normA.includes(savedA) || savedA.includes(normA))) {
          return true;
        }
      }
    }

    return false;
  }

  function createSavedNoteBadgeEl() {
    const noteSvg = createSvgIcon(10, [
      {
        tag: 'path',
        attrs: {
          d: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
          fill: 'currentColor',
          stroke: 'none'
        }
      }
    ]);
    return createEl(
      'span',
      {
        className: 'ytm-al-saved-note-badge',
        attrs: {
          title: '저장된 실시간 가사 있음',
          'aria-label': '저장된 실시간 가사 있음'
        }
      },
      [noteSvg]
    );
  }

  let badgeUpdateTimer = null;
  function scheduleSavedBadgesUpdate() {
    if (badgeUpdateTimer) clearTimeout(badgeUpdateTimer);
    badgeUpdateTimer = setTimeout(() => {
      updateSavedLyricsBadgesOnPage(document);
    }, 120);
  }

  /**
   * 플레이어(메인 대형 앨범 아트 및 하단 재생바)를 제외한 모든 곡 목록/대기열/보관함/홈 카드의
   * 앨범 표지 우측 상단에 작은 음표(♪) 배지 표시 및 갱신
   */
  function updateSavedLyricsBadgesOnPage(rootEl = document) {
    if (!SAVED_LYRICS_STATE.enabled || (SAVED_LYRICS_STATE.canonicalKeys.size === 0 && SAVED_LYRICS_STATE.videoIds.size === 0)) {
      document.querySelectorAll('.ytm-al-saved-note-badge').forEach((el) => el.remove());
      return;
    }

    const candidates = rootEl.querySelectorAll(
      'ytmusic-responsive-list-item-renderer, ytmusic-player-queue-item, ytmusic-two-row-item-renderer, ytmusic-list-item-renderer, .ytm-am-queue-item'
    );

    candidates.forEach((item) => {
      // 메인 플레이어(ytmusic-player), 하단 재생바(ytmusic-player-bar), Apple Music 전체화면 좌측 앨범 아트는 제외!
      if (
        item.closest('ytmusic-player, ytmusic-player-bar, .ytm-am-left-col')
      ) {
        return;
      }

      let videoId = '';
      let rawTitle = '';
      let rawArtist = '';
      let thumbHost = null;

      const watchLink = item.querySelector('a[href*="watch?v="]');
      if (watchLink) {
        const href = watchLink.getAttribute('href') || '';
        const vMatch = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (vMatch) videoId = vMatch[1];
      }

      if (item.classList.contains('ytm-am-queue-item')) {
        const tEl = item.querySelector('.ytm-am-queue-title');
        const aEl = item.querySelector('.ytm-am-queue-artist');
        rawTitle = tEl ? tEl.textContent.trim() : '';
        rawArtist = aEl ? aEl.textContent.trim() : '';
        thumbHost = item.querySelector('.ytm-am-queue-thumb-wrap');
      } else if (item.tagName.toLowerCase() === 'ytmusic-player-queue-item') {
        const tEl = item.querySelector('.song-title');
        const aEl = item.querySelector('.byline');
        rawTitle = tEl ? tEl.textContent.trim() : '';
        rawArtist = aEl ? aEl.textContent.trim() : '';
        thumbHost = item.querySelector('ytmusic-thumbnail-renderer, .left-items');
      } else if (item.tagName.toLowerCase() === 'ytmusic-two-row-item-renderer') {
        const tEl = item.querySelector('.title');
        const aEl = item.querySelector('.subtitle');
        rawTitle = tEl ? tEl.textContent.trim() : '';
        rawArtist = aEl ? aEl.textContent.trim() : '';
        thumbHost = item.querySelector('a.image-wrapper, ytmusic-thumbnail-renderer');
      } else {
        // ytmusic-responsive-list-item-renderer / ytmusic-list-item-renderer
        const tEl = item.querySelector(
          '.title-column yt-formatted-string, .title-column a, .title'
        );
        const aEl = item.querySelector(
          '.secondary-flex-columns yt-formatted-string, .subtitle'
        );
        rawTitle = tEl ? tEl.textContent.trim() : '';
        rawArtist = aEl ? aEl.textContent.trim() : '';
        thumbHost = item.querySelector(
          'ytmusic-thumbnail-renderer, .thumbnail-container, .left-items'
        );
      }

      if (!thumbHost) return;

      const matched = isTrackInSavedCache(videoId, rawTitle, rawArtist);
      const existingBadge = thumbHost.querySelector(':scope > .ytm-al-saved-note-badge');

      if (matched) {
        thumbHost.classList.add('ytm-al-saved-thumb-host');
        if (!existingBadge) {
          thumbHost.appendChild(createSavedNoteBadgeEl());
        }
      } else if (existingBadge) {
        existingBadge.remove();
      }
    });
  }

  /**
   * 현재 재생 중인 곡이 '좋아요(Liked)' 표시된 곡이거나 '저장목록/보관함(Saved/Library)' 곡인지 판별
   * (사용자 요청: 영구 로컬 캐싱은 좋아요 및 저장목록 곡에 한해서만 수행)
   */
  function isLikedOrSavedTrack() {
    if (!SAVED_LYRICS_STATE.enabled) return false;

    // 1. 하단 재생바의 좋아요 버튼 상태 확인 (like-status="LIKE" 또는 aria-pressed="true")
    const likeRenderer = document.querySelector(
      'ytmusic-player-bar ytmusic-like-button-renderer'
    );
    if (likeRenderer) {
      if (likeRenderer.getAttribute('like-status') === 'LIKE') {
        return true;
      }
      const likeBtn = likeRenderer.querySelector(
        '#button-shape-like button[aria-pressed="true"], tp-yt-paper-icon-button.like[aria-pressed="true"]'
      );
      if (likeBtn) return true;
    }

    // 2. 보관함(Library)에 저장됨 상태 버튼 확인
    const savedBtn = document.querySelector(
      'ytmusic-player-bar [aria-label*="보관함에서 삭제"], ytmusic-player-bar [aria-label*="라이브러리에서 삭제"], ytmusic-player-bar [aria-label*="Remove from library"], ytmusic-menu-popup-renderer [aria-label*="보관함에서 삭제"]'
    );
    if (savedBtn) return true;

    // 3. 현재 재생 컨텍스트가 '좋아요 표시한 음악(LM)' 또는 '보관함(FEmusic_library / FEmusic_liked)'인 경우
    const url = window.location.href || '';
    if (
      url.includes('list=LM') ||
      url.includes('list=SE') ||
      url.includes('FEmusic_liked') ||
      url.includes('FEmusic_library')
    ) {
      return true;
    }

    return false;
  }

  /**
   * 사용자가 '좋아요' 또는 '보관함/재생목록에 저장'을 눌렀을 때 현재 곡 가사를 영구 로컬 캐시에 즉시 저장 요청
   */
  function notifyPersistCurrentTrackLyrics() {
    if (!STATE.meta || !STATE.meta.rawTitle) return;
    chrome.runtime.sendMessage(
      {
        type: 'PERSIST_LYRICS_TO_STORAGE',
        payload: { meta: STATE.meta }
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }

  /**
   * [방안 3] 현재 재생목록(Up Next)에서 다음에 재생될 1~2곡의 가사를 백그라운드에서 미리 프리페칭(Pre-fetching)
   */
  let prefetchTimer = null;
  const prefetchedTrackKeys = new Set();

  function scheduleUpcomingQueuePrefetch() {
    if (prefetchTimer) clearTimeout(prefetchTimer);

    prefetchTimer = setTimeout(() => {
      const queueItems = Array.from(document.querySelectorAll('ytmusic-player-queue-item'));
      if (queueItems.length === 0) return;

      const currentIdx = queueItems.findIndex(
        (item) =>
          item.hasAttribute('selected') || item.getAttribute('play-button-state') === 'playing'
      );
      if (currentIdx === -1) return;

      // 다음 1~2곡 및 이전 1곡을 대상 후보로 추출
      const targetIndices = [currentIdx + 1, currentIdx + 2, currentIdx - 1].filter(
        (idx) => idx >= 0 && idx < queueItems.length
      );

      const persistContext = isLikedOrSavedTrack();

      targetIndices.forEach((idx, order) => {
        const item = queueItems[idx];
        const titleEl = item.querySelector('.song-title');
        const bylineEl = item.querySelector('.byline');
        const durationEl = item.querySelector('.duration');

        const rawTitle = titleEl ? titleEl.textContent.trim() : '';
        const rawArtist = bylineEl ? bylineEl.textContent.trim() : '';
        const durLabel = durationEl ? durationEl.textContent.trim() : '';

        if (!rawTitle) return;

        const cleanTitle = sanitizeTrackTitle(rawTitle);
        const cleanArtist = sanitizeArtistName(rawArtist);
        const duration = parseTimeLabelToSeconds(durLabel);
        const key = `${cleanTitle}:::${cleanArtist}`;

        if (prefetchedTrackKeys.has(key)) return;
        prefetchedTrackKeys.add(key);

        setTimeout(() => {
          chrome.runtime.sendMessage(
            {
              type: 'PREFETCH_LYRICS',
              payload: {
                rawTitle,
                cleanTitle,
                rawArtist,
                cleanArtist,
                duration,
                persistToStorage: persistContext
              }
            },
            () => {
              void chrome.runtime.lastError;
            }
          );
        }, order * 350);
      });
    }, 900);
  }

  /**
   * 초고속 가사 검색:
   * 1) 대기 없이 즉시(25ms) 백그라운드 6대 소스 최선착순 레이싱(Promise.any) 출발!
   *    (영구 캐시나 프리페칭에 있으면 0.01초, 외부 LRC 서버 히트 시 0.2~0.4초 내 즉시 렌더링)
   * 2) 동시에 병렬로 YTM 동일 출처 메타데이터(lyricsBrowseId, 영문 제목 enTitle)를 조회하여,
   *    1차 레이싱에서 못 찾은 경우에만 2차 보강 검색 수행!
   */
  function requestMultiSourceLyrics(meta, options = {}) {
    const currentSeq = ++STATE.requestSeq;
    const preferredSource = options.preferredSource || 'auto';
    const forceRefresh = Boolean(options.forceRefresh);

    if (STATE.retryTimer) {
      clearTimeout(STATE.retryTimer);
      STATE.retryTimer = null;
    }
    if (STATE.nativeLyricsPollTimer) {
      clearTimeout(STATE.nativeLyricsPollTimer);
      STATE.nativeLyricsPollTimer = null;
    }

    STATE.lyricsStatus = 'loading';
    STATE.lyricsLines = [];
    STATE.plainLyricsText = '';
    STATE.lyricsSourceLabel = '검색 중';
    renderLyricsView();

    const applySyncedResult = (result) => {
      if (!result || result.status !== 'synced' || !result.syncedLyrics) return false;
      const parsed = parseLRC(result.syncedLyrics);
      if (parsed.length === 0) return false;

      STATE.lyricsLines = parsed;
      STATE.lyricsStatus = 'synced';
      STATE.currentSourceStage = result.sourceStage || '';
      const stageMap = {
        ytm_timed_lyrics: '실시간 싱크 (YTM 공식)',
        alsong_lrc: '실시간 싱크 (알송)',
        netease_lrc: '실시간 싱크 (NetEase)',
        qq_lrc: '실시간 싱크 (QQ Music)',
        lrclib_structured: '실시간 싱크 (LRCLIB)',
        lrclib_query: '실시간 싱크 (LRCLIB)'
      };
      const baseLabel = stageMap[result.sourceStage] || '실시간 싱크';
      STATE.lyricsSourceLabel = result.fromPersistent ? `${baseLabel} ⚡` : baseLabel;
      renderLyricsView();
      scheduleUpcomingQueuePrefetch();
      return true;
    };

    const sendFetchToBg = (payloadObj) =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'FETCH_LYRICS',
            payload: payloadObj
          },
          (response) => {
            if (chrome.runtime.lastError || !response || !response.ok) {
              resolve(null);
            } else {
              resolve(response.data);
            }
          }
        );
      });

    STATE.retryTimer = setTimeout(async () => {
      if (currentSeq !== STATE.requestSeq) return;

      const latest = extractTrackMetadata();
      const payload = latest && !latest.isAd ? latest : meta;
      const persistToStorage = isLikedOrSavedTrack();
      const safeVid =
        payload.videoId && payload.videoId !== STATE.lastTrackVideoId
          ? payload.videoId
          : STATE.meta.videoId && STATE.meta.videoId !== STATE.lastTrackVideoId
            ? STATE.meta.videoId
            : '';

      STATE.meta = {
        ...STATE.meta,
        ...payload,
        videoId: safeVid,
        persistToStorage,
        preferredSource,
        forceRefresh
      };
      STATE.fetchedWithVideoId = STATE.meta.videoId || '';
      STATE.fetchedWithDuration = STATE.meta.duration || 0;

      if (UI.favBtn) {
        UI.favBtn.classList.toggle('is-active', persistToStorage);
      }
      updatePlayerPageVisuals();

      // 사용자가 우클릭으로 특정 제공자(예: YTM 공식)를 지정했는데 아직 browseId/enTitle이 없다면 먼저 확보
      if (
        preferredSource !== 'auto' &&
        (!STATE.meta.lyricsBrowseId || !STATE.meta.enTitle)
      ) {
        const ytmMetaPre = await fetchYtmWebRemixMetadata(STATE.meta.videoId, STATE.meta);
        if (currentSeq !== STATE.requestSeq) return;
        if (ytmMetaPre.resolvedVideoId && !STATE.meta.videoId) {
          STATE.meta.videoId = ytmMetaPre.resolvedVideoId;
          STATE.fetchedWithVideoId = ytmMetaPre.resolvedVideoId;
        }
        if (ytmMetaPre.lyricsBrowseId) {
          STATE.meta.lyricsBrowseId = ytmMetaPre.lyricsBrowseId;
        }
        if (ytmMetaPre.enTitle) {
          STATE.meta.enTitle = ytmMetaPre.enTitle;
        }
        if (ytmMetaPre.enArtist) {
          STATE.meta.enArtist = ytmMetaPre.enArtist;
        }
      }

      // [트랙 1] 기다리지 않고 즉시 백그라운드 레이싱(또는 지정 제공자 검색) 출발!
      const fastBgPromise = sendFetchToBg(STATE.meta);

      // [트랙 2] 동시에 YTM 동일 출처 API에서 가사 browseId(MPLYt_...)와 영문 제목(enTitle) 조회
      const ytmMetaPromise =
        preferredSource === 'auto'
          ? fetchYtmWebRemixMetadata(STATE.meta.videoId, STATE.meta)
          : Promise.resolve({});

      const fastResult = await fastBgPromise;
      if (currentSeq !== STATE.requestSeq) return;

      // 1차 고속 레이싱에서 실시간 싱크 가사를 찾았다면(0.01초~0.4초) 즉시 화면에 렌더링하고 종료!
      if (applySyncedResult(fastResult)) {
        return;
      }

      // 사용자가 특정 제공자를 수동 선택한 경우 다른 제공자로 폴백하지 않고 해당 제공자의 결과만 반영
      if (preferredSource !== 'auto') {
        if (fastResult && fastResult.plainLyrics) {
          STATE.plainLyricsText = fastResult.plainLyrics;
          STATE.lyricsStatus = 'plain';
          STATE.currentSourceStage = fastResult.sourceStage || preferredSource;
          STATE.lyricsSourceLabel = `일반 가사 (${preferredSource.toUpperCase()})`;
        } else {
          STATE.lyricsStatus = 'not_found';
          STATE.currentSourceStage = 'none';
          STATE.lyricsSourceLabel = '선택한 제공자에 가사 없음';
        }
        renderLyricsView();
        return;
      }

      // 만약 1차에서 못 찾았다면(예: 한글 제목만 있어서 영문 제목이나 YTM MPLYt_가 필요한 곡),
      // 병렬로 받아온 ytmMeta(lyricsBrowseId, enTitle, enArtist)로 즉시 2차 검색!
      const ytmMeta = await ytmMetaPromise;
      if (currentSeq !== STATE.requestSeq) return;

      let hasNewYtmMeta = false;
      if (ytmMeta.resolvedVideoId && !STATE.meta.videoId) {
        STATE.meta.videoId = ytmMeta.resolvedVideoId;
        STATE.fetchedWithVideoId = ytmMeta.resolvedVideoId;
        hasNewYtmMeta = true;
      }
      if (ytmMeta.lyricsBrowseId && STATE.meta.lyricsBrowseId !== ytmMeta.lyricsBrowseId) {
        STATE.meta.lyricsBrowseId = ytmMeta.lyricsBrowseId;
        hasNewYtmMeta = true;
      }
      if (ytmMeta.enTitle && ytmMeta.enTitle !== STATE.meta.cleanTitle) {
        STATE.meta.enTitle = ytmMeta.enTitle;
        hasNewYtmMeta = true;
      }
      if (ytmMeta.enArtist && ytmMeta.enArtist !== STATE.meta.cleanArtist) {
        STATE.meta.enArtist = ytmMeta.enArtist;
        hasNewYtmMeta = true;
      }

      let secondResult = null;
      if (hasNewYtmMeta) {
        secondResult = await sendFetchToBg({
          ...STATE.meta,
          persistToStorage: isLikedOrSavedTrack()
        });
        if (currentSeq !== STATE.requestSeq) return;
        if (applySyncedResult(secondResult)) {
          return;
        }
      }

      const finalBgResult = secondResult || fastResult;

      // 외부 API에서 일반 가사(plainLyrics)라도 찾은 경우
      if (
        finalBgResult &&
        (finalBgResult.status === 'plain' || finalBgResult.plainLyrics) &&
        finalBgResult.plainLyrics
      ) {
        STATE.plainLyricsText = finalBgResult.plainLyrics;
        STATE.lyricsStatus = 'plain';
        STATE.lyricsSourceLabel = '일반 가사';
        renderLyricsView();
        scheduleUpcomingQueuePrefetch();
        return;
      }

      if (finalBgResult && finalBgResult.status === 'instrumental') {
        STATE.lyricsStatus = 'instrumental';
        STATE.lyricsSourceLabel = 'Instrumental';
        renderLyricsView();
        scheduleUpcomingQueuePrefetch();
        return;
      }

      // 최후 폴백: YouTube Music 기본 가사 탭 DOM에서 추출
      const nativeText = extractNativeYtmLyrics();
      if (nativeText) {
        STATE.plainLyricsText = nativeText;
        STATE.lyricsStatus = 'plain';
        STATE.lyricsSourceLabel = 'YouTube Music 가사';
        renderLyricsView();
        scheduleUpcomingQueuePrefetch();
        return;
      }

      STATE.lyricsStatus = 'not_found';
      STATE.lyricsSourceLabel = '가사 없음';
      renderLyricsView();
      scheduleUpcomingQueuePrefetch();

      STATE.nativeLyricsPollTimer = setTimeout(() => {
        if (currentSeq !== STATE.requestSeq || STATE.lyricsStatus !== 'not_found') return;
        const delayedNativeText = extractNativeYtmLyrics();
        if (delayedNativeText) {
          STATE.plainLyricsText = delayedNativeText;
          STATE.lyricsStatus = 'plain';
          STATE.lyricsSourceLabel = 'YouTube Music 가사';
          renderLyricsView();
        }
      }, 700);
    }, 25);
  }

  /**
   * 전역 이벤트 리스너:
   * 1) 앨범 위 기존 전체화면 버튼(<path d="M7 3H1v6...">) 클릭 시 캡처 단계에서 가로채어 Apple Music 전체화면 실행
   * 2) 좋아요(Like) 및 보관함/재생목록에 저장 버튼 클릭 시 현재 곡 가사를 영구 로컬 캐시(chrome.storage.local)에 저장
   * 3) 브라우저 fullscreenchange 및 ESC 키 연동
   */
  function initGlobalFullscreenInterceptors() {
    window.addEventListener(
      'click',
      (e) => {
        const path = e.composedPath ? e.composedPath() : [e.target];
        for (const node of path) {
          const matchedBtn = isNativeFullscreenButtonNode(node);
          if (matchedBtn) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (STATE.isAppleFullscreen) {
              closeAppleFullscreen(true);
            } else {
              openAppleFullscreen(true);
            }
            return;
          }

          // 사용자가 YTM의 좋아요(Like) 버튼이나 '보관함에 저장 / 재생목록에 저장' 메뉴를 클릭했을 때 감지하여 영구 캐시에 승격
          if (node instanceof Element) {
            if (
              node.matches?.(
                'ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like, ytmusic-player-bar .like, ytmusic-menu-service-item-renderer, tp-yt-paper-item'
              )
            ) {
              const txt = `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`;
              if (
                node.closest('ytmusic-like-button-renderer') ||
                /좋아요|보관함에\s*저장|재생목록에\s*저장|재생목록에\s*추가|Save\s*to\s*library|Save\s*to\s*playlist|Add\s*to\s*playlist/i.test(
                  txt
                )
              ) {
                setTimeout(() => {
                  notifyPersistCurrentTrackLyrics();
                  if (UI.favBtn && isLikedOrSavedTrack()) {
                    UI.favBtn.classList.add('is-active');
                  }
                }, 250);
              }
            }
          }
        }
      },
      true
    );

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        // 만약 YTM 기본 단축키('f') 등으로 전체화면에 진입한 경우에도 Apple Music 전체화면 플레이어 표시!
        if (!STATE.isAppleFullscreen) {
          openAppleFullscreen(false);
        } else if (UI.amOverlay) {
          const fsHost =
            document.fullscreenElement !== document.documentElement
              ? document.fullscreenElement
              : document.body;
          if (UI.amOverlay.parentElement !== fsHost) {
            fsHost.appendChild(UI.amOverlay);
          }
        }
      } else if (STATE.isAppleFullscreen) {
        // ESC 등을 눌러 브라우저 전체화면이 해제되면 Apple Music 전체화면도 함께 닫기
        closeAppleFullscreen(false);
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && STATE.isAppleFullscreen) {
        closeAppleFullscreen(true);
      }
    });
  }

  function initObservers() {
    let debounceTimer = null;
    let lastRunAt = 0;

    const runMutationCheck = () => {
      debounceTimer = null;
      lastRunAt = performance.now();
      handleDOMMutation();
    };

    const debouncedCheck = (mutations) => {
      // 우리가 주입한 가사 컨테이너 내부의 50ms 클래스 토글(.is-active 등)로 인한 무한 디바운스 지연 방지
      if (Array.isArray(mutations) && mutations.length > 0) {
        const hasExternalMutation = mutations.some((m) => {
          const target = m.target instanceof Element ? m.target : m.target?.parentElement;
          if (!target) return true;
          if (
            target.closest(
              '#ytm-apple-lyrics-integrated, #ytm-apple-music-fullscreen, .ytm-al-page-backdrop, .ytm-al-saved-note-badge'
            )
          ) {
            return false;
          }
          return true;
        });
        if (!hasExternalMutation) return;
      }

      const now = performance.now();
      if (now - lastRunAt >= 140) {
        if (debounceTimer) clearTimeout(debounceTimer);
        runMutationCheck();
        return;
      }

      if (!debounceTimer) {
        debounceTimer = setTimeout(runMutationCheck, 100);
      }
    };

    const observer = new MutationObserver(debouncedCheck);

    const attachObservers = () => {
      const playerBar = document.querySelector('ytmusic-player-bar');
      if (!playerBar) return false;

      observer.observe(playerBar, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['src', 'title', 'is-advertisement']
      });

      const playerPage = document.querySelector('ytmusic-player-page');
      if (playerPage) {
        observer.observe(playerPage, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'disabled', 'aria-selected', 'player-page-open', 'src']
        });
      }

      const moviePlayer = document.querySelector('#movie_player');
      if (moviePlayer) {
        observer.observe(moviePlayer, {
          attributes: true,
          attributeFilter: ['class']
        });
      }

      // 홈, 보관함, 검색 결과, 재생목록 등 페이지 내 곡 목록 렌더링 감지 -> 앨범 표지 음표(♪) 배지 갱신
      const appLayout = document.querySelector('ytmusic-app-layout, ytmusic-app');
      if (appLayout) {
        const listObserver = new MutationObserver(() => {
          scheduleSavedBadgesUpdate();
        });
        listObserver.observe(appLayout, {
          childList: true,
          subtree: true
        });
      }

      handleDOMMutation();
      scheduleSavedBadgesUpdate();
      return true;
    };

    if (!attachObservers()) {
      const rootObserver = new MutationObserver(() => {
        if (attachObservers()) {
          rootObserver.disconnect();
        }
      });
      rootObserver.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('yt-navigate-finish', () => {
      debouncedCheck();
      scheduleSavedBadgesUpdate();
    });
  }

  function init() {
    document.body.classList.remove('ytm-am-fullscreen-active');
    initSavedLyricsStorageSync();
    initGlobalFullscreenInterceptors();
    ensureUIInjected();
    initObservers();
    if (!STATE.rafId) {
      STATE.rafId = requestAnimationFrame(syncLoop);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
