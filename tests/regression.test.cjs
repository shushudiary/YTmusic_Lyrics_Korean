const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const lrc = '[00:10.000]Test alpha\n[00:20.000]Test beta\n[00:30.000]Test gamma';
const synced = sourceStage => ({ status: 'synced', syncedLyrics: lrc, sourceStage });
const response = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const timed = { contents: { timedLyricsModel: { lyricsData: { timedLyricsData: [
  { lyricLine: 'Test alpha', cueRange: { startTimeMilliseconds: '10500' } },
  { lyricLine: 'Test beta', cueRange: { startTimeMilliseconds: '20999' } }
] } } } };

function background(fetch = async () => response({})) {
  const context = vm.createContext({
    console, fetch, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout,
    chrome: { runtime: { onMessage: { addListener() {} } } }
  });
  vm.runInContext(read('background.js'), context);
  return context;
}
function content() {
  const window = new EventTarget();
  const timers = new Map();
  let nextTimer = 0;
  const video = { currentTime: 20, duration: 180, paused: false, play: async () => {} };
  const document = { documentElement: { dataset: {} }, getElementById: () => null };
  const context = vm.createContext({
    window, document, CustomEvent, console, performance, Date, AbortController,
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { context.tickBridge = fn; },
    chrome: { runtime: { sendMessage() {} } },
    video,
    metadata: {},
    nativeText: 'Native test text',
  });
  const injection = `
    globalThis.api = { STATE, seekToTrackTime, seekToLyricTime, getEffectivePlaybackState,
      switchLyricsProviderManual, requestMultiSourceLyrics, parseLRC, fetchYtmWebRemixMetadata };
    renderLyricsView = () => {};
    resumeAutoScroll = () => {};
    updateActiveLyricLine = (index) => { STATE.activeLineIndex = index; };
    extractTrackMetadata = () => ({ ...STATE.meta });
    getActiveVideoElement = () => video;
    readPlayerBarTimeState = () => ({ barCur: 20, barDur: 180, queueDur: 180 });
    isLikedOrSavedTrack = () => false;
    updatePlayerPageVisuals = () => {};
    scheduleUpcomingQueuePrefetch = () => {};
    fetchYtmWebRemixMetadata = async () => metadata;
    extractNativeYtmLyrics = () => nativeText;
  `;
  const source = read('content.js');
  vm.runInContext(source.slice(0, source.lastIndexOf("  if (document.readyState === 'loading')")) + injection + '\n})();', context);
  Object.assign(context.api.STATE, { currentTrackKey: 'sample', meta: {
    rawTitle: 'Sample', cleanTitle: 'Sample', rawArtist: 'Artist', cleanArtist: 'Artist',
    videoId: 'abcdefghijk', duration: 180
  } });
  return { context, api: context.api, video, window, document, timers,
    runRequest: () => {
      const id = context.api.STATE.retryTimer;
      const callback = timers.get(id);
      timers.delete(id);
      return callback();
    }
  };
}

for (const offset of [0, 180]) {
  test(`lyric seek executes once with synchronous player (media offset ${offset})`, () => {
    const h = content();
    h.video.currentTime = 20 + offset;
    let writes = 0;
    h.document.getElementById = () => ({
      getVideoData: () => ({ video_id: 'abcdefghijk', title: 'Sample' }),
      getCurrentTime: () => h.video.currentTime - offset,
      getDuration: () => 180,
      seekTo: seconds => { writes++; h.video.currentTime = seconds + offset; }
    });
    vm.runInContext(read('page-bridge.js'), h.context);
    h.api.STATE.offsetSec = 0.5;
    h.api.seekToLyricTime(60.5);
    assert.equal(h.video.currentTime, 60 + offset);
    assert.equal(writes, 1);
    assert.equal(h.api.getEffectivePlaybackState(h.video).cur, 60);
    h.api.seekToLyricTime(10.5);
    assert.equal(h.video.currentTime, 10 + offset);
    assert.equal(writes, 2);
  });
}

test('bridge accepts asynchronous seek once without a second media write', () => {
  const h = content();
  let target;
  h.document.getElementById = () => ({
    getVideoData: () => ({ video_id: 'abcdefghijk', title: 'Sample' }),
    getCurrentTime: () => h.video.currentTime,
    getDuration: () => 180,
    seekTo: seconds => { target = seconds; }
  });
  vm.runInContext(read('page-bridge.js'), h.context);
  h.api.seekToTrackTime(h.video, 60);
  assert.equal(target, 60);
  assert.equal(h.video.currentTime, 20);
  assert.ok(Math.abs(h.api.getEffectivePlaybackState(h.video).cur - 60) < 0.1);
});

test('missing bridge falls back to the media timeline, including repeated seeks', () => {
  const h = content(); h.video.currentTime = 200;
  h.api.seekToTrackTime(h.video, 60);
  assert.equal(h.video.currentTime, 240);
  h.api.seekToTrackTime(h.video, 10);
  assert.equal(h.video.currentTime, 190);
});

