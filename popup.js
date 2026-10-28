/**
 * popup.js
 * 확장 프로그램 설정창 컨트롤러:
 * - 가사 저장(영구 로컬 캐싱) 기능 ON/OFF 토글
 * - 현재 저장된 가사 곡 수 실시간 표시 및 캐시 비우기
 */

const STORAGE_KEY = 'ytm_liked_saved_lyrics_cache_v2';
const SETTINGS_KEY = 'ytm_lyrics_settings_v1';

document.addEventListener('DOMContentLoaded', () => {
  const toggleEl = document.getElementById('toggle-persistent-cache');
  const savedCountEl = document.getElementById('saved-count');
  const clearBtn = document.getElementById('clear-storage-btn');
  const statusMsgEl = document.getElementById('status-message');

  function refreshUI() {
    chrome.storage.local.get([STORAGE_KEY, SETTINGS_KEY], (res) => {
      const settings = (res && res[SETTINGS_KEY]) || { enablePersistentCache: true };
      const isEnabled = settings.enablePersistentCache !== false;
      toggleEl.checked = isEnabled;

      const storedCache = (res && res[STORAGE_KEY]) || {};
      const count = Object.keys(storedCache).length;
      savedCountEl.textContent = `${count}곡`;
    });
  }

  refreshUI();

  // 스위치 토글 시 즉시 설정 저장 및 백그라운드/컨텐츠 스크립트에 반영
  toggleEl.addEventListener('change', () => {
    const enablePersistentCache = toggleEl.checked;
    chrome.storage.local.set(
      {
        [SETTINGS_KEY]: {
          enablePersistentCache
        }
      },
      () => {
        statusMsgEl.textContent = enablePersistentCache
          ? '가사 자동 저장 및 음표(♪) 배지 표시가 켜졌습니다.'
          : '가사 자동 저장 기능이 꺼졌습니다.';
      }
    );
  });

  // 저장된 가사 비우기 버튼
  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_LYRICS_CACHE' }, () => {
      chrome.storage.local.remove([STORAGE_KEY], () => {
        refreshUI();
        statusMsgEl.textContent = '저장된 모든 가사 캐시가 초기화되었습니다.';
      });
    });
  });

  // 스토리지 변경 시 실시간 카운트 업데이트
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes[STORAGE_KEY] || changes[SETTINGS_KEY])) {
      refreshUI();
    }
  });
});
