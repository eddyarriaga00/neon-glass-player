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
const isPhone = () => matchMedia('(max-width: 700px), (max-width: 880px) and (orientation: portrait)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

const state = {
  results: { apple: [], spotify: [] },
  primary: store.get('primary', 'apple'), // service that leads the list and handles playback when it can
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
  forced: 0,         // songs lined up with "play next" that go ahead of shuffle
  tab: 'lyrics',     // side panel: 'lyrics' | 'queue'
  playSeq: 0,
  album: null,       // album page being shown in the list
  shufNext: null,    // the song shuffle has picked to come next
  artColors: store.get('artColors', true), // accent colors follow the album art
  sleepAt: 0,
  lyHold: 0,         // until when lyrics stop following, because the user is scrolling them
};

/* ---------- helpers ---------- */
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
// A light tap you can feel, where the phone allows it.
function buzz() {
  try {
    if (navigator.vibrate) { navigator.vibrate(10); return; }
    const l = document.createElement('label'), i = document.createElement('input');
    l.style.display = 'none'; i.type = 'checkbox'; i.setAttribute('switch', ''); l.append(i);
    document.head.append(l); l.click(); l.remove();
  } catch {}
}
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const vt = (fn) => { if (document.startViewTransition && !calm.matches) document.startViewTransition(fn); else fn(); };
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
// Views stack library < player < lyrics. On phones each step down is a history entry so the back button/gesture closes sheets.
const DEPTH = { library: 0, player: 1, lyrics: 2 };
let skipPop = 0;
function setView(v, fromPop) {
  const cur = app.dataset.view; if (v === cur) return;
  app.dataset.view = v;
  if (v === 'library') document.body.classList.remove('theater');
  document.body.classList.toggle('sheet', v !== 'library');
  if (v === 'player' && cur === 'library') $('player').scrollTop = 0;
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
const SRC_LABEL = { apple: 'Apple Music', spotify: 'Spotify' };
const GENRES = [['Top', 0], ['Hip-Hop', 18], ['R&B', 15], ['Pop', 14], ['Latin', 12], ['Rock', 21], ['Alt', 20], ['Electronic', 7], ['Country', 6]];

/* ---------- search + trending ---------- */
async function searchApple(q) {
  const r = await fetch('https://itunes.apple.com/search?entity=song&limit=25&term=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('Apple search failed');
  const j = await r.json();
  const seen = new Set(), key = (x) => (x.trackName + '|' + x.artistName).toLowerCase().replace(/[^a-z0-9|]+/g, '');
  return j.results.filter((x) => x.previewUrl && !seen.has(key(x)) && seen.add(key(x))).map(appleTrack); // same song listed twice: keep one
}
const appleTrack = (x) => ({
  id: 'a' + x.trackId, src: 'apple', title: x.trackName, artist: x.artistName, album: x.collectionName || '',
  art: x.artworkUrl100, artBig: (x.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
  dur: (x.trackTimeMillis || 0) / 1000, previewUrl: x.previewUrl, link: x.trackViewUrl,
});
function skeleton() {
  $('tracks').replaceChildren(...Array.from({ length: 8 }, (_, i) => {
    const li = el('li', 'skel'); li.style.setProperty('--i', i); li.append(el('i'), el('span')); return li;
  }));
}
// Album page: every song on the album the current song comes from.
async function openAlbum(t) {
  const id = t.src === 'apple' && t.link && (t.link.match(/\/album\/[^/]*\/(\d+)/) || [])[1];
  const allChip = $('chips').querySelector('[data-src="all"]');
  if (state.src !== 'all') { state.src = 'all'; $('chips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === allChip)); }
  $('recents').hidden = true; clearTimeout(typeTimer);
  setView('library');
  if (!id) { // no album id (Spotify song): search for the album instead
    if (!t.album) return;
    const q = t.album + ' ' + t.artist.split(/,| & /)[0].trim();
    $('q').value = q; $('qClear').hidden = false; search(q); return;
  }
  const seq = ++state.searchSeq, back = state.album ? state.album.back : state.query;
  skeleton();
  try {
    const r = await fetch('https://itunes.apple.com/lookup?entity=song&limit=200&id=' + id);
    if (!r.ok) throw new Error('lookup');
    const j = await r.json();
    if (seq !== state.searchSeq) return;
    const head = j.results.find((x) => x.wrapperType === 'collection');
    const songs = j.results.filter((x) => x.wrapperType === 'track' && x.previewUrl).map(appleTrack);
    if (!head || !songs.length) throw new Error('empty');
    state.album = { name: head.collectionName, artist: head.artistName, art: (head.artworkUrl100 || '').replace('100x100bb', '600x600bb'), year: (head.releaseDate || '').slice(0, 4), back };
    state.query = ''; $('q').value = ''; $('qClear').hidden = true;
    state.results = { apple: songs, spotify: [] }; state.failed = false;
    renderList();
  } catch {
    if (seq !== state.searchSeq) return;
    toast('Could not open that album.'); search(back);
  }
}
function playAll(shuffle) {
  if (!state.list.length) return;
  state.shuffle = shuffle; store.set('shuffle', shuffle); $('shuffle').setAttribute('aria-pressed', String(shuffle));
  state.queue = state.list; state.forced = 0;
  playIndex(shuffle ? Math.floor(Math.random() * state.list.length) : 0); setView('player');
}
function actsRow(extra) {
  const d = el('div', 'acts');
  const p = el('button', 'act main', 'Play'); p.type = 'button'; p.onclick = () => playAll(false);
  const s = el('button', 'act', 'Shuffle'); s.type = 'button'; s.onclick = () => playAll(true);
  d.append(p, s); if (extra) d.append(extra); return d;
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
async function searchSpotify(q) {
  const j = await sp.api('/search?type=track&limit=10&q=' + encodeURIComponent(q));
  return j.tracks.items.map(spTrack);
}
function spTrack(x) {
  const al = x.album || {}, imgs = al.images || [];
  return {
    id: 's' + x.id, src: 'spotify', title: x.name, artist: (x.artists || []).map((a) => a.name).join(', '), album: al.name || '',
    art: (imgs[imgs.length - 1] || {}).url, artBig: (imgs[0] || {}).url,
    dur: (x.duration_ms || 0) / 1000, uri: x.uri, link: (x.external_urls || {}).spotify,
  };
}
// Spotify tab home: Liked Songs and the user's playlists as a grid of tiles.
async function renderSpLib(ul) {
  $('listTitle').textContent = 'Your Spotify'; $('listTitle').classList.add('big');
  const here = () => state.src === 'spotify' && !state.query && !(state.album && state.album.sp);
  if (!/user-library-read/.test(store.get('sp.scope', ''))) {
    ul.replaceChildren(infoCard('One more step', 'Connect Spotify again so this app can see your playlists and liked songs.', 'Reconnect', () => { const id = store.get('sp.cid'); if (id) sp.login(id); else connectSpotify(); }, SP_ICON));
    return;
  }
  if (!sp.lib) {
    skeleton();
    try { sp.lib = await sp.playlists(); }
    catch { if (here()) ul.replaceChildren(el('li', 'msg', 'Could not load your Spotify playlists. Check your connection and try again.')); return; }
    if (!here()) return;
  }
  const tile = (p, i) => {
    const b = el('button', 'pl' + (p.id === 'liked' ? ' liked' : '')); b.type = 'button'; b.style.setProperty('--i', Math.min(i, 14));
    let pic;
    if (p.id === 'liked') { pic = el('span', 'pic'); pic.innerHTML = HEART; }
    else if (p.art) { pic = el('img', 'pic'); pic.src = p.art; pic.alt = ''; pic.loading = 'lazy'; pic.draggable = false; }
    else pic = el('span', 'pic');
    const d = el('span'); d.append(el('b', null, p.name), el('small', null, p.note));
    b.append(pic, d); b.onclick = () => openSpList(p); return b;
  };
  const li = el('li', 'sp-lib'), g = el('div', 'sp-grid');
  g.append(...[{ id: 'liked', name: 'Liked Songs', note: 'Your saved songs' }, ...sp.lib].map(tile));
  li.append(g); ul.replaceChildren(li); ul.scrollTop = 0;
}
async function openSpList(p) {
  const seq = ++state.searchSeq; skeleton();
  try {
    const songs = p.id === 'liked' ? await sp.liked() : await sp.playlistTracks(p.id);
    if (seq !== state.searchSeq) return;
    state.album = { sp: true, name: p.name, artist: 'Spotify', art: p.art || '', year: '', back: '', songs };
    state.query = ''; state.failed = false; renderList();
  } catch (e) {
    if (seq !== state.searchSeq) return;
    toast(/403/.test(e.message) ? 'Spotify only shares playlists you made or collaborate on.' : 'Could not load that playlist.');
    renderList();
  }
}
async function search(q) {
  q = q.trim(); state.query = q;
  const seq = ++state.searchSeq; state.album = null;
  if (state.src !== 'liked') skeleton();
  const [a, s] = await Promise.allSettled([q ? searchApple(q) : trending(state.genre), q && sp.connected() ? searchSpotify(q) : Promise.resolve([])]);
  if (seq !== state.searchSeq) return;
  state.results.apple = a.status === 'fulfilled' ? a.value : [];
  state.results.spotify = s.status === 'fulfilled' ? s.value : [];
  state.failed = a.status === 'rejected' && !state.results.spotify.length;
  renderList();
}
function currentList() {
  const { apple, spotify } = state.results;
  if (state.src === 'liked') return state.likes;
  if (state.src === 'apple') return apple;
  if (state.src === 'spotify') return state.album && state.album.sp ? state.album.songs : spotify;
  const [first, second] = state.primary === 'spotify' ? [spotify, apple] : [apple, spotify];
  const out = [];
  for (let i = 0; i < Math.max(first.length, second.length); i++) { if (first[i]) out.push(first[i]); if (second[i]) out.push(second[i]); }
  return out;
}
function renderList() {
  const ul = $('tracks');
  state.list = currentList();
  syncTabs();
  const g = GENRES.find((x) => x[1] === state.genre);
  const album = state.album && (state.album.sp ? state.src === 'spotify' : state.src !== 'liked' && state.src !== 'spotify') ? state.album : null;
  $('listTitle').textContent = state.src === 'liked' ? 'Liked songs' : album ? (album.sp ? 'PLAYLIST' : 'ALBUM') :
    state.query ? 'Results' : state.src === 'spotify' ? 'Your Spotify' : state.src === 'apple' ? 'Top charts' + (g && g[1] ? ' \u00b7 ' + g[0] : '') : 'Trending now';
  $('listTitle').classList.toggle('big', !album);
  const personal = state.src === 'all' && !state.query && !album && (sp.connected() || state.likes.length > 0 || store.get('hist', []).length > 0);
  $('genres').hidden = !!state.query || !!album || !(state.src === 'apple' || (state.src === 'all' && !personal));
  if (state.src === 'spotify' && !sp.connected()) {
    ul.replaceChildren(infoCard('Bring in your Spotify', 'Your playlists and liked songs show up here once you connect. It takes about two minutes, and Spotify needs your account to have Premium.', 'Connect Spotify', connectSpotify, SP_ICON));
    return;
  }
  if (state.src === 'spotify' && !state.query && !album) return void renderSpLib(ul);
  if (personal) return void renderHome(ul);
  if (!state.list.length && state.src === 'liked') {
    ul.replaceChildren(infoCard('No liked songs yet', 'Tap the heart on any song and it lands here, ready to play or shuffle.', null, null, HEART));
    return;
  }
  if (!state.list.length) {
    ul.replaceChildren(el('li', 'msg',
      state.src === 'liked' ? 'Nothing liked yet. Tap the heart on a song to save it here.' :
      state.failed ? 'Could not load songs. Check your connection and try again.' :
      state.src === 'spotify' && !state.query ? 'Search for something to see Spotify results.' : 'No songs found. Try a different search.'));
    return;
  }
  const chart = !state.query && !album && (state.src === 'all' || state.src === 'apple');
  const play = (i) => () => { if (state.query) addRecent(state.query); state.queue = state.list; state.forced = 0; playIndex(i); setView('player'); };
  const rows = state.list.map((t, i) => {
    const li = trackRow(t, { rank: chart || album ? i + 1 : 0, onPlay: play(i), actions: true });
    li.style.setProperty('--i', Math.min(i, 14)); return li;
  });
  if (chart && state.list.length >= 6) { // top of the chart as a row of big covers
    const hero = el('li', 'hero'), sc = el('div', 'hero-row');
    state.list.slice(0, 8).forEach((t, i) => {
      const c = el('button', 'card'); c.type = 'button';
      const im = el('img'); im.src = artAt(t, 300); im.alt = ''; im.loading = i < 4 ? 'eager' : 'lazy'; im.draggable = false;
      const cap = el('span'); cap.append(el('i', null, '#' + (i + 1)), el('b', null, t.title), el('small', null, t.artist));
      c.append(im, cap); c.onclick = play(i); sc.append(c);
    });
    hero.append(sc); rows.unshift(hero);
  }
  if (state.query && !album && state.list.length > 1) { // the best match as a big card
    const t = state.list[0], li = el('li', 'top-hit'), b = el('button'); b.type = 'button';
    const im = el('img'); im.src = artAt(t, 300); im.alt = ''; im.draggable = false;
    const d = el('span'); d.append(el('small', null, 'Top result'), el('b', null, t.title), el('i', null, t.artist + ' \u00b7 ' + SRC_LABEL[t.src]));
    const go = el('em'); go.innerHTML = PLAY_SVG;
    b.append(im, d, go); b.onclick = play(0); li.append(b);
    rows.splice(0, 1, li, el('li', 'list-title sub', 'Songs'));
  }
  if (album) {
    const li = el('li', 'album-head'), d = el('div');
    const im = el('img'); if (album.art) im.src = album.art.replace('600x600bb', '300x300bb'); im.alt = ''; im.draggable = false;
    const back = el('button', 'act', '\u2039 Back'); back.type = 'button';
    back.onclick = () => { $('q').value = album.back; $('qClear').hidden = !album.back; search(album.back); };
    d.append(el('small', null, [album.year, state.list.length + (state.list.length === 1 ? ' song' : ' songs')].filter(Boolean).join(' \u00b7 ')),
      el('b', null, album.name), el('span', 'by', album.artist), actsRow(back));
    li.append(im, d); rows.unshift(li);
  } else if (state.src === 'liked') {
    const n = state.list.length, li = el('li', 'album-head liked-head'), d = el('div'), pic = el('span', 'pic'); pic.innerHTML = HEART;
    d.append(el('small', null, 'Playlist'), el('b', null, n + (n === 1 ? ' song you love' : ' songs you love')), el('span', 'by', 'Saved in this app'), actsRow());
    li.append(pic, d); rows.unshift(li);
  }
  ul.replaceChildren(...rows);
  ul.scrollTop = 0;
}
// "All" home: built from the user's own music (Spotify playlists and likes, what they played here), not the charts.
const home = { seq: 0, recs: new Map() };
const mainArtist = (t) => t.artist.split(/,| & | feat/i)[0].trim();
function topArtists(extra) {
  const cnt = new Map();
  [...store.get('hist', []), ...state.likes, ...(extra || [])].forEach((t) => { if (t && t.artist) { const a = mainArtist(t); cnt.set(a, (cnt.get(a) || 0) + 1); } });
  return [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]);
}
async function recsFor(artist, skip) {
  if (!home.recs.has(artist)) {
    try { home.recs.set(artist, (await searchApple(artist)).filter((t) => t.artist.toLowerCase().includes(artist.toLowerCase()))); }
    catch { return []; }
  }
  return home.recs.get(artist).filter((t) => !skip.has(t.title.toLowerCase())).slice(0, 5);
}
async function renderHome(ul) {
  const seq = ++home.seq, here = () => seq === home.seq && state.src === 'all' && !state.query && !state.album;
  const spOk = sp.connected() && /user-library-read/.test(store.get('sp.scope', ''));
  const hist = store.get('hist', []).filter((t) => t && SRC_LABEL[t.src]);
  const hr = new Date().getHours();
  $('listTitle').textContent = hr < 5 ? 'Late night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  $('listTitle').classList.add('big');
  const title = (s) => el('li', 'list-title sub', s);
  const covers = (cls, items) => { const li = el('li', 'hero ' + cls), sc = el('div', 'hero-row'); sc.append(...items); li.append(sc); return li; };
  const cover = (art, name, onPick, heart) => {
    const c = el('button', 'card'); c.type = 'button';
    if (heart) { const h = el('em'); h.innerHTML = HEART; c.append(h); } else if (art) { const im = el('img'); im.src = art; im.alt = ''; im.loading = 'lazy'; im.draggable = false; c.append(im); }
    const cap = el('span'); cap.append(el('b', null, name)); c.append(cap); c.onclick = onPick; return c;
  };
  const paint = (mix, recs, loading) => {
    const rows = [], songs = [];
    const add = (t) => {
      const i = songs.length; songs.push(t);
      const li = trackRow(t, { onPlay: () => { state.queue = songs; state.forced = 0; playIndex(i); setView('player'); }, actions: true });
      li.style.setProperty('--i', Math.min(i, 14)); rows.push(li);
    };
    if (hist.length) { // bento: the last song big, the few before it as shortcut tiles
      const pick = (i) => () => { state.queue = hist; state.forced = 0; playIndex(i); setView('player'); };
      const li = el('li', 'bento'), t0 = hist[0], big = el('button', 'b-big'); big.type = 'button';
      const im = el('img'); im.src = artAt(t0, 600); im.alt = ''; im.draggable = false;
      const cap = el('span'); cap.append(el('small', 'k', 'Pick up where you left off'), el('b', null, t0.title), el('small', null, t0.artist));
      const go = el('em'); go.innerHTML = '<svg viewBox="0 0 24 24" class="solid"><path d="M8 5v14l11-7z"/></svg>';
      big.append(im, cap, go); big.onclick = pick(0); li.append(big);
      const rest = hist.slice(1, 5), n = rest.length - rest.length % 2;
      rest.slice(0, n).forEach((t, k) => {
        const b = el('button', 'b-tile'); b.type = 'button';
        const i2 = el('img'); i2.src = artAt(t, 200); i2.alt = ''; i2.loading = 'lazy'; i2.draggable = false;
        b.append(i2, el('b', null, t.title)); b.onclick = pick(k + 1); li.append(b);
      });
      rows.push(li);
    }
    if (spOk) {
      const open = (p) => () => { $('chips').querySelector('[data-src="spotify"]').click(); openSpList(p); };
      if (sp.lib) rows.push(title('Your playlists'), covers('pls', [cover('', 'Liked Songs', open({ id: 'liked', name: 'Liked Songs' }), true), ...sp.lib.map((p) => cover(p.art, p.name, open(p)))]));
      if (mix && mix.length) { rows.push(title('From your playlists')); const a = el('li', 'list-acts'); a.append(actsRow()); rows.push(a); mix.forEach(add); }
    } else {
      rows.push(infoCard('Make this page yours', 'Connect Spotify and your playlists and liked songs show up right here.', sp.connected() ? 'Reconnect Spotify' : 'Connect Spotify',
        () => { const id = store.get('sp.cid'); if (sp.connected() && id) sp.login(id); else connectSpotify(); }, SP_ICON));
      if (state.likes.length) { rows.push(title('Your liked songs')); state.likes.slice(0, 6).forEach(add); }
    }
    (recs || []).forEach(([artist, list]) => { if (list.length) { rows.push(title('Because you play ' + artist)); list.forEach(add); } });
    if (loading) for (let i = 0; i < 4; i++) { const li = el('li', 'skel'); li.append(el('i'), el('span')); rows.push(li); }
    state.list = songs;
    ul.replaceChildren(...rows);
  };
  paint(sp.mixed, null, true); ul.scrollTop = 0;
  let mix = null;
  if (spOk) { try { mix = await sp.mix(); } catch {} if (!here()) return; }
  const skip = new Set([...(mix || []), ...(spOk ? [] : state.likes.slice(0, 6))].map((t) => t.title.toLowerCase()));
  const artists = topArtists(mix), recs = [];
  for (const a of artists) { const list = await recsFor(a, skip); list.forEach((t) => skip.add(t.title.toLowerCase())); recs.push([a, list]); }
  if (here()) paint(mix, recs, false);
}
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
const artAt = (t, n) => t.src === 'apple' ? (t.artBig || t.art || '').replace(/\/\d+x\d+bb/, '/' + n + 'x' + n + 'bb') : (t.artBig || t.art || '');
// One song row. With actions: a heart on the right, and press-and-hold (or right-click) lines the song up to play next.
function trackRow(t, { rank = 0, onPlay, actions = false }) {
  const li = el('li', 'row');
  const b = el('button', 'track' + (state.track && state.track.id === t.id ? ' on' : '')); b.type = 'button'; b.dataset.id = t.id;
  if (rank) b.append(el('span', 'rank', rank));
  let img;
  if (t.art) { img = el('img'); img.src = t.art; img.alt = ''; img.loading = 'lazy'; img.draggable = false; } else img = el('span', 'ph');
  const d = el('div');
  d.append(el('b', null, t.title), el('small', null, t.artist + ' · ' + SRC_LABEL[t.src]));
  const eq = el('span', 'eq'); eq.append(el('i'), el('i'), el('i'));
  b.append(img, d, eq);
  if (t.dur) b.append(el('span', 'len', fmt(t.dur)));
  let held = false, timer = null, sx = 0, sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  b.onclick = () => { if (held) { held = false; return; } onPlay(); };
  li.append(b);
  if (!actions) return li;
  li.classList.add('acts');
  const h = el('button', 'row-like'); h.type = 'button'; h.dataset.id = t.id; h.innerHTML = HEART;
  h.setAttribute('aria-label', 'Like ' + t.title); h.setAttribute('aria-pressed', String(state.likes.some((x) => x.id === t.id)));
  h.onclick = () => toggleLike(t);
  li.append(h);
  b.addEventListener('pointerdown', (e) => {
    held = false; clear();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { timer = null; held = true; playNext(t); }, 520);
  });
  b.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) clear(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => b.addEventListener(ev, clear));
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!held) playNext(t); });
  return li;
}
const PLAY_SVG = '<svg viewBox="0 0 24 24" class="solid"><path d="M8 5v14l11-7z"/></svg>';
function infoCard(title, text, btnLabel, onBtn, icon) {
  const li = el('li', 'connect big');
  if (icon) { const i = el('span', 'ic'); i.innerHTML = icon; li.append(i); }
  li.append(el('b', null, title), el('p', null, text));
  if (btnLabel) { const b = el('button', 'act main', btnLabel); b.type = 'button'; b.onclick = onBtn; li.append(b); }
  return li;
}
const SP_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M7.5 9.5c3-1 6.5-.7 9 .8M8 12.6c2.5-.7 5.2-.4 7.2.8M8.6 15.4c2-.5 4-.3 5.6.6"/></svg>';
function connectSpotify() { openSettings(); setTimeout(() => $('clientId').scrollIntoView({ block: 'center', behavior: 'smooth' }), 120); }
function syncTabs() {
  const ti = ['all', 'apple', 'spotify', 'liked'].indexOf(state.src);
  $('tabbar').style.setProperty('--ti', Math.max(0, ti));
  $('chips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x.dataset.src === state.src));
  document.querySelectorAll('#tabbar button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.src === state.src)));
}
function toggleLike(t) {
  const i = state.likes.findIndex((x) => x.id === t.id), on = i < 0;
  if (on) state.likes.unshift(t); else state.likes.splice(i, 1);
  store.set('likes', state.likes);
  if (state.track && state.track.id === t.id) $('like').setAttribute('aria-pressed', String(on));
  document.querySelectorAll('.row-like').forEach((h) => { if (h.dataset.id === t.id) h.setAttribute('aria-pressed', String(on)); });
  if (on && state.track && state.track.id === t.id) { const h = el('span', 'burst'); h.innerHTML = HEART; $('art').append(h); setTimeout(() => h.remove(), 900); }
  if (on) buzz();
  toast(on ? 'Added to Liked' : 'Removed from Liked');
  if (state.src === 'liked') renderList();
}
// Put a song right after the current one (after any others already lined up).
function playNext(t) {
  if (!state.track) { state.queue = [t]; state.forced = 0; playIndex(0); return; }
  if (t.id === state.track.id) return;
  const q = state.queue.filter((x) => x.id !== t.id), at = q.findIndex((x) => x.id === state.track.id);
  state.forced = Math.min(state.forced, q.length - 1 - at);
  q.splice(at + 1 + state.forced, 0, t);
  state.queue = q; state.index = at; state.forced++; state.shufNext = null; buzz();
  store.set('last', { queue: q.slice(0, 60), index: Math.max(at, 0) });
  toast('Playing next: ' + t.title);
  renderQueue();
}
// The song the next button will play (shuffle picks ahead so "Up next" is always true).
function nextIndex() {
  const n = state.queue.length; if (!n) return -1;
  if (state.forced > 0 || !state.shuffle || n < 2) return (state.index + 1) % n;
  if (state.shufNext == null || state.shufNext >= n || state.shufNext === state.index) {
    do { state.shufNext = Math.floor(Math.random() * n); } while (state.shufNext === state.index);
  }
  return state.shufNext;
}
// "Up next" card under the controls (portrait phones): the next few songs.
function renderNextUp() {
  { // cover flow: the previous and next covers stand at an angle beside the current one
    const m = state.queue.length, flow = !!state.track && m > 1;
    const bg = (t) => t && (t.artBig || t.art) ? 'url("' + artAt(t, 300) + '")' : 'none';
    $('artWrap').classList.toggle('flow', flow);
    if (flow) { $('sideNext').style.backgroundImage = bg(state.queue[nextIndex()]); $('sidePrev').style.backgroundImage = bg(state.queue[(state.index - 1 + m) % m]); }
  }
  const n = state.queue.length, items = [], random = state.shuffle && !state.forced;
  if (state.track && n > 1) {
    const first = nextIndex();
    for (let k = 1; k <= (random ? 1 : 3) && k < n; k++) {
      const i = random ? first : (state.index + k) % n;
      items.push(trackRow(state.queue[i], { onPlay: () => { state.forced = Math.max(0, state.forced - k); playIndex(i); $('player').scrollTo({ top: 0, behavior: 'smooth' }); } }));
    }
  }
  $('upCard').hidden = !items.length; $('upList').replaceChildren(...items);
  $('upNote').textContent = random ? 'Shuffle on' : '';
}
// Lyrics card under the controls (portrait phones): the line being sung and the two after it.
function renderLyCard() {
  const ly = state.lyrics; let rows;
  if (!ly) rows = [[$('lines').textContent.trim() || 'Lyrics show up here when a song plays.', 'dim']];
  else if (ly.plain) rows = ly.plain.filter(Boolean).slice(0, 3).map((s) => [s, 'dim']);
  else if (state.offset === null) rows = [['Tap here and pick the line you hear. The lyrics follow along from there.', 'dim']];
  else { const i = Math.max(state.lineIdx, 0); rows = ly.synced.slice(i, i + 3).map((l, k) => [l.text, k === 0 && state.lineIdx >= 0 ? 'cur' : 'dim']); }
  $('lyMini').replaceChildren(...rows.map(([s, c]) => el('p', c, s)));
}
function renderQueue() {
  renderNextUp();
  const ul = $('queue'); if (ul.hidden) return;
  const n = state.queue.length, items = [];
  for (let k = 1; k < n && items.length < 40; k++) {
    const i = (state.index + k) % n;
    const li = trackRow(state.queue[i], { onPlay: () => { state.forced = Math.max(0, state.forced - k); playIndex(i); } });
    li.style.setProperty('--i', Math.min(k - 1, 14)); items.push(li);
  }
  const note = !state.track ? 'Play a song and what comes after it shows up here.' :
    !items.length ? 'Nothing else is lined up. Press and hold a song in the list to play it next.' :
    state.shuffle && !state.forced ? 'Shuffle is on, so songs play in a random order from these.' : 'Press and hold a song in the list to play it next.';
  ul.replaceChildren(el('li', 'msg', note), ...items);
  ul.scrollTop = 0;
}
function setTab(tab) {
  state.tab = tab; store.set('tab', tab);
  document.querySelectorAll('#sideTabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  $('lines').hidden = tab !== 'lyrics'; $('lyHint').hidden = tab !== 'lyrics'; $('queue').hidden = tab !== 'queue';
  state.lineIdx = -2;
  renderQueue();
}
function addRecent(q) {
  q = q.trim(); if (!q) return;
  store.set('recent', [q, ...store.get('recent', []).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6));
}
function renderRecents(leaving) {
  const box = $('recents'), list = store.get('recent', []);
  const show = !leaving && document.activeElement === $('q') && !$('q').value.trim() && list.length > 0;
  box.hidden = !show; if (!show) return;
  const chips = list.map((s) => { const c = el('button', 'chip', s); c.type = 'button'; c.onclick = () => { $('q').value = s; $('qClear').hidden = false; $('q').blur(); box.hidden = true; search(s); }; return c; });
  const x = el('button', 'chip clear', 'Clear'); x.type = 'button'; x.onclick = () => { store.del('recent'); renderRecents(); };
  box.replaceChildren(...chips, x);
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
// Find the same song on Spotify so an Apple chart/search result can play in full when Spotify is the primary service.
async function spotifyMatch(t) {
  try {
    const hits = await searchSpotify(t.title + ' ' + t.artist.split(/,| & /)[0]);
    const hit = (t.dur && hits.find((h) => Math.abs(h.dur - t.dur) < 4)) || hits[0];
    return hit ? hit.uri : null;
  } catch { return null; }
}
async function playIndex(i) {
  const t = state.queue[i]; if (!t) return;
  const seq = ++state.playSeq;
  state.index = i; state.track = t; state.offset = t.full ? 0 : null; state.lineIdx = -2; state.shufNext = null;
  store.set('last', { queue: state.queue.slice(0, 60), index: i });
  store.set('hist', [t, ...store.get('hist', []).filter((x) => x.id !== t.id)].slice(0, 12));
  showTrack(t); loadLyrics(t, seq); renderQueue();
  document.querySelectorAll('.track').forEach((b) => b.classList.toggle('on', b.dataset.id === t.id));

  if (sp.ready && (t.src === 'spotify' || state.primary === 'spotify')) {
    if (!t.uri) { t.uri = await spotifyMatch(t); if (seq !== state.playSeq) return; }
    if (t.uri) {
      audio.pause(); state.backend = 'spotify'; state.offset = 0;
      $('mode').textContent = 'Full song · Spotify';
      try { await sp.play(t.uri); return; } catch (e) { toast('Spotify playback failed, using a preview instead.'); }
      if (seq !== state.playSeq) return;
    }
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
  const i = d > 0 ? nextIndex() : (state.index - 1 + n) % n;
  if (d > 0 && state.forced > 0) state.forced--;
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
  if (state.backend === 'spotify') { sp.player.seek(s * 1000); sp.st.pos = s * 1000; sp.st.ts = Date.now(); mv.seek(s); }
  else if (dur()) audio.currentTime = Math.min(s, dur() - 0.2);
}
function setPlayingUI() {
  const p = isPlaying(), d = p ? 'M7 5h2.5v14H7zM14.5 5H17v14h-2.5z' : 'M8 5v14l11-7z';
  $('playIcon').setAttribute('d', d); $('miniIcon').setAttribute('d', d);
  $('play').setAttribute('aria-label', p ? 'Pause' : 'Play'); $('miniPlay').setAttribute('aria-label', p ? 'Pause' : 'Play');
  document.body.classList.toggle('is-playing', p);
  if (typeof mv !== 'undefined') mv.sync();
  if ('mediaSession' in navigator && state.track) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
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
  const sa = el('span', null, t.artist); sa.dataset.act = 'artist';
  const kids = [sa];
  if (t.album) { const sb = el('span', null, t.album); sb.dataset.act = 'album'; kids.push(' · ', sb); }
  $('sub').replaceChildren(...kids);
  requestAnimationFrame(() => { // long titles slide back and forth instead of being cut off
    const s = $('title'), h = s.parentNode, over = s.offsetWidth - h.clientWidth;
    h.classList.toggle('marq', over > 6);
    h.style.setProperty('--mq', -(over + 34) + 'px'); h.style.setProperty('--mqd', Math.max(5, over / 22 + 4) + 's');
  });
  $('miniTitle').textContent = t.title; $('miniSub').textContent = t.artist; $('miniArt').src = t.art || ''; $('mini').hidden = false;
  const img = $('artImg');
  if (t.artBig) { img.classList.remove('swap'); void img.offsetWidth; img.src = t.artBig; img.hidden = false; img.classList.add('swap'); tint(t.art || t.artBig); } else img.hidden = true;
  document.title = t.title + ' · ' + t.artist;
  root.style.setProperty('--art', t.artBig || t.art ? 'url("' + artAt(t, 300) + '")' : 'none');
  const mt = document.querySelector('.meta-text'); mt.classList.remove('in'); void mt.offsetWidth; mt.classList.add('in');
  wave.seed(t);
  if (typeof mv !== 'undefined') mv.load(t);
  $('like').setAttribute('aria-pressed', String(state.likes.some((x) => x.id === t.id)));
  const q = encodeURIComponent(t.title + ' ' + t.artist);
  const links = [
    ['Apple Music', t.src === 'apple' ? t.link : 'https://music.apple.com/us/search?term=' + q],
    ['Spotify', t.src === 'spotify' ? t.link : 'https://open.spotify.com/search/' + q],
  ];
  if (state.primary === 'spotify') links.reverse();
  const share = el('button', null, navigator.share ? 'Share' : 'Copy link'); share.type = 'button';
  share.onclick = async () => {
    const url = links[0][1];
    try {
      if (navigator.share) await navigator.share({ title: t.title, text: t.title + ' · ' + t.artist, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied.'); }
    } catch {}
  };
  $('openIn').replaceChildren(...links.map(([n, h]) => { const a = el('a', null, 'Open in ' + n); a.href = h; a.target = '_blank'; a.rel = 'noopener'; return a; }), share);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: artSizes(t) });
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
    ms.setActionHandler('stop', () => { if (isPlaying()) togglePlay(); });
    const posState = () => { try { if (dur()) ms.setPositionState({ duration: dur(), position: Math.min(pos(), dur()), playbackRate: 1 }); } catch {} };
    ['loadedmetadata', 'seeked', 'play', 'pause', 'ratechange'].forEach((ev) => audio.addEventListener(ev, posState));
  } catch {}
}
// Artwork in several sizes so car screens, the lock screen and Control Center each get a sharp one.
function artSizes(t) {
  if (!t.artBig) return [];
  if (t.src !== 'apple') return [{ src: t.artBig, sizes: '640x640' }];
  return [128, 256, 512, 1024].map((n) => ({ src: t.artBig.replace(/\/\d+x\d+bb/, '/' + n + 'x' + n + 'bb'), sizes: n + 'x' + n, type: 'image/jpeg' }));
}
// Recolor the glow, and the accent colors when that setting is on, from the artwork.
const ART_VARS = ['--glow-a', '--glow-b', '--pink', '--cyan', '--violet'];
function clearArt() { ART_VARS.forEach((p) => root.style.removeProperty(p)); viz.readColors(); wave.draw(wave.pct); }
let tintSeq = 0;
function tint(url) {
  const seq = ++tintSeq;
  if (root.dataset.theme === 'mono' || !url) return clearArt();
  const im = new Image(); im.crossOrigin = 'anonymous';
  im.onload = () => {
    if (seq !== tintSeq) return;
    try {
      const N = 16, c = document.createElement('canvas'); c.width = c.height = N;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, N, N);
      const d = x.getImageData(0, 0, N, N).data, bins = new Float32Array(24); let total = 0;
      for (let i = 0; i < d.length; i += 4) { // which hues carry the most color
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn, l = (mx + mn) / 2;
        if (dl < 0.1 || l < 0.1 || l > 0.94) continue;
        let h = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
        h = (h * 60 + 360) % 360;
        bins[Math.floor(h / 15) % 24] += dl * dl; total += dl * dl;
      }
      if (total < 1.2) return clearArt(); // near-grey art: theme colors
      let a = 0, b2 = -1;
      for (let k = 1; k < 24; k++) if (bins[k] > bins[a]) a = k;
      for (let k = 0; k < 24; k++) { const far = Math.min(Math.abs(k - a), 24 - Math.abs(k - a)) >= 3; if (far && (b2 < 0 || bins[k] > bins[b2])) b2 = k; }
      const h1 = a * 15 + 7, two = bins[b2] > bins[a] * 0.18, h2 = two ? b2 * 15 + 7 : (h1 + 40) % 360;
      const lift = (h) => h > 215 && h < 290 ? 8 : 0; // blues and purples need to be lighter to read on dark
      root.style.setProperty('--glow-a', `hsl(${h1} 72% 42%)`);
      root.style.setProperty('--glow-b', `hsl(${two ? h2 : (h1 + 150) % 360} 72% 36%)`);
      if (state.artColors) {
        root.style.setProperty('--pink', `hsl(${h1} 100% ${67 + lift(h1)}%)`);
        root.style.setProperty('--cyan', `hsl(${h2} 92% ${70 + lift(h2)}%)`);
        root.style.setProperty('--violet', `hsl(${h1} 66% ${50 + lift(h1)}%)`);
      } else ['--pink', '--cyan', '--violet'].forEach((p) => root.style.removeProperty(p));
      viz.readColors(); wave.draw(wave.pct);
    } catch {}
  };
  im.src = url;
}

/* ---------- themes ---------- */
const THEME_SW = { neon: ['#ff2fd0', '#29d8ff'], sunset: ['#ff5e3a', '#ffc531'], ocean: ['#2af5c1', '#1f8fff'], forest: ['#7dff6a', '#19b36b'], rose: ['#ff7aa8', '#ffd1b8'], mono: ['#ffffff', '#6c6c75'] };
const THEMES = Object.keys(THEME_SW);
function setTheme(name, announce) {
  root.dataset.theme = name; store.set('theme', name);
  ART_VARS.forEach((p) => root.style.removeProperty(p));
  if (state.track) tint(state.track.art || state.track.artBig);
  viz.readColors(); wave.draw(wave.pct);
  document.querySelectorAll('#swatches button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === name)));
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (announce) toast('Theme: ' + name[0].toUpperCase() + name.slice(1));
}
$('themeBtn').onclick = () => vt(() => setTheme(THEMES[(THEMES.indexOf(root.dataset.theme) + 1) % THEMES.length], true));

/* ---------- visualizer ---------- */
const viz = {
  c: $('viz'), n: 40, v: new Float32Array(40), analyser: null, data: null, blocked: false, colors: ['#ff2fd0', '#29d8ff'],
  readColors() { const s = getComputedStyle(root); this.colors = [s.getPropertyValue('--pink').trim(), s.getPropertyValue('--cyan').trim()]; stage.readColors(s); },
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
      const gap = l.text === '\u266a', b = el('button', 'line', gap ? null : l.text); b.type = 'button';
      if (gap) { b.dataset.gap = '1'; b.setAttribute('aria-label', 'Instrumental'); b.append(el('i'), el('i'), el('i')); }
      b.onclick = () => lineTap(i);
      return b;
    }));
  }
  box.scrollTop = 0;
  updateHint();
}
function lineTap(i) {
  const l = state.lyrics.synced[i];
  state.lyHold = 0; $('lines').classList.remove('browse');
  if (fullLen()) { seekTo(l.t); state.lineIdx = -2; return; }
  // Preview clips start somewhere mid-song: the tapped line tells us where.
  const first = state.offset === null;
  state.offset = l.t - pos();
  mv.seek(pos());
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
  renderLyCard();
}
function syncLyrics() {
  const ly = state.lyrics;
  if (!ly || !ly.synced || state.offset === null) return;
  const t = pos() + state.offset + 0.15;
  let idx = -1;
  for (let i = 0; i < ly.synced.length && ly.synced[i].t <= t; i++) idx = i;
  const box = $('lines'), kids = box.children;
  if (idx >= 0 && kids[idx]) { // light sweeps across the line being sung
    const a = ly.synced[idx].t, b = ly.synced[idx + 1] ? ly.synced[idx + 1].t : a + 5;
    kids[idx].style.setProperty('--lp', Math.round(Math.max(0, Math.min(1, (t + 0.2 - a) / Math.max(0.4, b - a))) * 100) + '%');
  }
  if (state.lyHold && Date.now() > state.lyHold) { state.lyHold = 0; box.classList.remove('browse'); state.lineIdx = -2; }
  if (idx === state.lineIdx) return;
  state.lineIdx = idx;
  for (let i = 0; i < kids.length; i++) {
    kids[i].className = 'line' + (i < idx ? ' past' : i === idx ? ' cur' : i === idx + 1 ? ' next' : '');
    kids[i].style.setProperty('--d', Math.min(6, Math.abs(i - Math.max(idx, 0))));
    kids[i].style.setProperty('--s', Math.max(-6, Math.min(6, i - Math.max(idx, 0)))); // which way the line leans on the wheel // lines further from the current one are softer
  }
  renderLyCard();
  const cur = kids[Math.max(idx, 0)];
  if (!cur || state.lyHold) return;
  const from = box.scrollTop, to = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2)), dy = to - from;
  const seen = !box.hidden && !(isPhone() && app.dataset.view !== 'lyrics');
  if (!seen || calm.matches || !cur.animate || Math.abs(dy) < 2 || Math.abs(dy) > box.clientHeight * 0.9) { box.scrollTo({ top: to, behavior: seen && !calm.matches ? 'smooth' : 'auto' }); return; }
  // Jump the scroll, then let each line glide up from where it was, one after another, so the lines follow like a wave.
  box.scrollTop = to;
  for (let i = Math.max(0, idx - 10); i <= Math.min(kids.length - 1, idx + 14); i++) {
    kids[i].animate([{ translate: '0 ' + dy + 'px' }, { translate: '0 0' }], { duration: 640, delay: Math.max(0, i - idx) * 38, easing: 'cubic-bezier(.22, 1.16, .36, 1)', fill: 'backwards' });
  }
  if (idx >= 0) { $('peek').textContent = ly.synced[idx].text; $('peek').classList.add('live'); }
}

