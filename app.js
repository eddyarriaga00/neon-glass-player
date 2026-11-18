'use strict';
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('ngp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ngp.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ngp.' + k); } catch {} },
};
const audio = $('audio');
const app = document.querySelector('.app');
const root = document.documentElement;
const isPhone = () => matchMedia('(max-width: 880px)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

const state = {
  results: { apple: [], spotify: [], audius: [] },
  genre: store.get('genre', 0),
  query: '',
  list: [],          // what the track list currently shows
  queue: [],         // list the current track was started from
  index: -1,
  track: null,
  backend: 'audio',  // 'audio' | 'spotify'
  src: 'all',
  likes: store.get('likes', []),
  shuffle: store.get('shuffle', false),
  repeat: store.get('repeat', false),
  lyrics: null,      // { synced: [{t, text}] } | { plain: [..] }
  offset: null,      // seconds added to playback position to get lyric time (previews)
  lineIdx: -2,
  seeking: false,
  searchSeq: 0,
  playSeq: 0,
};

/* ---------- helpers ---------- */
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
// Views stack library < player < lyrics. On phones each step down is a history entry so the back button/gesture closes sheets.
const DEPTH = { library: 0, player: 1, lyrics: 2 };
let skipPop = 0;
function setView(v, fromPop) {
  const cur = app.dataset.view; if (v === cur) return;
  app.dataset.view = v;
  if (fromPop || !isPhone()) return;
  const d = DEPTH[v] - DEPTH[cur];
  if (d > 0) for (let i = 0; i < d; i++) history.pushState({ ngp: 1 }, '');
  else { skipPop++; history.go(d); }
}
window.addEventListener('popstate', () => {
  if (skipPop) { skipPop--; return; }
  const cur = app.dataset.view;
  if (cur !== 'library') setView(cur === 'lyrics' ? 'player' : 'library', true);
});
const fullLen = () => state.backend === 'spotify' || !!(state.track && state.track.full);
const SRC_LABEL = { apple: 'Apple Music', spotify: 'Spotify', audius: 'Audius · full song' };
const GENRES = [['Top', 0], ['Hip-Hop', 18], ['R&B', 15], ['Pop', 14], ['Latin', 12], ['Rock', 21], ['Alt', 20], ['Electronic', 7], ['Country', 6]];

/* ---------- search + trending ---------- */
async function searchApple(q) {
  const r = await fetch('https://itunes.apple.com/search?entity=song&limit=25&term=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('Apple search failed');
  const j = await r.json();
  return j.results.filter((x) => x.previewUrl).map((x) => ({
    id: 'a' + x.trackId, src: 'apple', title: x.trackName, artist: x.artistName, album: x.collectionName || '',
    art: x.artworkUrl100, artBig: (x.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
    dur: (x.trackTimeMillis || 0) / 1000, previewUrl: x.previewUrl, link: x.trackViewUrl,
  }));
}
async function trending(genre) {
  const r = await fetch('https://itunes.apple.com/us/rss/topsongs/limit=30/' + (genre ? 'genre=' + genre + '/' : '') + 'json');
  if (!r.ok) throw new Error('Trending failed');
  const j = await r.json();
  return [].concat(j.feed.entry || []).map((e) => {
    const pv = [].concat(e.link).find((l) => l.attributes.rel === 'enclosure');
    const imgs = e['im:image'] || [], img = (imgs[imgs.length - 1] || {}).label || '';
    const col = e['im:collection'];
    return {
      id: 'a' + e.id.attributes['im:id'], src: 'apple', title: e['im:name'].label, artist: e['im:artist'].label,
      album: col && col['im:name'] ? col['im:name'].label : '', art: img, artBig: img.replace(/\/\d+x\d+bb/, '/600x600bb'),
      dur: 0, previewUrl: pv && pv.attributes.href, link: e.id.label,
    };
  }).filter((t) => t.previewUrl);
}
// Audius: free, keyless, full-length streams from independent artists.
const AUD = 'https://api.audius.co/v1', APPN = 'app_name=neon-glass-player';
async function searchAudius(q) {
  const r = await fetch(AUD + '/tracks/' + (q ? 'search?query=' + encodeURIComponent(q) + '&' : 'trending?') + 'limit=25&' + APPN);
  if (!r.ok) throw new Error('Audius failed');
  return ((await r.json()).data || []).filter((x) => x.is_streamable && !x.is_stream_gated).map((x) => {
    const a = x.artwork || {};
    return {
      id: 'u' + x.id, src: 'audius', full: true, title: x.title, artist: x.user.name, album: '',
      art: a['150x150'], artBig: a['480x480'], dur: x.duration,
      previewUrl: AUD + '/tracks/' + x.id + '/stream?' + APPN, link: 'https://audius.co' + (x.permalink || ''),
    };
  });
}
async function searchSpotify(q) {
  const j = await sp.api('/search?type=track&limit=10&q=' + encodeURIComponent(q));
  return j.tracks.items.map((x) => {
    const imgs = x.album.images || [];
    return {
      id: 's' + x.id, src: 'spotify', title: x.name, artist: x.artists.map((a) => a.name).join(', '), album: x.album.name,
      art: (imgs[imgs.length - 1] || {}).url, artBig: (imgs[0] || {}).url,
      dur: x.duration_ms / 1000, uri: x.uri, link: x.external_urls.spotify,
    };
  });
}
async function search(q) {
  q = q.trim(); state.query = q;
  const seq = ++state.searchSeq;
  if (state.src !== 'liked') $('tracks').replaceChildren(el('li', 'msg', q ? 'Searching…' : 'Loading trending songs…'));
  const [a, s, u] = await Promise.allSettled([q ? searchApple(q) : trending(state.genre), q && sp.connected() ? searchSpotify(q) : Promise.resolve([]), searchAudius(q)]);
  if (seq !== state.searchSeq) return;
  state.results.apple = a.status === 'fulfilled' ? a.value : [];
  state.results.spotify = s.status === 'fulfilled' ? s.value : [];
  state.results.audius = u.status === 'fulfilled' ? u.value : [];
  state.failedU = u.status === 'rejected';
  state.failed = a.status === 'rejected' && !state.results.spotify.length;
  renderList();
}
function currentList() {
  const { apple, spotify, audius } = state.results;
  if (state.src === 'liked') return state.likes;
  if (state.src === 'audius') return audius;
  if (state.src === 'apple') return apple;
  if (state.src === 'spotify') return spotify;
  const out = [];
  for (let i = 0; i < Math.max(apple.length, spotify.length); i++) { if (spotify[i]) out.push(spotify[i]); if (apple[i]) out.push(apple[i]); }
  return out;
}
function renderList() {
  const ul = $('tracks');
  state.list = currentList();
  const g = GENRES.find((x) => x[1] === state.genre);
  $('listTitle').textContent = state.src === 'liked' ? 'LIKED SONGS' : state.src === 'audius' ? (state.query ? 'FULL SONGS ON AUDIUS' : 'TRENDING ON AUDIUS · FULL SONGS') :
    state.query ? 'RESULTS' : 'TRENDING' + (g && g[1] ? ' · ' + g[0].toUpperCase() : ' NOW');
  $('genres').hidden = !!state.query || !(state.src === 'all' || state.src === 'apple');
  if (state.src === 'spotify' && !sp.connected()) {
    const li = el('li', 'msg', 'Spotify is not connected yet. ');
    const b = el('button', 'link-btn', 'Connect Spotify'); b.type = 'button'; b.onclick = openSettings; li.append(b);
    ul.replaceChildren(li); return;
  }
  if (!state.list.length) {
    ul.replaceChildren(el('li', 'msg',
      state.src === 'liked' ? 'Nothing liked yet. Tap the heart on a song to save it here.' :
      (state.src === 'audius' ? state.failedU : state.failed) ? 'Could not load songs. Check your connection and try again.' :
      state.src === 'spotify' && !state.query ? 'Search for something to see Spotify results.' : 'No songs found. Try a different search.'));
    return;
  }
  ul.replaceChildren(...state.list.map((t, i) => {
    const li = el('li'); li.style.setProperty('--i', Math.min(i, 14));
    const b = el('button', 'track' + (state.track && state.track.id === t.id ? ' on' : '')); b.type = 'button';
    let img;
    if (t.art) { img = el('img'); img.src = t.art; img.alt = ''; img.loading = 'lazy'; } else img = el('span', 'ph');
    const d = el('div');
    d.append(el('b', null, t.title), el('small', null, t.artist + ' · ' + SRC_LABEL[t.src]));
    const eq = el('span', 'eq'); eq.append(el('i'), el('i'), el('i'));
    b.append(img, d, eq);
    b.onclick = () => { state.queue = state.list; playIndex(i); setView('player'); };
    li.append(b); return li;
  }));
  ul.scrollTop = 0;
}

/* ---------- playback ---------- */
async function previewFor(t) {
  if (t.previewUrl) return t.previewUrl;
  try {
    const hits = await searchApple(t.title + ' ' + t.artist.split(',')[0]);
    const hit = hits.find((h) => Math.abs(h.dur - t.dur) < 4) || hits[0];
    return hit ? hit.previewUrl : null;
  } catch { return null; }
}
async function playIndex(i) {
  const t = state.queue[i]; if (!t) return;
  const seq = ++state.playSeq;
  state.index = i; state.track = t; state.offset = t.full ? 0 : null; state.lineIdx = -2;
  store.set('last', { queue: state.queue.slice(0, 60), index: i });
  showTrack(t); loadLyrics(t, seq);
  document.querySelectorAll('.track').forEach((b, n) => b.classList.toggle('on', !!state.list[n] && state.list[n].id === t.id));

  if (t.src === 'spotify' && sp.ready) {
    audio.pause(); state.backend = 'spotify'; state.offset = 0;
    $('mode').textContent = 'Spotify';
    try { await sp.play(t.uri); return; } catch (e) { toast('Spotify playback failed, using a preview instead.'); }
    if (seq !== state.playSeq) return;
  }
  if (sp.ready) sp.player.pause().catch(() => {});
  state.backend = 'audio'; state.offset = t.full ? 0 : null;
  $('mode').textContent = t.full ? 'Full song' : 'Preview';
  const url = await previewFor(t);
  if (seq !== state.playSeq) return;
  if (!url) { toast('No free preview for this track.'); return; }
  audio.src = url;
  audio.play().catch(() => {});
  updateHint();
}
function step(d) {
  const n = state.queue.length; if (!n) return;
  let i = (state.index + d + n) % n;
  if (state.shuffle && d > 0 && n > 1) { do { i = Math.floor(Math.random() * n); } while (i === state.index); }
  playIndex(i);
}
function onEnded() {
  if (!state.repeat) return step(1);
  if (state.backend === 'spotify') sp.play(state.track.uri).catch(() => {});
  else { audio.currentTime = 0; audio.play().catch(() => {}); }
  state.lineIdx = -2;
}
function togglePlay() {
  popPlay();
  if (!state.track) { if (state.list.length) { state.queue = state.list; playIndex(0); } return; }
  if (state.backend === 'audio' && !audio.getAttribute('src')) return void playIndex(state.index); // restored session, nothing loaded yet
  if (state.backend === 'spotify') { sp.player.activateElement && sp.player.activateElement(); sp.player.togglePlay(); }
  else if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function popPlay() { const b = $('play'); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
const pos = () => state.backend === 'spotify' ? sp.position() : audio.currentTime || 0;
const dur = () => state.backend === 'spotify' ? sp.st.dur : (isFinite(audio.duration) ? audio.duration : 0);
const isPlaying = () => state.backend === 'spotify' ? !sp.st.paused : !audio.paused;
function seekTo(s) {
  if (state.backend === 'spotify') { sp.player.seek(s * 1000); sp.st.pos = s * 1000; sp.st.ts = Date.now(); }
  else if (dur()) audio.currentTime = Math.min(s, dur() - 0.2);
}
function setPlayingUI() {
  const p = isPlaying(), d = p ? 'M7 5h2.5v14H7zM14.5 5H17v14h-2.5z' : 'M8 5v14l11-7z';
  $('playIcon').setAttribute('d', d); $('miniIcon').setAttribute('d', d);
  $('play').setAttribute('aria-label', p ? 'Pause' : 'Play'); $('miniPlay').setAttribute('aria-label', p ? 'Pause' : 'Play');
  document.body.classList.toggle('is-playing', p);
}
audio.addEventListener('play', setPlayingUI);
audio.addEventListener('pause', setPlayingUI);
audio.addEventListener('ended', onEnded);
audio.addEventListener('playing', () => viz.connect());
audio.addEventListener('error', () => {
  if (!audio.src || state.backend !== 'audio') return;
  if (audio.crossOrigin && !viz.analyser) { // server refused cross-origin audio: retry plainly, visualizer falls back to simulation
    audio.removeAttribute('crossorigin'); viz.blocked = true; const s = audio.src; audio.src = s; audio.play().catch(() => {}); return;
  }
  toast('Could not load this preview.');
});

function showTrack(t) {
  $('title').textContent = t.title;
  $('sub').textContent = t.artist + (t.album ? ' · ' + t.album : '');
  $('miniTitle').textContent = t.title; $('miniSub').textContent = t.artist; $('miniArt').src = t.art || ''; $('mini').hidden = false;
  const img = $('artImg');
  if (t.artBig) { img.classList.remove('swap'); void img.offsetWidth; img.src = t.artBig; img.hidden = false; img.classList.add('swap'); tint(t.art || t.artBig); } else img.hidden = true;
  document.title = t.title + ' · ' + t.artist;
  $('like').setAttribute('aria-pressed', String(state.likes.some((x) => x.id === t.id)));
  const q = encodeURIComponent(t.title + ' ' + t.artist);
  const links = [
    ['Apple Music', t.src === 'apple' ? t.link : 'https://music.apple.com/us/search?term=' + q],
    ['Spotify', t.src === 'spotify' ? t.link : 'https://open.spotify.com/search/' + q],
    ['YouTube Music', 'https://music.youtube.com/search?q=' + q],
    ['SoundCloud', 'https://soundcloud.com/search?q=' + q],
    ['Amazon Music', 'https://music.amazon.com/search/' + q],
  ];
  if (t.src === 'audius') links.unshift(['Audius', t.link]);
  $('openIn').replaceChildren(...links.map(([n, h]) => { const a = el('a', null, n); a.href = h; a.target = '_blank'; a.rel = 'noopener'; return a; }));
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.artBig ? [{ src: t.artBig, sizes: '600x600' }] : [] });
  }
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  try {
    ms.setActionHandler('previoustrack', () => step(-1));
    ms.setActionHandler('nexttrack', () => step(1));
    ms.setActionHandler('play', () => { if (!isPlaying()) togglePlay(); });
    ms.setActionHandler('pause', () => { if (isPlaying()) togglePlay(); });
    ms.setActionHandler('seekto', (e) => { seekTo(e.seekTime); state.lineIdx = -2; });
    const posState = () => { try { if (dur()) ms.setPositionState({ duration: dur(), position: Math.min(pos(), dur()), playbackRate: 1 }); } catch {} };
    ['loadedmetadata', 'seeked', 'play'].forEach((ev) => audio.addEventListener(ev, posState));
  } catch {}
}
// Recolor the background glow from the artwork.
function tint(url) {
  if (root.dataset.theme === 'mono') return;
  const im = new Image(); im.crossOrigin = 'anonymous';
  im.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 8;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0, 8, 8);
      const d = x.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      r /= 64 * 255; g /= 64 * 255; b /= 64 * 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
      if (dl < 0.06) return; // near-grey art: keep current colors
      let h = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
      h = Math.round(h * 60 + 360) % 360;
      root.style.setProperty('--glow-a', `hsl(${h} 72% 42%)`);
      root.style.setProperty('--glow-b', `hsl(${(h + 150) % 360} 72% 36%)`);
    } catch {}
  };
  im.src = url;
}

