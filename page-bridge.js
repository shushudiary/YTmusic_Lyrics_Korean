/**
 * page-bridge.js (MAIN World Bridge)
 * YouTube Music의 내부 플레이어(#movie_player) API에서
 * 1) 현재 재생 중인 곡의 정확한 video_id, title, author
 * 2) MSE 연속 버퍼(Gapless Playback) 오프셋이 완벽히 보정된 트랙 기준 currentTime 및 duration
 * 3) 트랙 기준 정확한 seekTo() 탐색 명령
 * 을 추출·연동하여 content.js(ISOLATED World)와 안전하게 동기화합니다.
 */
(() => {
  'use strict';

  if (window.__YTM_AL_PAGE_BRIDGE_ACTIVE__) return;
  window.__YTM_AL_PAGE_BRIDGE_ACTIVE__ = true;

  function syncPlayerStateToDataset() {
    try {
      // document_start에서는 documentElement가 아직 없을 수 있다.
      const root = document.documentElement;
      if (!root) return;
      const clientVersion = window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION');
      if (typeof clientVersion === 'string') root.dataset.ytmAlClientVersion = clientVersion;
      const mp = document.getElementById('movie_player');
      if (!mp) {
        delete root.dataset.ytmAlTimeUpdatedAt;
        return;
      }

      if (typeof mp.getVideoData === 'function') {
        const data = mp.getVideoData();
        if (data && typeof data === 'object') {
          const vid = typeof data.video_id === 'string' ? data.video_id : '';
          const title = typeof data.title === 'string' ? data.title : '';
          const author = typeof data.author === 'string' ? data.author : '';

          if (root.dataset.ytmAlVideoId !== vid) {
            delete root.dataset.ytmAlCurrentTime;
            delete root.dataset.ytmAlDuration;
            delete root.dataset.ytmAlTimeUpdatedAt;
            root.dataset.ytmAlVideoId = vid;
          }
          if (root.dataset.ytmAlVideoTitle !== title) {
            root.dataset.ytmAlVideoTitle = title;
          }
          if (root.dataset.ytmAlVideoAuthor !== author) {
            root.dataset.ytmAlVideoAuthor = author;
          }
        }
      }

      if (typeof mp.getCurrentTime === 'function') {
        const cur = Number(mp.getCurrentTime());
        if (Number.isFinite(cur) && cur >= 0) {
          root.dataset.ytmAlCurrentTime = cur.toFixed(3);
          root.dataset.ytmAlTimeUpdatedAt = String(Date.now());
        }
      }

      if (typeof mp.getDuration === 'function') {
        const dur = Number(mp.getDuration());
        if (Number.isFinite(dur) && dur > 0) {
          root.dataset.ytmAlDuration = dur.toFixed(3);
        }
      }
    } catch (e) {}
  }

  window.addEventListener('ytm-al-bridge-cmd', (e) => {
    try {
      const detail = e && e.detail ? e.detail : null;
      if (!detail || !detail.action) return;

      const mp = document.getElementById('movie_player');
      if (!mp) return;

      if (detail.action === 'seekTo' && typeof mp.seekTo === 'function') {
        const targetSec = detail.timeSec;
        if (detail.videoId && mp.getVideoData?.()?.video_id !== detail.videoId) return;
        if (Number.isFinite(targetSec) && targetSec >= 0) {
          mp.seekTo(targetSec, true);
          // dispatchEvent는 동기식이다. 성공한 경우에만 fallback 탐색을 막는다.
          e.preventDefault();
          syncPlayerStateToDataset();
        }
      } else if (detail.action === 'syncNow') {
        syncPlayerStateToDataset();
      }
    } catch (err) {}
  });

  setInterval(syncPlayerStateToDataset, 80);
  syncPlayerStateToDataset();
})();