/* ---------- floating widget (desktop: always-on-top mini player) ---------- */
const widget = {
  win: null, supported: 'documentPictureInPicture' in window,
  async toggle() {
    if (this.win) { this.win.close(); return; }
    let w;
    try { w = this.win = await documentPictureInPicture.requestWindow({ width: 340, height: 132 }); }
    catch { toast('Could not open the widget.'); return; }
    const d = w.document;
    const st = d.createElement('style');
    st.textContent = `
      *{box-sizing:border-box;margin:0}
      body{height:100vh;overflow:hidden;color:#f4eefc;font:13px/1.3 "Space Grotesk",system-ui,sans-serif;background:radial-gradient(120% 140% at 0 0,var(--a),transparent 60%),radial-gradient(120% 140% at 100% 100%,var(--b),transparent 60%),var(--bg);display:flex;flex-direction:column;justify-content:center;gap:8px;padding:10px 12px 12px}
      .row{display:flex;align-items:center;gap:10px;min-width:0}
      img{width:54px;height:54px;border-radius:9px;object-fit:cover;flex:none;background:linear-gradient(135deg,var(--pink),var(--cyan));box-shadow:0 6px 16px rgba(0,0,0,.45)}
      .t{min-width:0;flex:1}
      b,small,p{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      b{font-size:13px;font-weight:600} small{font-size:11px;opacity:.7}
      p{font-size:11px;color:var(--cyan);margin-top:3px;min-height:14px;text-shadow:0 0 10px var(--cyan)}
      .c{display:flex;gap:2px;flex:none}
      button{width:30px;height:30px;border:0;border-radius:50%;background:none;color:inherit;cursor:pointer;display:grid;place-items:center}
      button:hover{background:rgba(255,255,255,.12)} button:active{transform:scale(.88)}
      #wp{background:var(--violet);box-shadow:0 0 14px var(--cyan)}
      svg{width:16px;height:16px;fill:currentColor}
      .bar{height:3px;border-radius:3px;background:rgba(255,255,255,.16);overflow:hidden;cursor:pointer}
      .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--pink),var(--cyan))}`;
    d.head.append(st);
    d.body.innerHTML = '<div class="row"><img id="wa" alt=""><div class="t"><b id="wt"></b><small id="ws"></small><p id="wl"></p></div>' +
      '<div class="c"><button id="wb" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M7 6v12h2V6zM19 6 9.5 12l9.5 6z"/></svg></button>' +
      '<button id="wp" aria-label="Play"><svg viewBox="0 0 24 24"><path id="wi" d="M8 5v14l11-7z"/></svg></button>' +
      '<button id="wn" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M15 6v12h2V6zM5 6l9.5 6L5 18z"/></svg></button></div></div>' +
      '<div class="bar" id="wbar"><i id="wf"></i></div>';
    const q = (id) => d.getElementById(id);
    q('wb').onclick = () => step(-1); q('wn').onclick = () => step(1); q('wp').onclick = togglePlay;
    q('wbar').onclick = (e) => { const r = q('wbar').getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * dur()); state.lineIdx = -2; };
    w.addEventListener('pagehide', () => { this.win = null; $('popBtn').classList.remove('ok'); });
    $('popBtn').classList.add('ok');
    this.update(0);
  },
  update(pct) {
    const w = this.win; if (!w) return;
    const d = w.document, q = (id) => d.getElementById(id), t = state.track, cs = getComputedStyle(root), rs = d.documentElement.style;
    [['--a', '--glow-a'], ['--b', '--glow-b'], ['--bg', '--bg'], ['--pink', '--pink'], ['--cyan', '--cyan'], ['--violet', '--violet']].forEach(([k, v]) => rs.setProperty(k, cs.getPropertyValue(v).trim()));
    q('wt').textContent = t ? t.title : 'Nothing playing'; q('ws').textContent = t ? t.artist : 'Pick a song in the main window';
    const art = t && (t.art || t.artBig) || ''; if (q('wa').getAttribute('src') !== art) q('wa').setAttribute('src', art);
    const pk = $('peek'); q('wl').textContent = pk.classList.contains('live') ? pk.textContent : '';
    q('wi').setAttribute('d', isPlaying() ? 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z' : 'M8 5v14l11-7z');
    q('wf').style.width = pct + '%';
  },
};
if (widget.supported) { $('popBtn').hidden = false; $('popBtn').onclick = () => widget.toggle(); }