/* ---------- themes ---------- */
const THEMES = ['neon', 'sunset', 'ocean', 'mono'];
function setTheme(name, announce) {
  root.dataset.theme = name; store.set('theme', name);
  root.style.removeProperty('--glow-a'); root.style.removeProperty('--glow-b');
  if (state.track) tint(state.track.art || state.track.artBig);
  viz.readColors();
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (announce) toast('Theme: ' + name[0].toUpperCase() + name.slice(1));
}
$('themeBtn').onclick = () => setTheme(THEMES[(THEMES.indexOf(root.dataset.theme) + 1) % THEMES.length], true);

/* ---------- visualizer ---------- */
const viz = {
  c: $('viz'), n: 40, v: new Float32Array(40), analyser: null, data: null, blocked: false, colors: ['#ff2fd0', '#29d8ff'],
  readColors() { const s = getComputedStyle(root); this.colors = [s.getPropertyValue('--pink').trim(), s.getPropertyValue('--cyan').trim()]; },
  // Real frequency data on desktop. Phones keep plain <audio> so music keeps playing with the screen locked.
  connect() {
    if (this.analyser || this.blocked || !finePointer || !audio.crossOrigin) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      const src = this.ac.createMediaElementSource(audio);
      this.analyser = this.ac.createAnalyser(); this.analyser.fftSize = 256; this.analyser.smoothingTimeConstant = .8;
      src.connect(this.analyser); this.analyser.connect(this.ac.destination);
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
    } catch { this.blocked = true; }
  },
  draw(ts) {
    requestAnimationFrame((t) => this.draw(t));
    if (isPhone() && app.dataset.view === 'library') return;
    const c = this.c, dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext('2d'), playing = isPlaying(), t = ts / 1000, n = this.n;
    const real = this.analyser && state.backend === 'audio';
    if (real) { if (this.ac.state === 'suspended' && playing) this.ac.resume(); this.analyser.getByteFrequencyData(this.data); }
    x.clearRect(0, 0, w, h);
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, this.colors[1]); g.addColorStop(1, this.colors[0]);
    x.fillStyle = g;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      // mirror around the center so the shape is symmetric
      const k = Math.abs(i - (n - 1) / 2) / (n / 2);
      let target;
      if (real) target = this.data[Math.floor(k * 70) + 2] / 255;
      else target = playing ? (0.2 + 0.8 * Math.abs(Math.sin(t * 3.1 + i * 0.9) * Math.sin(t * 1.7 + i * 0.37))) * (1 - k * 0.6) : 0;
      this.v[i] += (target - this.v[i]) * (real ? 0.5 : 0.12);
      const bh = Math.max(2 * dpr, this.v[i] * h * 0.95);
      x.globalAlpha = 0.35 + this.v[i] * 0.65;
      x.beginPath(); x.roundRect(i * bw + bw * 0.2, h - bh, bw * 0.6, bh + 10, bw * 0.3); x.fill();
    }
  },
};
if (finePointer) audio.crossOrigin = 'anonymous';

