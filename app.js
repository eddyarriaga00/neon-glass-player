'use strict';
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('ngp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ngp.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('ngp.' + k); } catch {} },
};
const audio = $('audio');
const app = document.querySelector('.app');

const state = {
  results: { apple: [], spotify: [] },
  list: [],          // what the track list currently shows
  queue: [],         // list the current track was started from
  index: -1,
  track: null,
  backend: 'audio',  // 'audio' | 'spotify'
  src: 'all',
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
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function setView(v) {
  app.dataset.view = v;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
}

/* ---------- search ---------- */
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
  q = q.trim(); if (!q) return;
  store.set('q', q);
  const seq = ++state.searchSeq;
  $('tracks').replaceChildren(el('li', 'msg', 'Searching…'));
  const [a, s] = await Promise.allSettled([searchApple(q), sp.connected() ? searchSpotify(q) : Promise.resolve([])]);
  if (seq !== state.searchSeq) return;
  state.results.apple = a.status === 'fulfilled' ? a.value : [];
  state.results.spotify = s.status === 'fulfilled' ? s.value : [];
  if (a.status === 'rejected' && !state.results.spotify.length) { $('tracks').replaceChildren(el('li', 'msg', 'Search failed. Check your connection and try again.')); return; }
  renderList();
}
function currentList() {
  const { apple, spotify } = state.results;
  if (state.src === 'apple') return apple;
  if (state.src === 'spotify') return spotify;
  const out = [];
  for (let i = 0; i < Math.max(apple.length, spotify.length); i++) { if (spotify[i]) out.push(spotify[i]); if (apple[i]) out.push(apple[i]); }
  return out;
}
function renderList() {
  const ul = $('tracks');
  state.list = currentList();
  if (state.src === 'spotify' && !sp.connected()) {
    const li = el('li', 'msg', 'Spotify is not connected yet. ');
    const b = el('button', 'link-btn', 'Connect Spotify'); b.type = 'button'; b.onclick = openSettings; li.append(b);
    ul.replaceChildren(li); return;
  }
  if (!state.list.length) { ul.replaceChildren(el('li', 'msg', 'No songs found. Try a different search.')); return; }
  ul.replaceChildren(...state.list.map((t, i) => {
    const li = el('li');
    const b = el('button', 'track' + (state.track && state.track.id === t.id ? ' on' : '')); b.type = 'button';
    let img;
    if (t.art) { img = el('img'); img.src = t.art; img.alt = ''; img.loading = 'lazy'; } else img = el('span', 'ph');
    const d = el('div');
    d.append(el('b', null, t.title), el('small', null, t.artist + ' · ' + (t.src === 'apple' ? 'Apple Music' : 'Spotify')));
    b.append(img, d);
    b.onclick = () => { state.queue = state.list; playIndex(i); setView('player'); };
    li.append(b); return li;
  }));
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
  state.index = i; state.track = t; state.offset = null; state.lineIdx = -2;
  showTrack(t); loadLyrics(t, seq);
  document.querySelectorAll('.track').forEach((b, n) => b.classList.toggle('on', state.list[n] && state.list[n].id === t.id));

  if (t.src === 'spotify' && sp.ready) {
    audio.pause(); state.backend = 'spotify'; state.offset = 0;
    $('mode').textContent = 'Spotify';
    try { await sp.play(t.uri); return; } catch (e) { toast('Spotify playback failed, using a preview instead.'); }
    if (seq !== state.playSeq) return;
  }
  if (sp.ready) sp.player.pause().catch(() => {});
  state.backend = 'audio'; state.offset = null;
  $('mode').textContent = 'Preview';
  const url = await previewFor(t);
  if (seq !== state.playSeq) return;
  if (!url) { toast('No free preview for this track. Open it in a service below.'); return; }
  audio.src = url;
  audio.play().catch(() => {});
  updateHint();
}
function step(d) {
  if (!state.queue.length) return;
  playIndex((state.index + d + state.queue.length) % state.queue.length);
}
function togglePlay() {
  if (!state.track) { if (state.list.length) { state.queue = state.list; playIndex(0); } return; }
  if (state.backend === 'spotify') { sp.player.activateElement && sp.player.activateElement(); sp.player.togglePlay(); }
  else if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
const pos = () => state.backend === 'spotify' ? sp.position() : audio.currentTime || 0;
const dur = () => state.backend === 'spotify' ? sp.st.dur : (isFinite(audio.duration) ? audio.duration : 0);
const isPlaying = () => state.backend === 'spotify' ? !sp.st.paused : !audio.paused;
function seekTo(s) {
  if (state.backend === 'spotify') { sp.player.seek(s * 1000); sp.st.pos = s * 1000; sp.st.ts = Date.now(); }
  else if (dur()) audio.currentTime = Math.min(s, dur() - 0.2);
}
function setPlayingUI() {
  const p = isPlaying();
  $('playIcon').setAttribute('d', p ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
  $('play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  $('player').classList.toggle('playing', p);
}
audio.addEventListener('play', setPlayingUI);
audio.addEventListener('pause', setPlayingUI);
audio.addEventListener('ended', () => step(1));
audio.addEventListener('error', () => { if (audio.src && state.backend === 'audio') toast('Could not load this preview.'); });

function showTrack(t) {
  $('title').textContent = t.title;
  $('sub').textContent = t.artist + (t.album ? ' · ' + t.album : '');
  const img = $('artImg');
  if (t.artBig) { img.src = t.artBig; img.hidden = false; tint(t.art || t.artBig); } else img.hidden = true;
  document.title = t.title + ' · ' + t.artist;
  const q = encodeURIComponent(t.title + ' ' + t.artist);
  const links = [
    ['Apple Music', t.src === 'apple' ? t.link : 'https://music.apple.com/us/search?term=' + q],
    ['Spotify', t.src === 'spotify' ? t.link : 'https://open.spotify.com/search/' + q],
    ['YouTube Music', 'https://music.youtube.com/search?q=' + q],
    ['SoundCloud', 'https://soundcloud.com/search?q=' + q],
    ['Amazon Music', 'https://music.amazon.com/search/' + q],
  ];
  $('openIn').replaceChildren(...links.map(([n, h]) => { const a = el('a', null, n); a.href = h; a.target = '_blank'; a.rel = 'noopener'; return a; }));
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.artBig ? [{ src: t.artBig, sizes: '600x600' }] : [] });
  }
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}
// Recolor the background glow from the artwork.
function tint(url) {
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
      document.documentElement.style.setProperty('--glow-a', `hsl(${h} 72% 42%)`);
      document.documentElement.style.setProperty('--glow-b', `hsl(${(h + 150) % 360} 72% 36%)`);
    } catch {}
  };
  im.src = url;
}

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
    const artist = t.artist.split(',')[0];
    const title = t.title.replace(/\s*[(\[][^)\]]*(feat|with|remaster|version|edit)[^)\]]*[)\]]/gi, '');
    const r = await fetch('https://lrclib.net/api/search?track_name=' + encodeURIComponent(title) + '&artist_name=' + encodeURIComponent(artist));
    const list = r.ok ? await r.json() : [];
    const near = (x) => Math.abs((x.duration || 0) - t.dur);
    const synced = list.filter((x) => x.syncedLyrics).sort((a, b) => near(a) - near(b));
    pick = synced[0] || list.find((x) => x.plainLyrics) || null;
  } catch {}
  if (seq !== state.playSeq) return;
  if (!pick) { box.replaceChildren(el('p', 'empty', 'No lyrics found for this track.')); return; }
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
  if (state.backend === 'spotify') { seekTo(l.t); return; }
  // Preview clips start somewhere mid-song: the tapped line tells us where.
  const first = state.offset === null;
  state.offset = l.t - pos();
  state.lineIdx = -2;
  if (first) { $('lines').className = 'lines'; toast('Lyrics synced to the preview.'); }
  updateHint(); syncLyrics();
}
function updateHint() {
  const ly = state.lyrics;
  $('lyHint').textContent = !ly ? '' : ly.plain ? 'Not time-synced' :
    state.backend === 'spotify' ? 'Tap a line to jump there' :
    state.offset === null ? 'Preview clip: tap the line you hear to sync' : 'Synced · tap a line to re-sync';
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
}