/* ---------- waveform scrubber (shape is made up per song, it is decoration) ---------- */
const wave = {
  c: $('wave'), bars: new Array(64).fill(0.3), pct: 0,
  seed(t) {
    let h = 2166136261;
    for (const ch of t.id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; h = (h ^ (h >>> 16)) >>> 0; return h / 4294967296; };
    let v = 0.5;
    this.bars = this.bars.map((_, i, a) => {
      v = Math.max(0.2, Math.min(1, v + (rnd() - 0.5) * 0.7));
      return v * Math.min(1, Math.min(i, a.length - 1 - i) / 5 + 0.45);
    });
    this.draw(this.pct);
  },
  draw(pct) {
    this.pct = pct;
    const c = this.c, dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const x = c.getContext('2d'), n = this.bars.length, bw = w / n;
    x.clearRect(0, 0, w, h);
    const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, viz.colors[0]); g.addColorStop(1, viz.colors[1]);
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2 * dpr, this.bars[i] * h * 0.9);
      x.fillStyle = ((i + 0.5) / n) * 100 <= pct ? g : 'rgba(255,255,255,.2)';
      x.beginPath(); x.roundRect(i * bw + bw * 0.22, (h - bh) / 2, bw * 0.56, bh, bw * 0.28); x.fill();
    }
  },
};