/* ---------- lyrics ---------- */
function parseLrc(txt) {
  const out = [];
  for (const row of txt.split('\n')) {
    const text = row.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of row.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) out.push({ t: +m[1] * 60 + +m[2], text: text || '♪' });
  }
  return out.sort((a, b) => a.t - b.t);
}
async function loadLyrics(t, seq) {
  const box = $('lines');
  state.lyrics = null; box.className = 'lines'; box.replaceChildren(el('p', 'empty', 'Finding lyrics…')); updateHint();
  let pick = null;
  try {
    const artist = t.artist.split(/,| & | feat/i)[0];
    const title = t.title.replace(/\s*[(\[][^)\]]*(feat|with|remaster|version|edit)[^)\]]*[)\]]/gi, '');
    const r = await fetch('https://lrclib.net/api/search?track_name=' + encodeURIComponent(title) + '&artist_name=' + encodeURIComponent(artist));
    const list = r.ok ? await r.json() : [];
    const near = (x) => Math.abs((x.duration || 0) - t.dur);
    const synced = list.filter((x) => x.syncedLyrics);
    if (t.dur) synced.sort((a, b) => near(a) - near(b));
    pick = synced[0] || list.find((x) => x.plainLyrics) || null;
  } catch {}
  if (seq !== state.playSeq) return;
  if (!pick) { box.replaceChildren(el('p', 'empty', 'No lyrics found for this track.')); updateHint(); return; }
  if (pick.syncedLyrics) state.lyrics = { synced: parseLrc(pick.syncedLyrics) };
  else state.lyrics = { plain: pick.plainLyrics.split('\n') };
  state.lineIdx = -2;
  renderLyrics();
}
function renderLyrics() {
  const box = $('lines'), ly = state.lyrics;
  if (!ly) return;
  if (ly.plain) {
    box.className = 'lines plain';
    box.replaceChildren(...ly.plain.map((s) => el('p', 'line', s || ' ')));
  } else {
    box.className = 'lines' + (state.offset === null ? ' plain pick' : '');
    box.replaceChildren(...ly.synced.map((l, i) => {
      const b = el('button', 'line', l.text); b.type = 'button';
      b.onclick = () => lineTap(i);
      return b;
    }));
  }
  box.scrollTop = 0;
  updateHint();
}
function lineTap(i) {
  const l = state.lyrics.synced[i];
  if (fullLen()) { seekTo(l.t); state.lineIdx = -2; return; }
  // Preview clips start somewhere mid-song: the tapped line tells us where.
  const first = state.offset === null;
  state.offset = l.t - pos();
  state.lineIdx = -2;
  if (first) { $('lines').className = 'lines'; toast('Lyrics synced to the preview.'); }
  updateHint(); syncLyrics();
}
function updateHint() {
  const ly = state.lyrics, needSync = ly && ly.synced && !fullLen() && state.offset === null;
  $('lyHint').textContent = !ly ? '' : ly.plain ? 'Not time-synced' :
    fullLen() ? 'Tap a line to jump there' :
    needSync ? 'Tap the line you hear to sync' : 'Synced · tap a line to re-sync';
  const peek = $('peek'); peek.classList.remove('live');
  peek.textContent = !ly ? 'Lyrics' : needSync ? 'Lyrics · tap to sync with the preview ›' : 'Show lyrics ›';
}
function syncLyrics() {
  const ly = state.lyrics;
  if (!ly || !ly.synced || state.offset === null) return;
  const t = pos() + state.offset + 0.15;
  let idx = -1;
  for (let i = 0; i < ly.synced.length && ly.synced[i].t <= t; i++) idx = i;
  if (idx === state.lineIdx) return;
  state.lineIdx = idx;
  const box = $('lines'), kids = box.children;
  for (let i = 0; i < kids.length; i++) kids[i].className = 'line' + (i < idx ? ' past' : i === idx ? ' cur' : i === idx + 1 ? ' next' : '');
  const cur = kids[Math.max(idx, 0)];
  if (cur) box.scrollTo({ top: cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2, behavior: 'smooth' });
  if (idx >= 0) { $('peek').textContent = ly.synced[idx].text; $('peek').classList.add('live'); }
}