test('bridge recovers when documentElement is absent at document_start', () => {
  const h = content();
  const rootElement = h.document.documentElement;
  h.document.documentElement = null;
  h.document.getElementById = () => ({ getVideoData: () => ({ video_id: 'abcdefghijk' }), getCurrentTime: () => 12 });
  vm.runInContext(read('page-bridge.js'), h.context);
  h.document.documentElement = rootElement;
  h.context.tickBridge();
  assert.equal(rootElement.dataset.ytmAlVideoId, 'abcdefghijk');
  assert.equal(rootElement.dataset.ytmAlCurrentTime, '12.000');
});

for (const [provider, stage] of [['ytm','ytm_timed_lyrics'], ['alsong','alsong_lrc'], ['lrclib','lrclib_structured'], ['netease','netease_lrc'], ['qq','qq_lrc']]) {
  test(`switch to ${provider} renders timestamps and preserves provider on retry`, async () => {
    const h = content(); const requests = [];
    h.context.chrome.runtime.sendMessage = (message, callback) => {
      requests.push({ ...message.payload }); callback({ ok: true, data: synced(stage) });
    };
    h.api.switchLyricsProviderManual(provider);
    await h.runRequest();
    assert.equal(h.api.STATE.lyricsStatus, 'synced');
    assert.equal(h.api.STATE.currentSourceStage, stage);
    assert.ok(h.api.STATE.lyricsLines.some(line => line.time === 20));
    h.api.requestMultiSourceLyrics(h.api.STATE.meta, { forceRefresh: true });
    await h.runRequest();
    assert.deepEqual(requests.map(r => r.preferredSource), [provider, provider]);
  });
}

test('slow metadata does not block displaying the selected provider', async () => {
  const h = content(); let finish;
  h.context.metadata = new Promise(resolve => { finish = resolve; });
  h.context.chrome.runtime.sendMessage = (_, callback) => callback({ ok: true, data: synced('alsong_lrc') });
  h.api.switchLyricsProviderManual('alsong');
  const pending = h.runRequest();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.api.STATE.lyricsStatus, 'synced');
  finish({}); await pending;
});

test('manual lookup retries enriched metadata before accepting plain lyrics', async () => {
  const h = content(); const requests = [];
  h.context.metadata = { enTitle: 'Translated title', lyricsBrowseId: 'MPLYt_sample' };
  h.context.chrome.runtime.sendMessage = (message, callback) => {
    requests.push({ ...message.payload });
    callback({ ok: true, data: message.payload.enTitle ? synced('lrclib_structured') : { status: 'plain', plainLyrics: 'Sample plain' } });
  };
  h.api.switchLyricsProviderManual('lrclib'); await h.runRequest();
  assert.equal(h.api.STATE.lyricsStatus, 'synced');
  assert.deepEqual(requests.map(r => r.preferredSource), ['lrclib', 'lrclib']);
  assert.equal(requests[1].enTitle, 'Translated title');
});

test('selecting native lyrics invalidates an already running provider request', async () => {
  const h = content(); let reply;
  h.context.chrome.runtime.sendMessage = (_, callback) => { reply = callback; };
  h.api.switchLyricsProviderManual('lrclib'); const pending = h.runRequest();
  h.api.switchLyricsProviderManual('ytm_native');
  reply({ ok: true, data: synced('lrclib_structured') }); await pending;
  assert.equal(h.api.STATE.currentSourceStage, 'ytm_native');
  assert.equal(h.api.STATE.plainLyricsText, 'Native test text');
});

test('rapid provider changes discard late responses from the previous selection', async () => {
  const h = content(); const replies = [];
  h.context.chrome.runtime.sendMessage = (_, callback) => replies.push(callback);
  h.api.switchLyricsProviderManual('lrclib'); const first = h.runRequest();
  h.api.switchLyricsProviderManual('alsong'); const second = h.runRequest();
  replies[1]({ ok: true, data: synced('alsong_lrc') }); await second;
  replies[0]({ ok: true, data: synced('lrclib_structured') }); await first;
  assert.equal(h.api.STATE.currentSourceStage, 'alsong_lrc');
});

test('YTM parser preserves short timed lyrics and millisecond precision', () => {
  const bg = background(); const result = bg.extractYtmLyrics(timed);
  assert.equal(result.status, 'synced');
  assert.match(result.syncedLyrics, /\[00:10.500\]/);
  assert.match(result.syncedLyrics, /\[00:20.999\]/);
  assert.equal(bg.msToLrcTimestamp(59999.9), '[01:00.000]');
  const plain = bg.extractYtmLyrics({ timedLyricsData: [{ lyricLine: 'No timing provided' }] });
  assert.equal(plain.status, 'plain');
});