/* ---------- living background: a small shader scene drawn on the graphics chip, colored by the theme or the album art ---------- */
const stage = {
  c: $('stage'), gl: null, scene: store.get('scene', 4), t: 0, last: 0, e: 0, frame: 0, u: {},
  NAMES: ['Off', 'Sunset', 'Aurora', 'Tunnel', 'Music video'],
  col: [[1, 0.18, 0.82], [0.16, 0.85, 1], [0.48, 0.24, 1]], tgt: [[1, 0.18, 0.82], [0.16, 0.85, 1], [0.48, 0.24, 1]],
  FRAG: `precision highp float;
uniform vec2 r; uniform float t, e, sc; uniform vec3 a, b, c;
const vec3 NIGHT = vec3(.02, .01, .05);
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0., s = .5; for (int i = 0; i < 4; i++) { v += s * n(p); p = p * 2.03 + vec2(1.7, 9.2); s *= .5; } return v; }
vec3 sunset(vec2 uv) {
  float hz = mix(-.08, .12, step(r.x, r.y)); vec3 col; // taller screens: raise the horizon so the sun clears the cover
  if (uv.y > hz) {
    float y = uv.y - hz;
    col = mix(c * .5, NIGHT, smoothstep(0., 1., y));
    vec2 g = floor(uv * 42.); float st = step(.985, h(g)) * smoothstep(.22, .04, length(fract(uv * 42.) - .5));
    col += st * (.4 + .6 * sin(t * 2. + h(g + 1.) * 6.28)) * smoothstep(.15, .7, y) * .7;
    vec2 sp = uv - vec2(0., hz + .44);
    float d = length(sp), R = .34 + e * .025;
    float sun = smoothstep(R, R - .012, d);
    float gap = clamp((.15 - sp.y / R) * .5, 0., .7);
    float bars = smoothstep(gap - .04, gap + .04, fract(sp.y * 9. - t * .25));
    col = mix(col, mix(a, b, clamp(sp.y / R * .5 + .5, 0., 1.)), sun * bars);
    col += mix(a, b, .3) * .3 * exp(-3.5 * max(d - R, 0.)) * (1. + e);
  } else {
    float y = hz - uv.y, z = .25 / (y + .02);
    vec2 gp = vec2(uv.x * z * 2., z * 2. - t * 1.6), gl = abs(fract(gp) - .5);
    float w = min(.3, .035 + z * .012);
    float line = smoothstep(.5 - w, .5, max(gl.x, gl.y));
    col = NIGHT + mix(a, c, .3) * line * exp(-z * .13) * (.8 + e * .7);
    col += a * .35 * exp(-y * 9.) * (1. + e * .5);
  }
  return col;
}
vec3 aurora(vec2 uv) {
  vec2 p = uv * 1.2; float tt = t * .12;
  vec2 q = vec2(fbm(p + tt), fbm(p + vec2(5.2, 1.3) - tt));
  float f = fbm(p + 2.5 * q + vec2(0., tt * 2.));
  vec3 col = mix(NIGHT, c, smoothstep(.2, .8, f) * .7);
  col = mix(col, a, smoothstep(.45, .95, q.x * f * 2.) * .8);
  col = mix(col, b, smoothstep(.5, 1., q.y * f * 2.2) * .7);
  float rb = abs(sin((uv.y + f * 1.2) * 6. + t * .4));
  col += b * pow(1. - rb, 8.) * .35 * (1. + e * 1.5);
  return col * (.75 + e * .35);
}
vec3 tunnel(vec2 uv) {
  float d = length(uv) + .001, an = atan(uv.y, uv.x), z = .6 / d + t * .8;
  float tw = an / 6.2832 * 12. + sin(z * .5);
  float rings = smoothstep(.4, .5, abs(fract(z * 1.5) - .5)), spokes = smoothstep(.44, .5, abs(fract(tw) - .5));
  vec3 col = (mix(a, b, .5 + .5 * sin(z * .7)) * rings + c * spokes * .6) * smoothstep(.02, .5, d) * (.7 + e * .8);
  col += mix(b, a, .5) * .3 * exp(-d * 5.) * (1. + e * 2.);
  return col + NIGHT;
}
void main() {
  vec2 uv = (gl_FragCoord.xy * 2. - r) / r.y;
  vec3 col = sc < .5 ? sunset(uv) : sc < 1.5 ? aurora(uv) : tunnel(uv);
  col *= 1. - .22 * dot(uv * .5, uv * .5);
  gl_FragColor = vec4(col, 1.);
}`,
  init() {
    try {
      const gl = this.c.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
      if (!gl) return;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }'));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, this.FRAG));
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(p);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      ['r', 't', 'e', 'sc', 'a', 'b', 'c'].forEach((k) => { this.u[k] = gl.getUniformLocation(p, k); });
      this.gl = gl;
      this.c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; this.apply(); });
    } catch (err) { this.gl = null; }
  },
  px: document.createElement('canvas').getContext('2d', { willReadFrequently: true }),
  readColors(cs) {
    ['--pink', '--cyan', '--violet'].forEach((k, i) => {
      try {
        this.px.clearRect(0, 0, 1, 1); this.px.fillStyle = '#000'; this.px.fillStyle = cs.getPropertyValue(k).trim(); this.px.fillRect(0, 0, 1, 1);
        const d = this.px.getImageData(0, 0, 1, 1).data; this.tgt[i] = [d[0] / 255, d[1] / 255, d[2] / 255];
      } catch {}
    });
  },
  apply() {
    const on = this.scene > 0 && (!!this.gl || mv.ok);
    document.body.classList.toggle('has-stage', on);
    document.body.classList.toggle('has-video', this.scene === 4 && mv.ok);
    document.body.classList.toggle('scene-video', this.scene === 4);
    document.querySelectorAll('#sceneSeg button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.n === this.scene)));
  },
  set(n, announce) {
    this.scene = this.gl || n === 4 ? n : 0; store.set('scene', n);
    if (n === 4) mv.load(state.track); else mv.stop();
    this.apply();
    if (announce) toast(this.gl || n === 4 ? 'Background: ' + this.NAMES[n] : 'This device cannot draw the animated backgrounds.');
  },
  draw(ts) {
    requestAnimationFrame((x) => this.draw(x));
    const gl = this.gl;
    let sc = this.scene;
    if (sc === 4) { if (mv.ok) return; sc = 1; } // no music video for this song: show the sunset instead
    if (!gl || !sc || document.hidden) return;
    if (!finePointer && (this.frame++ & 1)) return; // every other frame on phones, to go easy on the battery
    const dt = Math.min(0.1, (ts - this.last) / 1000 || 0); this.last = ts;
    const playing = isPlaying();
    this.t += dt * (playing ? 1 : 0.25);
    let target = 0;
    if (playing) {
      if (viz.analyser && state.backend === 'audio') { let s = 0; for (let i = 1; i < 9; i++) s += viz.data[i]; target = Math.min(1, s / 8 / 210); }
      else target = Math.pow(0.5 + 0.5 * Math.sin(ts / 1000 * Math.PI * 4), 6) * 0.9; // steady pulse where the real sound cannot be read
    }
    this.e += (target - this.e) * 0.25;
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) this.col[i][k] += (this.tgt[i][k] - this.col[i][k]) * 0.05;
    const q = Math.min(2, devicePixelRatio || 1) * (finePointer ? 0.75 : 0.5), w = Math.round(innerWidth * q), h = Math.round(innerHeight * q);
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(this.u.r, w, h); gl.uniform1f(this.u.t, this.t % 3600); gl.uniform1f(this.u.e, this.e); gl.uniform1f(this.u.sc, sc - 1);
    gl.uniform3fv(this.u.a, this.col[0]); gl.uniform3fv(this.u.b, this.col[1]); gl.uniform3fv(this.u.c, this.col[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },
};
stage.init();
// Accept video links from supported YouTube hosts.
function youtubeId(link) {
  try {
    const url = new URL(link);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^(www\.|m\.)/, '');
    let id;
    if (host === 'youtu.be') id = url.pathname.slice(1);
    if (['youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)$/)?.[1];
    }
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

// Normalize catalog punctuation while preserving non-Latin artist and song names.
function videoWords(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function videoTitle(title) {
  return title.replace(/\s+[(\[](?:feat\.?|ft\.?|with\b|from\b|live\b|remaster|radio edit|official video)[^\])]*[\])]\s*$/i, '').trim();
}
function videoArtistMatches(credit, artist) {
  const name = videoWords(credit);
  if (!name) return false;
  // Try complete names first so groups such as Mumford & Sons keep their identity.
  const parts = artist.split(/\s+(?:&|feat\.?|featuring|with)\s+|,\s+/i);
  return parts.some((_, i) => videoWords(parts.slice(0, i + 1).join(' & ')) === name) ||
    videoWords(artist) === name;
}

async function audioDBVideo(track, signal) {
  const title = videoTitle(track.title);
  for (const artist of new Set([track.artist, mainArtist(track)])) {
    const data = await videoJSON('https://www.theaudiodb.com/api/v1/json/123/searchtrack.php',
      { s: artist, t: title }, signal);
    if (!('track' in data)) throw new Error('Track lookup unavailable');
    const hit = (data.track || []).find(x => videoWords(videoTitle(x.strTrack || '')) === videoWords(title) &&
      videoArtistMatches(x.strArtist || '', track.artist) && youtubeId(x.strMusicVid));
    if (hit) return youtubeId(hit.strMusicVid);
  }
  return null;
}

async function videoJSON(endpoint, params, signal) {
  const response = await fetch(endpoint + '?' + new URLSearchParams(params), { signal });
  if (!response.ok) throw new Error('Video catalog unavailable');
  return response.json();
}

async function wikipediaVideo(track, signal) {
  const api = (params) => videoJSON('https://en.wikipedia.org/w/api.php', {
    format: 'json', formatversion: 2, origin: '*', ...params,
  }, signal);
  const title = videoTitle(track.title), key = videoWords(title);
  const search = await api({
    action: 'query', list: 'search', srlimit: 5, srprop: '',
    srsearch: 'intitle:"' + title.replace(/"/g, '') + '" ' + track.artist,
  });
  if (!search.query?.search) throw new Error('Wikipedia search unavailable');
  const candidates = search.query.search.filter(page => videoWords(page.title) === key ||
    videoWords(page.title.replace(/\s+\([^)]*\)$/, '')) === key);
  for (const page of candidates.slice(0, 2)) {
    const article = await api({ action: 'parse', pageid: page.pageid, section: 0, prop: 'text' });
    if (!article.parse) throw new Error('Wikipedia article unavailable');
    // Read the lead infobox in an inert template. Never insert article HTML into the page.
    const template = document.createElement('template');
    template.innerHTML = article.parse.text;
    for (const box of template.content.querySelectorAll('table.infobox')) {
      if (videoWords(box.querySelector('.infobox-above')?.textContent || '') !== key) continue;
      const credit = [...box.querySelectorAll('.infobox-header')].find(h => /\bby\s/i.test(h.textContent));
      if (!credit) continue;
      const names = [...credit.querySelectorAll('a')].map(a => a.textContent);
      names.push(credit.textContent.replace(/^.*?\bby\s+/i, ''));
      if (!names.some(name => videoArtistMatches(name, track.artist))) continue;
      for (const section of box.querySelectorAll('.infobox-header')) {
        if (!/\bvideo\b/i.test(section.textContent)) continue;
        const row = section.closest('tr')?.nextElementSibling;
        for (const link of row?.querySelectorAll('a[href]') || []) {
          const id = youtubeId(link.getAttribute('href'));
          if (id) return id;
        }
      }
    }
  }
  return null;
}

// Real video search, for songs the curated catalogs do not know. Uses the user's own YouTube key when one is saved,
// otherwise free public search mirrors (these come and go, so several are tried).
const SEARCH_MIRRORS = ['https://api.piped.private.coffee', 'https://pipedapi.ducks.party'];
function pickVideo(t, items) {
  const full = videoWords(videoTitle(t.title)), bare = videoWords(t.title.replace(/\s*[(\[].*$/, '')), artist = videoWords(mainArtist(t));
  const wantsAlt = /\b(live|remix|acoustic|cover|instrumental)\b/.test(videoWords(t.title));
  let best = null, top = 0;
  for (const x of items) {
    if (!x.id) continue;
    const title = videoWords(x.title), channel = videoWords(x.channel || '');
    if (!((full && title.includes(full)) || (bare && title.includes(bare)))) continue;
    if (!(title.includes(artist) || channel.includes(artist))) continue;
    let s = 10;
    if (/\bofficial\b/.test(title)) s += 3;
    if (/\bvideo\b/.test(title)) s += 3;
    if (channel.includes(artist)) s += 2;
    if (/\b(lyrics?|audio|visualizer)\b/.test(title)) s -= 2;
    if (!wantsAlt && /\b(live|cover|reaction|remix|karaoke|sped up|slowed|8d|instrumental|acoustic|parody|tutorial)\b/.test(title)) s -= 8;
    if (t.dur && x.dur) { const d = Math.abs(x.dur - t.dur); s += d < 20 ? 3 : d < 90 ? 1 : d > 400 ? -6 : 0; }
    if (s > top) { top = s; best = x; }
  }
  return top >= 6 ? best.id : null;
}
async function searchVideo(t, signal) {
  const q = mainArtist(t) + ' ' + videoTitle(t.title) + ' official video';
  const key = store.get('ytKey');
  if (key) {
    try {
      const d = await videoJSON('https://www.googleapis.com/youtube/v3/search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: 8, q, key }, signal);
      const plain = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      return pickVideo(t, (d.items || []).map((x) => ({ id: x.id && x.id.videoId, title: plain(x.snippet.title), channel: plain(x.snippet.channelTitle) })));
    } catch {}
  }
  for (const base of SEARCH_MIRRORS) {
    try {
      const d = await videoJSON(base + '/search', { q, filter: 'videos' }, signal);
      return pickVideo(t, (d.items || []).filter((x) => x.url).map((x) => ({ id: youtubeId('https://www.youtube.com' + x.url), title: x.title || '', channel: x.uploaderName || '', dur: x.duration })));
    } catch {}
  }
  throw new Error('Video search unavailable');
}

let youtubeReady, retryYouTubeAfter = 0;
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubeReady) youtubeReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      youtubeReady = null;
      retryYouTubeAfter = Date.now() + 60000;
      reject(new Error('YouTube player unavailable'));
    };
    const timer = setTimeout(fail, 8000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(window.YT); };
    script.onerror = fail;
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.append(script);
  });
  return youtubeReady;
}