/* ---------- ticker ---------- */
setInterval(() => {
  const d = dur(), p = pos(), pct = d ? Math.min(100, (p / d) * 100) : 0;
  if (!state.seeking) {
    $('seek').value = pct * 10; $('seek').style.setProperty('--p', pct + '%');
    $('cur').textContent = fmt(p);
  }
  $('miniProg').style.setProperty('--p', pct + '%');
  $('dur').textContent = fmt(d);
  syncLyrics();
}, 200);
$('seek').addEventListener('input', () => {
  state.seeking = true;
  const v = +$('seek').value; $('seek').style.setProperty('--p', v / 10 + '%');
  $('cur').textContent = fmt((v / 1000) * dur());
});
$('seek').addEventListener('change', () => { seekTo((+$('seek').value / 1000) * dur()); state.seeking = false; state.lineIdx = -2; });

/* ---------- gestures ---------- */
// Album art: tap = play/pause, swipe sideways = next/previous, swipe down = close (phone), mouse hover = 3D tilt.
(function artGestures() {
  const wrap = $('artWrap'), art = $('art'), player = $('player');
  let g = null;
  const resetArt = () => { art.style.removeProperty('--tx'); art.style.removeProperty('--rot'); art.style.opacity = ''; };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    g = { x: e.clientX, y: e.clientY, axis: null, dx: 0, dy: 0 };
    try { wrap.setPointerCapture(e.pointerId); } catch {}
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!g) {
      if (e.pointerType !== 'mouse') return;
      const r = wrap.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      art.classList.add('live');
      art.style.setProperty('--ry', (px - 0.5) * 18 + 'deg'); art.style.setProperty('--rx', (0.5 - py) * 18 + 'deg');
      art.style.setProperty('--sx', px * 100 + '%'); art.style.setProperty('--sy', py * 100 + '%'); art.style.setProperty('--sh', 1);
      return;
    }
    g.dx = e.clientX - g.x; g.dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(g.dx, g.dy) < 8) return;
      g.axis = Math.abs(g.dx) > Math.abs(g.dy) ? 'x' : 'y';
      art.classList.add('live');
      if (g.axis === 'y' && isPhone()) player.style.transition = 'none';
    }
    if (g.axis === 'x') {
      art.style.setProperty('--tx', g.dx + 'px'); art.style.setProperty('--rot', g.dx / 18 + 'deg');
      art.style.opacity = 1 - Math.min(0.6, Math.abs(g.dx) / 400);
    } else if (isPhone() && g.dy > 0) player.style.transform = `translateY(${g.dy}px)`;
  });
  const end = (cancelled) => {
    if (!g) return;
    const { axis, dx, dy } = g; g = null;
    art.classList.remove('live');
    if (!axis) { if (!cancelled) togglePlay(); return; }
    if (axis === 'x') {
      if (Math.abs(dx) > 70 && state.queue.length && !cancelled) {
        const dir = dx < 0 ? 1 : -1;
        art.style.setProperty('--tx', -dir * 130 + '%'); art.style.opacity = 0;
        setTimeout(() => {
          step(dir);
          art.classList.add('live'); art.style.setProperty('--tx', dir * 60 + 'px'); art.style.setProperty('--rot', '0deg');
          void art.offsetWidth; art.classList.remove('live'); resetArt();
        }, 200);
      } else resetArt();
    } else {
      player.style.transition = ''; player.style.transform = '';
      if (dy > 110 && isPhone() && !cancelled) setView('library');
    }
  };
  wrap.addEventListener('pointerup', () => end(false));
  wrap.addEventListener('pointercancel', () => end(true));
  wrap.addEventListener('pointerleave', () => {
    if (g) return;
    art.classList.remove('live');
    ['--rx', '--ry'].forEach((p) => art.style.removeProperty(p)); art.style.setProperty('--sh', 0);
  });
})();
// Pull a full-screen sheet down by its header to close it (phone).
function dragSheet(head, panel, close) {
  let s = null;
  head.addEventListener('pointerdown', (e) => {
    if (!isPhone() || e.target.closest('button')) return;
    s = { y: e.clientY, dy: 0 }; try { head.setPointerCapture(e.pointerId); } catch {}
    panel.style.transition = 'none';
  });
  head.addEventListener('pointermove', (e) => { if (!s) return; s.dy = Math.max(0, e.clientY - s.y); panel.style.transform = `translateY(${s.dy}px)`; });
  const up = () => { if (!s) return; const dy = s.dy; s = null; panel.style.transition = ''; panel.style.transform = ''; if (dy > 110) close(); };
  head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
}
dragSheet($('playerHead'), $('player'), () => setView('library'));
dragSheet($('lyricsHead'), $('lyricsPanel'), () => setView('player'));
// Sticky note: drag it anywhere by its label (desktop); double-click the label to put it back.
(function stickyDrag() {
  const note = $('sticky'), grip = $('stickyGrip'), home = $('library');
  let d = null;
  const place = (x, y) => {
    note.style.left = Math.max(0, Math.min(innerWidth - 60, x)) + 'px';
    note.style.top = Math.max(0, Math.min(innerHeight - 40, y)) + 'px';
  };
  const float = (x, y) => { document.body.append(note); note.classList.add('float'); place(x, y); };
  grip.addEventListener('click', (e) => e.preventDefault());
  grip.addEventListener('pointerdown', (e) => {
    if (isPhone()) return;
    const r = note.getBoundingClientRect();
    d = { ox: e.clientX - r.left, oy: e.clientY - r.top };
    float(r.left, r.top); note.classList.add('drag');
    try { grip.setPointerCapture(e.pointerId); } catch {}
  });
  grip.addEventListener('pointermove', (e) => { if (d) place(e.clientX - d.ox, e.clientY - d.oy); });
  const up = () => { if (!d) return; d = null; note.classList.remove('drag'); store.set('notePos', [parseFloat(note.style.left), parseFloat(note.style.top)]); };
  grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  grip.addEventListener('dblclick', () => { note.classList.remove('float'); note.style.left = note.style.top = ''; home.append(note); store.del('notePos'); });
  const p = store.get('notePos');
  if (p && !isPhone()) float(p[0], p[1]);
})();