test('YTM uses an existing web browse ID for mobile timed lyrics before any next call', async () => {
  const calls = [];
  const bg = background(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response(timed); });
  const result = await bg.trySource1YtmTimedLyrics('abcdefghijk', 'MPLYt_web');
  assert.equal(result.status, 'synced'); assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/browse\?/);
  assert.equal(calls[0].body.browseId, 'MPLYt_web');
  assert.equal(calls[0].body.context.client.clientName, 'ANDROID_MUSIC');
});

test('YTM falls back from failed web next to mobile next and keeps visitor context', async () => {
  const calls = [];
  const bg = background(async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (body.context.client.clientName === 'WEB_REMIX') throw new Error('network failure');
    if (url.includes('/next?')) return response({ responseContext: { visitorData: 'test-visitor' }, tabs: [{ browseId: 'MPLYt_mobile' }] });
    assert.equal(body.context.client.visitorData, 'test-visitor'); return response(timed);
  });
  const result = await bg.trySource1YtmTimedLyrics('abcdefghijk');
  assert.equal(result.status, 'synced'); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.url.includes('/search')));
});

test('YTM reports a network failure separately from missing lyrics', async () => {
  const bg = background(async () => { throw new Error('offline'); });
  assert.equal((await bg.trySource1YtmTimedLyrics('abcdefghijk', 'MPLYt_web')).status, 'error');
});

test('translated title stays among primary queries even with bracket variants', () => {
  const bg = background();
  const variants = bg.generateTitleVariants('한국제목 (부제)', '한국제목 (부제)', 'English Title');
  assert.equal(variants[0], '한국제목'); assert.equal(variants[1], 'English Title');
});

test('LRCLIB title-only search can recover synced lyrics while artist filters remain enforced', async () => {
  const calls = [];
  const bg = background(async url => {
    const params = new URL(url).searchParams; calls.push(params);
    if (params.get('track_name') === 'Sample' && !params.has('artist_name')) return response([
      { id: 1, trackName: 'Sample', artistName: 'Wrong Artist', duration: 180, syncedLyrics: lrc },
      { id: 2, trackName: 'Sample', artistName: 'Artist', duration: 180, syncedLyrics: lrc }
    ]);
    return response([{ id: 3, trackName: 'Sample', artistName: 'Artist', duration: 180, plainLyrics: 'Test plain' }]);
  });
  const result = await bg.trySource6LrclibPipeline(['Sample'], ['Artist'], 180);
  assert.equal(result.status, 'synced'); assert.equal(result.artistName, 'Artist');
  assert.ok(calls.some(params => params.get('track_name') === 'Sample' && !params.has('artist_name')));
});

test('authenticated YTM lookup keeps the tab session and reuses the background parser', async () => {
  const h = content(); const calls = []; const bg = background();
  h.document.cookie = '';
  h.context.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(url.includes('/next?') ? {
      tabs: [{ browseId: 'MPLYt_session' }],
      playlistPanelVideoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'English Sample' }] } }
    } : timed);
  };
  h.context.chrome.runtime.sendMessage = async message => {
    assert.equal(message.type, 'PARSE_YTM_LYRICS');
    assert.deepEqual(Object.keys(message.payload).sort(), ['browseData', 'videoId']);
    return { ok: true, data: bg.extractYtmLyrics(message.payload.browseData) };
  };
  const result = await h.api.fetchYtmWebRemixMetadata('abcdefghijk', h.api.STATE.meta, true);
  assert.equal(result.timedLyricsResult.status, 'synced');
  assert.equal(result.enTitle, 'English Sample');
  const browse = calls.find(call => call.url.includes('/browse?'));
  assert.equal(browse.options.credentials, 'same-origin');
  assert.ok(!browse.url.includes('ytm_mobile'));
  assert.equal(JSON.parse(browse.options.body).context.client.clientName, 'ANDROID_MUSIC');
});

test('authenticated timed result can render before an unfinished anonymous request', async () => {
  const h = content();
  h.context.metadata = { timedLyricsResult: synced('ytm_timed_lyrics') };
  h.context.chrome.runtime.sendMessage = () => {};
  h.api.switchLyricsProviderManual('ytm'); await h.runRequest();
  assert.equal(h.api.STATE.lyricsStatus, 'synced');
  assert.equal(h.api.STATE.currentSourceStage, 'ytm_timed_lyrics');
});

test('stale lyric clicks cannot seek a newly started track', () => {
  const h = content();
  Object.assign(h.document.documentElement.dataset, { ytmAlVideoId: 'newvideo123', ytmAlTimeUpdatedAt: String(Date.now()) });
  assert.equal(h.api.seekToTrackTime(h.video, 60), false);
  assert.equal(h.video.currentTime, 20);
});

test('extension connection errors finish with a retry message', async () => {
  const h = content();
  h.context.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated'); };
  h.api.switchLyricsProviderManual('lrclib'); await h.runRequest();
  assert.equal(h.api.STATE.lyricsStatus, 'not_found');
  assert.match(h.api.STATE.lyricsSourceLabel, /연결하지 못했습니다/);
});