/* ---------- ticker ---------- */
setInterval(() => {
  const d = dur(), p = pos();
  if (!state.seeking) {
    const v = d ? Math.min(1000, (p / d) * 1000) : 0;
    $('seek').value = v; $('seek').style.setProperty('--p', v / 10 + '%');
    $('cur').textContent = fmt(p);
  }
  $('dur').textContent = fmt(d);
  syncLyrics();
}, 200);
$('seek').addEventListener('input', () => {
  state.seeking = true;
  const v = +$('seek').value; $('seek').style.setProperty('--p', v / 10 + '%');
  $('cur').textContent = fmt((v / 1000) * dur());
});
$('seek').addEventListener('change', () => { seekTo((+$('seek').value / 1000) * dur()); state.seeking = false; state.lineIdx = -2; });

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
      const p = this.player = new Spotify.Player({ name: 'Neon Glass Player', volume: 0.8, getOAuthToken: (cb) => this.token().then(cb).catch(() => {}) });
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
        if (ended) step(1);
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
$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); search($('q').value); $('q').blur(); });
$('chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  state.src = c.dataset.src;
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  renderList();
});
$('play').onclick = togglePlay;
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || $('settings').open) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
});
$('note').value = store.get('note', '');
$('note').addEventListener('input', () => store.set('note', $('note').value));

(async function init() {
  await sp.handleRedirect();
  refreshSpUI();
  sp.initPlayer();
  const q = store.get('q', 'synthwave');
  $('q').value = q === 'synthwave' ? '' : q;
  search(q);
})();