/* ---------- Spotify (optional, PKCE, no server) ---------- */
const sp = {
  player: null, ready: false, deviceId: null,
  st: { pos: 0, ts: 0, paused: true, dur: 0 },
  redirect: location.origin + location.pathname.replace(/index\.html$/, ''),
  scopes: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state',
  connected() { return !!store.get('sp.tok'); },
  position() { const s = this.st; return (s.paused ? s.pos : Math.min(s.dur * 1000, s.pos + Date.now() - s.ts)) / 1000; },
  async login(clientId) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    const verifier = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    store.set('sp.cid', clientId); store.set('sp.ver', verifier);
    location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: this.redirect,
      code_challenge_method: 'S256', code_challenge: challenge, scope: this.scopes,
    });
  },
  async tokenReq(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: store.get('sp.cid'), ...params }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || 'Spotify sign-in failed');
    const old = store.get('sp.tok') || {};
    store.set('sp.tok', { access: j.access_token, refresh: j.refresh_token || old.refresh, exp: Date.now() + (j.expires_in - 60) * 1000 });
  },
  async token() {
    let t = store.get('sp.tok'); if (!t) throw new Error('Not connected');
    if (Date.now() > t.exp) {
      try { await this.tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh }); }
      catch (e) { this.logout(); throw e; }
      t = store.get('sp.tok');
    }
    return t.access;
  },
  async api(path, opt = {}) {
    const r = await fetch('https://api.spotify.com/v1' + path, { ...opt, headers: { Authorization: 'Bearer ' + await this.token(), 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('Spotify error ' + r.status);
    return r.status === 204 || r.headers.get('content-length') === '0' ? null : r.json().catch(() => null);
  },
  play(uri) {
    this.player.activateElement && this.player.activateElement();
    return this.api('/me/player/play?device_id=' + this.deviceId, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
  },
  logout() { store.del('sp.tok'); this.ready = false; if (this.player) this.player.disconnect(); this.player = null; refreshSpUI(); },
  async handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    history.replaceState(null, '', this.redirect);
    if (q.has('error')) { toast('Spotify sign-in was cancelled.'); return; }
    try { await this.tokenReq({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: this.redirect, code_verifier: store.get('sp.ver') }); toast('Spotify connected.'); }
    catch (e) { toast(e.message); }
    store.del('sp.ver');
  },
  initPlayer() {
    if (!this.connected() || this.player) return;
    window.onSpotifyWebPlaybackSDKReady = () => {
      const p = this.player = new Spotify.Player({ name: 'Neon Glass Player', volume: store.get('vol', 80) / 100, getOAuthToken: (cb) => this.token().then(cb).catch(() => {}) });
      p.addListener('ready', ({ device_id }) => { this.deviceId = device_id; this.ready = true; refreshSpUI(); });
      p.addListener('not_ready', () => { this.ready = false; refreshSpUI(); });
      p.addListener('account_error', () => { this.ready = false; toast('Full Spotify playback needs Premium. Using free previews instead.'); refreshSpUI(); });
      p.addListener('authentication_error', () => { toast('Spotify session expired. Connect again.'); this.logout(); });
      p.addListener('player_state_changed', (s) => {
        if (!s || state.backend !== 'spotify') return;
        const prev = this.st;
        const ended = !prev.paused && s.paused && s.position === 0 && prev.dur && this.position() > prev.dur - 3;
        this.st = { pos: s.position, ts: Date.now(), paused: s.paused, dur: s.duration / 1000 };
        setPlayingUI();
        if (ended) onEnded();
      });
      p.connect();
    };
    const s = document.createElement('script'); s.src = 'https://sdk.scdn.co/spotify-player.js'; document.head.append(s);
  },
};
function refreshSpUI() {
  const on = sp.connected(), b = $('settingsBtn');
  b.textContent = on ? (sp.ready ? 'Spotify connected' : 'Spotify: search only') : 'Connect Spotify';
  b.classList.toggle('ok', on);
  $('spLogout').hidden = !on;
  $('spStatus').textContent = on ? (sp.ready ? 'Connected. Full playback is ready.' : 'Connected. Search works; full playback starts once the Spotify player is ready (Premium only).') : '';
}
function openSettings() {
  $('redir').textContent = sp.redirect;
  $('clientId').value = store.get('sp.cid', '');
  refreshSpUI();
  $('settings').showModal();
}
$('settingsBtn').onclick = openSettings;
$('spConnect').onclick = () => {
  const id = $('clientId').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) { $('spStatus').textContent = 'That does not look like a Client ID (32 letters and numbers).'; return; }
  sp.login(id);
};
$('spLogout').onclick = () => { sp.logout(); toast('Spotify disconnected.'); };

/* ---------- wiring ---------- */
$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(typeTimer); search($('q').value); $('q').blur(); });
let typeTimer;
$('q').addEventListener('input', () => {
  clearTimeout(typeTimer);
  const v = $('q').value.trim();
  if (!v) { if (state.query) search(''); return; }
  if (v.length >= 2) typeTimer = setTimeout(() => search(v), 450);
});
$('genres').replaceChildren(...GENRES.map(([name, id]) => {
  const b = el('button', 'chip' + (id === state.genre ? ' on' : ''), name); b.type = 'button';
  b.onclick = () => { state.genre = id; store.set('genre', id); [...$('genres').children].forEach((c) => c.classList.toggle('on', c === b)); search(''); };
  return b;
}));
$('chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  state.src = c.dataset.src;
  $('chips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  renderList();
});
$('play').onclick = togglePlay;
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('miniPlay').onclick = togglePlay;
$('miniNext').onclick = () => step(1);
$('miniOpen').onclick = () => setView('player');
$('closePlayer').onclick = () => setView('library');
$('openLyrics').onclick = $('peek').onclick = () => setView('lyrics');
$('closeLyrics').onclick = () => setView('player');
function toggleBtn(id, key, onMsg, offMsg) {
  const b = $(id); b.setAttribute('aria-pressed', String(state[key]));
  b.onclick = () => { state[key] = !state[key]; store.set(key, state[key]); b.setAttribute('aria-pressed', String(state[key])); toast(state[key] ? onMsg : offMsg); };
}
toggleBtn('shuffle', 'shuffle', 'Shuffle on', 'Shuffle off');
toggleBtn('repeat', 'repeat', 'Repeating this song', 'Repeat off');
$('like').onclick = () => {
  const t = state.track; if (!t) return;
  const i = state.likes.findIndex((x) => x.id === t.id);
  if (i >= 0) state.likes.splice(i, 1); else state.likes.unshift(t);
  store.set('likes', state.likes);
  $('like').setAttribute('aria-pressed', String(i < 0));
  toast(i < 0 ? 'Added to Liked' : 'Removed from Liked');
  if (state.src === 'liked') renderList();
};
function setVol(v) {
  $('vol').value = v; $('vol').style.setProperty('--p', v + '%');
  audio.volume = v / 100; if (sp.player) sp.player.setVolume(v / 100).catch(() => {});
}
$('vol').addEventListener('input', () => { setVol(+$('vol').value); store.set('vol', +$('vol').value); });
document.addEventListener('keydown', (e) => {
  if ($('settings').open) return;
  if (e.code === 'Escape') { setView(app.dataset.view === 'lyrics' ? 'player' : 'library'); return; }
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
});
$('note').value = store.get('note', '');
$('note').addEventListener('input', () => store.set('note', $('note').value));

(async function init() {
  setTheme(THEMES.includes(store.get('theme')) ? store.get('theme') : 'neon', false);
  setVol(store.get('vol', 80));
  viz.draw(0);
  await sp.handleRedirect();
  refreshSpUI();
  sp.initPlayer();
  const last = store.get('last');
  if (last && last.queue && last.queue[last.index]) { // bring back the last song, paused
    state.queue = last.queue; state.index = last.index; state.track = last.queue[last.index];
    showTrack(state.track); $('mode').textContent = state.track.full ? 'Full song' : 'Preview';
  }
  search('');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