const mv = {
  box: $('mv'), ok: false, seq: 0, cache: new Map(), timer: 0,
  async find(t, provider) {
    const key = provider + ':' + t.id;
    if (this.cache.has(key)) return this.cache.get(key);
    const controller = this.search = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider === 'wikipedia' ? 6500 : provider === 'search' ? 12000 : 5000);
    const title = videoTitle(t.title), titleKey = videoWords(title);
    let match;
    try {
      if (provider === 'chart') {
        if (!this.chartVideos) {
          const res = await fetch('chart-videos.json', { signal: controller.signal });
          if (!res.ok) throw new Error('Chart links unavailable');
          this.chartVideos = await res.json();
        }
        const exact = t.src === 'apple' && this.chartVideos[t.id.slice(1)];
        const entry = exact || Object.values(this.chartVideos).find(x =>
          videoWords(x.title) === videoWords(t.title) && videoWords(x.artist) === videoWords(t.artist));
        match = entry?.youtube;
      } else if (provider === 'wikipedia') {
        match = await wikipediaVideo(t, controller.signal);
      } else if (provider === 'youtube') {
        match = await audioDBVideo(t, controller.signal);
      } else if (provider === 'search') {
        match = await searchVideo(t, controller.signal);
      } else {
        const data = await videoJSON('https://itunes.apple.com/search', {
          entity: 'musicVideo', limit: 10, term: title + ' ' + mainArtist(t),
        }, controller.signal);
        match = data.results?.find(x => x.previewUrl && videoWords(videoTitle(x.trackName || '')) === titleKey &&
          (videoArtistMatches(x.artistName || '', t.artist) || videoArtistMatches(t.artist, x.artistName || '')))?.previewUrl;
      }
      if (match) this.cache.set(key, match);
      return match;
    } finally { clearTimeout(timeout); }
  },
  visible(on) {
    this.ok = on;
    this.box.classList.toggle('on', on);
    stage.apply();
  },
  stop() {
    ++this.seq;
    this.search?.abort();
    clearTimeout(this.timer);
    this.timer = 0;
    this.ready = false;
    this.player?.destroy();
    this.player = null;
    if (this.clip) {
      this.clip.pause();
      this.clip.removeAttribute('src');
      this.clip.load();
      this.clip = null;
    }
    this.box.replaceChildren();
    this.visible(false);
    $('videoSettings').hidden = stage.scene !== 4 || !state.track;
  },
  async load(t) {
    this.stop();
    if (stage.scene !== 4 || !t) return;
    const seq = this.seq;
    const saved = store.get('video.' + t.id);
    $('videoLink').value = saved ? 'https://youtu.be/' + saved : '';
    $('videoLink').setCustomValidity('');
    $('videoStatus').textContent = 'Looking for a music video…';
    const link = $('videoMatch');
    link.href = 'https://www.youtube.com/results?' + new URLSearchParams({ search_query: t.artist + ' ' + t.title + ' official music video' });
    link.textContent = 'Search YouTube for this song';
    const remembered = store.get('vauto.' + t.id); // a match found on an earlier play
    let id = saved || remembered, lookupFailed = false;
    for (const provider of ['chart', 'youtube', 'wikipedia', 'search']) {
      if (id) break;
      try { id = await this.find(t, provider); }
      catch { lookupFailed = true; }
      if (seq !== this.seq) return;
    }
    if (!id) return this.fallback(t, seq, lookupFailed ? 'Video search could not be reached.' : 'No YouTube match.');
    if (!saved) store.set('vauto.' + t.id, id);
    link.href = 'https://www.youtube.com/watch?v=' + id;
    link.textContent = 'Open matched video on YouTube';
    if (!window.YT?.Player && Date.now() < retryYouTubeAfter) {
      return this.fallback(t, seq, 'Video found. YouTube player unavailable.');
    }
    try {
      const YT = await loadYouTubeAPI();
      if (seq !== this.seq) return;
      const host = document.createElement('div');
      this.box.append(host);
      const fail = () => this.fallback(t, seq, 'YouTube could not play this video.');
      this.timer = setTimeout(fail, 10000);
      this.player = new YT.Player(host, {
        host: 'https://www.youtube-nocookie.com', videoId: id,
        playerVars: { origin: location.origin, playsinline: 1, controls: 0, disablekb: 1, loop: 1, playlist: id, mute: 1, rel: 0, iv_load_policy: 3, fs: 0 }, // muted from the start so phones allow it to play on its own
        events: {
          onReady: () => {
            if (seq !== this.seq) return;
            clearTimeout(this.timer);
            this.timer = 0;
            this.ready = true;
            this.player.mute();
            this.seek(pos());
            this.sync();
            if (!isPlaying()) $('videoStatus').textContent = 'YouTube video ready.';
          },
          onStateChange: e => {
            if (seq !== this.seq || e.data !== YT.PlayerState.PLAYING) return;
            clearTimeout(this.timer);
            this.timer = 0;
            this.visible(true);
            $('videoStatus').textContent = 'Showing the YouTube video.';
            if (!isPlaying()) this.player.pauseVideo();
          },
          onError: () => { store.del('vauto.' + t.id); fail(); }, onAutoplayBlocked: fail,
        },
      });
    } catch { this.fallback(t, seq, 'Video found. YouTube player unavailable.'); }
  },
  async fallback(t, seq, reason = 'No YouTube match.') {
    if (seq !== this.seq) return;
    this.stop();
    const current = this.seq;
    $('videoStatus').textContent = reason + ' Looking for an Apple video clip…';
    const url = await this.find(t, 'apple').catch(() => null);
    if (current !== this.seq) return;
    const unavailable = () => {
      if (current !== this.seq) return;
      this.stop();
      $('videoStatus').textContent = reason + ' No playable Apple clip found.';
    };
    if (!url) return unavailable();
    const clip = this.clip = document.createElement('video');
    clip.muted = true;
    clip.playsInline = true;
    clip.loop = true;
    clip.onerror = unavailable;
    clip.onplaying = () => {
      if (current !== this.seq) return;
      this.visible(true);
      $('videoStatus').textContent = reason + ' Showing an Apple video clip.';
    };
    this.box.append(clip);
    clip.src = url;
    if (isPlaying()) clip.play().catch(() => { // phones in Low Power Mode refuse to start video on their own
      if (current === this.seq) $('videoStatus').textContent = 'Your phone is holding the video back. Tap here to start it.';
    });
  },
  // Called from a tap, which phones accept as permission to start video.
  kick() {
    if (this.clip) { this.clip.play().catch(() => {}); return; }
    if (this.ready) { try { this.player.mute(); this.player.playVideo(); } catch {} return; }
    retryYouTubeAfter = 0;
    if (state.track) this.load(state.track);
  },
  seek(seconds) {
    if (this.ready) this.player.seekTo(Math.max(0, seconds + (state.offset || 0)), true);
  },
  sync() {
    if (this.ready) {
      if (isPlaying()) {
        this.player.playVideo();
        if (!this.ok && !this.timer) {
          const seq = this.seq;
          this.timer = setTimeout(() => this.fallback(state.track, seq, 'YouTube playback timed out.'), 10000);
        }
      } else {
        clearTimeout(this.timer);
        this.timer = 0;
        this.player.pauseVideo();
      }
    }
    if (this.clip) {
      if (isPlaying()) this.clip.play().catch(() => {});
      else this.clip.pause();
    }
  },
};
$('saveVideo').onclick = () => {
  const t = state.track, input = $('videoLink');
  if (!t) return;
  const link = input.value.trim(), id = youtubeId(link);
  if (link && !id) {
    input.setCustomValidity('Enter a YouTube video link.');
    input.reportValidity();
    return;
  }
  if (id) store.set('video.' + t.id, id);
  else store.del('video.' + t.id);
  retryYouTubeAfter = 0;
  mv.load(t);
};
// Show the video status on Now Playing too, so it is visible without opening Settings. Tapping it retries.
new MutationObserver(() => { $('vstat').textContent = $('videoStatus').textContent; }).observe($('videoStatus'), { childList: true, characterData: true, subtree: true });
$('vstat').onclick = () => { buzz(); mv.kick(); };
$('ytKey').value = store.get('ytKey', '');
$('ytKey').onchange = () => {
  const k = $('ytKey').value.trim();
  if (k) store.set('ytKey', k); else store.del('ytKey');
  toast(k ? 'YouTube key saved. Video search will use it.' : 'YouTube key removed.');
  retryYouTubeAfter = 0; mv.cache.clear(); if (state.track) mv.load(state.track);
};
$('videoLink').oninput = () => $('videoLink').setCustomValidity('');
audio.addEventListener('seeked', () => { if (state.backend === 'audio') mv.seek(pos()); });
$('sceneSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) stage.set(+b.dataset.n, false); });
$('sceneBtn').onclick = () => { buzz(); stage.set(stage.gl ? (stage.scene + 1) % stage.NAMES.length : (stage.scene === 4 ? 0 : 4), true); };

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
  wave.draw(state.seeking ? +$('seek').value / 10 : pct);
  widget.update(pct);
  if (state.sleepAt && Date.now() >= state.sleepAt) { setSleep(0, true); if (isPlaying()) togglePlay(); toast('Sleep timer: music paused.'); }
}, 200);
$('seek').addEventListener('input', () => {
  state.seeking = true;
  const v = +$('seek').value; $('seek').style.setProperty('--p', v / 10 + '%'); wave.draw(v / 10);
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
      wrap.classList.add('dragging'); wrap.style.setProperty('--dr', Math.max(-1, Math.min(1, g.dx / wrap.clientWidth)));
      art.style.opacity = 1 - Math.min(0.6, Math.abs(g.dx) / 400);
    } else if (isPhone() && g.dy > 0) player.style.transform = `translateY(${g.dy}px)`;
  });
  const end = (cancelled) => {
    if (!g) return;
    const { axis, dx, dy } = g; g = null;
    wrap.classList.remove('dragging'); wrap.style.removeProperty('--dr');
    art.classList.remove('live');
    if (!axis) { if (!cancelled) togglePlay(); return; }
    if (axis === 'x') {
      if (Math.abs(dx) > 70 && state.queue.length && !cancelled) {
        const dir = dx < 0 ? 1 : -1;
        art.style.setProperty('--tx', -dir * 130 + '%'); art.style.opacity = 0;
        buzz();
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
  scopes: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read',
  lib: null,
  async pages(path, max = 4) { // follow "next" links, up to max pages
    let out = [], url = path;
    for (let i = 0; i < max && url; i++) {
      const j = await this.api(url); if (!j) break;
      out = out.concat(j.items || []); url = j.next ? j.next.replace('https://api.spotify.com/v1', '') : null;
    }
    return out;
  },
  async playlists() {
    return (await this.pages('/me/playlists?limit=50', 2)).filter(Boolean).map((p) => {
      const n = (p.items || p.tracks || {}).total;
      return { id: p.id, name: p.name, art: ((p.images || [])[0] || {}).url || '', note: n != null ? n + (n === 1 ? ' song' : ' songs') : 'Playlist' };
    });
  },
  async liked(max) { return (await this.pages('/me/tracks?limit=50', max)).map((r) => r.track).filter((x) => x && x.id).map(spTrack); },
  // A shuffled sample of the user's liked songs and their first few playlists, for the home page.
  async mix() {
    if (this.mixed) return this.mixed;
    if (!this.lib) this.lib = await this.playlists();
    const got = await Promise.allSettled([this.liked(1), ...this.lib.slice(0, 6).map((p) => this.playlistTracks(p.id, 1))]);
    const seen = new Set(), all = [];
    got.forEach((r) => { if (r.status === 'fulfilled') r.value.forEach((t) => { if (!seen.has(t.id)) { seen.add(t.id); all.push(t); } }); });
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    return (this.mixed = all.slice(0, 30));
  },
  async playlistTracks(id, max) {
    let rows;
    try { rows = await this.pages('/playlists/' + id + '/items?limit=50', max); }
    catch (e) { if (!/404/.test(e.message)) throw e; rows = await this.pages('/playlists/' + id + '/tracks?limit=50', max); } // older name for the same thing
    return rows.map((r) => r.item || r.track).filter((x) => x && x.id && x.type !== 'episode').map(spTrack);
  },
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
    if (j.scope) store.set('sp.scope', j.scope);
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
  logout() { store.del('sp.tok'); store.del('sp.scope'); this.lib = null; this.mixed = null; this.ready = false; if (this.player) this.player.disconnect(); this.player = null; refreshSpUI(); },
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
  const on = sp.connected(), b = $('settingsBtn'), pSp = state.primary === 'spotify';
  b.title = 'Settings \u00b7 Primary: ' + SRC_LABEL[state.primary];
  b.classList.toggle('ok', !pSp || sp.ready);
  $('spLogout').hidden = !on;
  document.querySelectorAll('#primarySeg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.p === state.primary)));
  $('chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('primary', c.dataset.src === state.primary));
  $('primaryNote').textContent = !pSp ? 'Apple Music charts and results come first. Songs play as 30-second previews.' :
    sp.ready ? 'Spotify results come first and every song plays in full through Spotify.' :
    on ? 'Spotify results come first. Full playback starts once the Spotify player is ready (Premium only); until then songs play as previews.' :
    'Connect Spotify below to use it. Until then Apple Music previews are used.';
  $('spStatus').textContent = on ? (sp.ready ? 'Connected. Full playback is ready.' : 'Connected. Search works; full playback starts once the Spotify player is ready (Premium only).') : '';
}
function openSettings() {
  $('redir').textContent = sp.redirect;
  $('clientId').value = store.get('sp.cid', '');
  refreshSpUI();
  $('settings').showModal();
}
$('settingsBtn').onclick = openSettings;
$('primarySeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.p === state.primary) return;
  state.primary = b.dataset.p; store.set('primary', state.primary);
  refreshSpUI(); renderList(); if (state.track) showTrack(state.track);
  toast('Primary service: ' + SRC_LABEL[state.primary]);
});
$('spConnect').onclick = () => {
  const id = $('clientId').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) { $('spStatus').textContent = 'That does not look like a Client ID (32 letters and numbers).'; return; }
  sp.login(id);
};
$('spLogout').onclick = () => { sp.logout(); toast('Spotify disconnected.'); };

/* ---------- wiring ---------- */
$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(typeTimer); addRecent($('q').value); search($('q').value); $('q').blur(); });
$('qClear').onclick = () => { clearTimeout(typeTimer); $('q').value = ''; $('qClear').hidden = true; if (state.query) search(''); $('q').focus(); renderRecents(); };
['focus', 'blur', 'input'].forEach((ev) => $('q').addEventListener(ev, () => { $('qClear').hidden = !$('q').value; renderRecents(ev === 'blur'); }));
$('recents').addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard up while picking one
$('sideTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
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
$('swatches').replaceChildren(...THEMES.map((n) => {
  const b = el('button'); b.type = 'button'; b.dataset.t = n; b.title = n[0].toUpperCase() + n.slice(1); b.setAttribute('aria-label', n + ' theme');
  b.style.background = 'linear-gradient(135deg, ' + THEME_SW[n][0] + ', ' + THEME_SW[n][1] + ')';
  b.onclick = () => vt(() => setTheme(n, false)); return b;
}));
const LZ = { s: 0.86, m: 1, l: 1.2 };
function setLz(z) {
  if (!LZ[z]) z = 'm';
  store.set('lz', z); root.style.setProperty('--lz', LZ[z]); state.lineIdx = -2;
  document.querySelectorAll('#lySeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === z)));
}
$('lySeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setLz(b.dataset.z); });
// Tap the artist line to see more from that artist.
$('sub').onclick = (e) => {
  const hit = e.target.closest('[data-act]');
  if (!state.track || !hit) return;
  if (hit.dataset.act === 'album') return void openAlbum(state.track);
  const a = state.track.artist.split(/,| & /)[0].trim();
  if (state.src !== 'all') $('chips').querySelector('[data-src="all"]').click();
  $('q').value = a; $('qClear').hidden = false; $('recents').hidden = true; search(a); setView('library');
};
$('play').onclick = togglePlay;
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('miniPlay').onclick = togglePlay;
$('miniNext').onclick = () => step(1);
$('miniOpen').onclick = () => setView('player');
$('closePlayer').onclick = () => setView('library');
$('openLyrics').onclick = $('peek').onclick = $('lyCard').onclick = () => { setTab('lyrics'); setView('lyrics'); };
// Watch mode: clear the screen down to the song, the controls and the lyric line, so the video or scene fills it.
function theater(on) {
  document.body.classList.toggle('theater', on);
  if (on) toast('Tap the background to bring everything back.');
}
$('theaterBtn').onclick = $('theaterTop').onclick = () => { buzz(); theater(true); };
$('theaterExit').onclick = () => theater(false);
$('player').addEventListener('click', (e) => { if (e.target === $('player') && document.body.classList.contains('theater')) theater(false); });
$('peek').addEventListener('click', (e) => { if (document.body.classList.contains('theater')) e.stopImmediatePropagation(); }, true);
$('openQueue').onclick = $('upAll').onclick = () => { setTab('queue'); setView('lyrics'); };
// Mini player: swipe sideways to skip, swipe up to open.
(function miniGestures() {
  const m = $('mini'); let g = null, swiped = false;
  m.addEventListener('pointerdown', (e) => { swiped = false; g = { x: e.clientX, y: e.clientY }; });
  m.addEventListener('pointercancel', () => { g = null; });
  m.addEventListener('pointerup', (e) => {
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y; g = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      swiped = true; m.classList.remove('nudge-l', 'nudge-r'); void m.offsetWidth; m.classList.add(dx < 0 ? 'nudge-l' : 'nudge-r'); buzz(); step(dx < 0 ? 1 : -1);
    } else if (dy < -30) { swiped = true; setView('player'); }
  });
  m.addEventListener('click', (e) => { if (swiped) { swiped = false; e.stopPropagation(); e.preventDefault(); } }, true);
})();
$('closeLyrics').onclick = () => setView('player');
function toggleBtn(id, key, onMsg, offMsg) {
  const b = $(id); b.setAttribute('aria-pressed', String(state[key]));
  b.onclick = () => { state[key] = !state[key]; store.set(key, state[key]); b.setAttribute('aria-pressed', String(state[key])); toast(state[key] ? onMsg : offMsg); renderQueue(); };
}
toggleBtn('shuffle', 'shuffle', 'Shuffle on', 'Shuffle off');
toggleBtn('repeat', 'repeat', 'Repeating this song', 'Repeat off');
function setSleep(m, quiet) {
  state.sleepAt = m ? Date.now() + m * 60000 : 0;
  document.querySelectorAll('#sleepSeg button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.m === m)));
  if (!quiet) toast(m ? 'Music will pause in ' + m + ' minutes.' : 'Sleep timer off.');
}
$('sleepSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSleep(+b.dataset.m); });
$('artColors').checked = state.artColors;
$('artColors').onchange = () => {
  state.artColors = $('artColors').checked; store.set('artColors', state.artColors);
  if (state.track) tint(state.track.art || state.track.artBig); else clearArt();
};
['touchmove', 'wheel'].forEach((ev) => $('lines').addEventListener(ev, () => { // reading ahead: stop following for a moment
  if (!state.lyrics || !state.lyrics.synced || state.offset === null) return;
  state.lyHold = Date.now() + 3500; $('lines').classList.add('browse');
}, { passive: true }));
// Bottom tabs (portrait phone). Tapping the tab you are on goes back to its top.
$('tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  buzz();
  if (b.dataset.src !== state.src) return void $('chips').querySelector('[data-src="' + b.dataset.src + '"]').click();
  if (state.album || state.query) { clearTimeout(typeTimer); $('q').value = ''; $('qClear').hidden = true; search(''); }
  $('tracks').scrollTo({ top: 0, behavior: 'smooth' });
});
// Tilt the cover in 3D by moving the phone (asks for motion access on iPhone).
const gyro = {
  on: false, base: null,
  handler(e) {
    if (e.beta == null || e.gamma == null || (isPhone() && app.dataset.view === 'library')) return;
    const ang = (screen.orientation && screen.orientation.angle) || 0, side = Math.abs(ang) === 90 || ang === 270;
    const gx = side ? e.beta * (ang === 90 ? 1 : -1) : e.gamma, gy = side ? -e.gamma * (ang === 90 ? 1 : -1) : e.beta;
    const b = gyro.base || (gyro.base = { x: gx, y: gy });
    b.x += (gx - b.x) * 0.02; b.y += (gy - b.y) * 0.02; // slowly settle on however the phone is being held
    const cl = (v) => Math.max(-1, Math.min(1, v)), x = cl((gx - b.x) / 22), y = cl((gy - b.y) / 22), s = $('art').style;
    s.setProperty('--ry', x * 17 + 'deg'); s.setProperty('--rx', -y * 17 + 'deg');
    s.setProperty('--sx', 50 + x * 50 + '%'); s.setProperty('--sy', 50 + y * 50 + '%'); s.setProperty('--sh', 1);
  },
  async start(ask) {
    if (this.on || !('DeviceOrientationEvent' in window)) return this.on;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        if (!ask) return false;
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false;
      }
    } catch { return false; }
    addEventListener('deviceorientation', this.handler); this.on = true; $('art').classList.add('gyro'); return true;
  },
  stop() {
    removeEventListener('deviceorientation', this.handler); this.on = false; this.base = null;
    const a = $('art'); a.classList.remove('gyro'); ['--rx', '--ry'].forEach((p) => a.style.removeProperty(p)); a.style.setProperty('--sh', 0);
  },
};
$('tiltRow').hidden = !('DeviceOrientationEvent' in window) || finePointer;
$('tilt').checked = store.get('tilt', false);
$('tilt').onchange = async () => {
  if ($('tilt').checked) { if (!(await gyro.start(true))) { $('tilt').checked = false; toast('Motion access was not allowed.'); } }
  else gyro.stop();
  store.set('tilt', $('tilt').checked);
};
if ($('tilt').checked && !$('tiltRow').hidden) gyro.start(false).then((ok) => { if (!ok) document.addEventListener('click', () => gyro.start(true), { once: true }); });
// Tiles lean toward your finger or mouse.
(function pressTilt() {
  const SEL = '.b-big, .b-tile, .card, .pl', box = $('tracks'); let cur = null;
  const lean = (e) => {
    const t = e.target.closest(SEL);
    if (cur && cur !== t) { cur.style.transform = ''; cur = null; }
    if (!t || calm.matches || (e.pointerType !== 'mouse' && !e.buttons && e.type !== 'pointerdown')) return;
    const r = t.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5, k = Math.min(16, 900 / r.width);
    cur = t; t.style.transform = 'perspective(600px) rotateX(' + (-y * k).toFixed(1) + 'deg) rotateY(' + (x * k).toFixed(1) + 'deg) scale(' + (e.buttons ? 0.97 : 1.02) + ')';
  };
  const drop = () => { if (cur) { cur.style.transform = ''; cur = null; } };
  box.addEventListener('pointerdown', lean); box.addEventListener('pointermove', lean);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => box.addEventListener(ev, drop));
})();
$('like').onclick = () => { if (state.track) toggleLike(state.track); };
function setVol(v) {
  $('vol').value = v; $('vol').style.setProperty('--p', v + '%');
  audio.volume = v / 100; if (sp.player) sp.player.setVolume(v / 100).catch(() => {});
}
$('vol').addEventListener('input', () => { setVol(+$('vol').value); store.set('vol', +$('vol').value); });
document.addEventListener('keydown', (e) => {
  if ($('settings').open) return;
  if (e.code === 'Escape' && document.body.classList.contains('theater')) { theater(false); return; }
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
  setLz(store.get('lz', 'm'));
  viz.draw(0);
  if (!stage.gl && stage.scene !== 4) stage.scene = 0;
  if (stage.scene === 4 && state.track) mv.load(state.track);
  stage.apply(); stage.draw(0);
  await sp.handleRedirect();
  refreshSpUI();
  sp.initPlayer();
  // drop anything saved from services that are no longer offered
  const known = (t) => t && SRC_LABEL[t.src];
  if (state.likes.some((t) => !known(t))) { state.likes = state.likes.filter(known); store.set('likes', state.likes); }
  let last = store.get('last');
  if (last && last.queue && !last.queue.every(known)) { last = null; store.del('last'); }
  if (last && last.queue && last.queue[last.index]) { // bring back the last song, paused
    state.queue = last.queue; state.index = last.index; state.track = last.queue[last.index];
    showTrack(state.track); $('mode').textContent = 'Preview';
  }
  setTab(store.get('tab') === 'queue' && !isPhone() ? 'queue' : 'lyrics');
  search('');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
