/* Radio Widget — renderer */
'use strict';

const IDLE_TO_COMPACT_MS = 20000; // expanded -> compact (normal)
const IDLE_TO_LOGO_MS = 6000; // expanded -> logo (stay-on-top)
const LOGO_HOVER_DELAY_MS = 600;

const $ = (sel) => document.querySelector(sel);
const body = document.body;

// ---------- icons ----------
function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((n) => {
    n.innerHTML = ICONS[n.dataset.icon] || '';
  });
}
function setIcon(node, name) {
  node.dataset.icon = name;
  node.innerHTML = ICONS[name];
}
paintIcons();

// ---------- state ----------
const state = {
  settings: null,
  proxyPort: 0,
  mode: 'expanded',
  playing: false,
  muted: false,
  station: null,
  countries: null,
  stations: [],
  stationsCountry: null,
  artist: '',
  song: '',
  streamId: 0,
  noInfo: false,
  usingProxy: false,
  dropdown: null, // 'stations' | 'country' | null
};

const regionNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language, 'en'], { type: 'region' });
  } catch {
    return null;
  }
})();
const countryName = (cc) => (regionNames && regionNames.of(cc)) || cc;

// ---------- helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function hueOf(str) {
  let h = 0;
  for (const ch of str || '') h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** Fill a .logo element with the station's favicon, or a colored initial as fallback. */
function renderLogo(node, station) {
  node.replaceChildren();
  node.classList.remove('fallback', 'empty');
  if (!station) {
    node.classList.add('empty');
    node.innerHTML = ICONS.radio;
    return;
  }
  const fallback = () => {
    node.replaceChildren();
    node.classList.add('fallback');
    node.style.setProperty('--fb', `hsl(${hueOf(station.name)} 45% 42%)`);
    node.textContent = ([...(station.name || '?').trim()][0] || '?').toUpperCase();
  };
  if (!station.favicon) return fallback();
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.onerror = fallback;
  img.onload = () => {
    if (img.naturalWidth < 8) fallback();
  };
  img.src = station.favicon;
  node.appendChild(img);
}

function renderFlag(node, cc) {
  node.className = 'flag';
  node.replaceChildren();
  if (cc && /^[A-Z]{2}$/i.test(cc)) {
    node.classList.add('fi', `fi-${cc.toLowerCase()}`);
  } else {
    node.classList.add('unknown');
    node.innerHTML = ICONS.globe;
  }
}

// ---------- audio graph ----------
// `audio` plays through the local proxy and feeds the Web Audio graph
// (visualizer + gain). `direct` is the fallback for servers the proxy can't
// handle: a cross-origin stream routed into Web Audio would be silent, so it
// plays outside the graph and the visualizer animates on its own.
const audio = new Audio();
audio.preload = 'none';
audio.crossOrigin = 'anonymous';
const direct = new Audio();
direct.preload = 'none';
let noInfoTimer = null;
let actx = null;
let analyser = null;
let gainNode = null;
let freq = null;

function ensureGraph() {
  if (actx) return;
  actx = new AudioContext();
  const src = actx.createMediaElementSource(audio);
  analyser = actx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.78;
  gainNode = actx.createGain();
  src.connect(analyser);
  analyser.connect(gainNode);
  gainNode.connect(actx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);
  applyVolume();
}

function applyVolume() {
  const v = state.muted ? 0 : state.settings.volume;
  if (gainNode) gainNode.gain.setTargetAtTime(v * v, actx.currentTime, 0.02); // perceptual curve
  direct.volume = v * v;
}

function proxyUrl(url) {
  return `http://127.0.0.1:${state.proxyPort}/stream?id=${state.streamId}&u=${encodeURIComponent(url)}`;
}

function play() {
  if (!state.station) {
    if (state.mode !== 'expanded') setMode('expanded').then(() => openDropdown('stations'));
    else openDropdown('stations');
    return;
  }
  ensureGraph();
  actx.resume();
  state.streamId += 1;
  state.artist = '';
  state.song = '';
  state.noInfo = false;
  clearTimeout(noInfoTimer);
  const sid = state.streamId;
  // no song title within 10s of playing → this station doesn't send one
  noInfoTimer = setTimeout(() => {
    if (sid === state.streamId && !state.song) {
      state.noInfo = true;
      renderNowPlaying();
    }
  }, 10000);
  renderNowPlaying();
  setPlayUI('buffering');
  const url = state.station.url_resolved || state.station.url;
  if (state.proxyPort) {
    state.usingProxy = true;
    silence(direct);
    audio.src = proxyUrl(url);
  } else {
    playDirect();
    return;
  }
  audio.play().catch(() => {});
}

function playDirect() {
  state.usingProxy = false;
  silence(audio);
  applyVolume();
  direct.src = state.station.url_resolved || state.station.url;
  direct.play().catch(() => {});
}

function silence(a) {
  a.pause();
  a.removeAttribute('src');
  a.load(); // closes the network stream
}

function stop() {
  silence(audio);
  silence(direct);
  state.playing = false;
  setPlayUI('paused');
}

function togglePlay() {
  if (state.playing || $('#btnPlayBig').classList.contains('buffering')) stop();
  else play();
}

const current = () => (state.usingProxy ? audio : direct);
for (const a of [audio, direct]) {
  a.addEventListener('playing', () => {
    if (a !== current()) return;
    state.playing = true;
    setPlayUI('playing');
  });
  a.addEventListener('waiting', () => {
    if (a === current() && a.getAttribute('src')) setPlayUI('buffering');
  });
  a.addEventListener('error', () => {
    if (a !== current() || !a.getAttribute('src')) return;
    if (a === audio) {
      playDirect(); // proxy couldn't handle this server — play the URL directly (no song info)
      return;
    }
    state.playing = false;
    setPlayUI('error');
  });
}

function setPlayUI(kind) {
  const playing = kind === 'playing' || kind === 'buffering';
  body.classList.toggle('playing', kind === 'playing');
  for (const btn of [$('#btnPlayBig'), $('#btnPlaySmall')]) {
    btn.classList.toggle('buffering', kind === 'buffering');
    btn.classList.toggle('error', kind === 'error');
    setIcon(btn.firstElementChild, kind === 'error' ? 'warn' : playing ? 'pause' : 'play');
    btn.title = kind === 'error' ? 'Stream unavailable — retry' : playing ? 'Pause' : 'Play';
  }
  reportNowPlaying();
}

// ---------- now playing ----------
const NO_INFO_TEXT = /^he\b/i.test(navigator.language) ? 'התחנה לא משדרת שם שיר' : 'Station doesn’t share song info';

// Filler that some CDNs put in StreamTitle instead of a real song
function isFillerTitle(t) {
  if (!t) return true;
  if (/powered by|streaming|^cdn\b|^unknown$|^n\/a$|^-+$|advertis|^live$/i.test(t)) return true;
  const st = state.station && state.station.name.toLowerCase();
  return !!st && t.toLowerCase() === st;
}

window.radio.onMetadata(({ id, title }) => {
  if (Number(id) !== state.streamId) return;
  const t = (title || '').trim();
  if (isFillerTitle(t)) {
    // keep the last real song if the station only sent filler between songs
    if (!state.song) state.noInfo = true;
    renderNowPlaying();
    return;
  }
  state.noInfo = false;
  const i = t.indexOf(' - ');
  if (i > 0) {
    state.artist = t.slice(0, i).trim();
    state.song = t.slice(i + 3).trim();
  } else {
    state.artist = '';
    state.song = t;
  }
  renderNowPlaying();
});

// ---------- favorites ----------
function favorites() {
  return state.settings.favorites || (state.settings.favorites = []);
}
function isFav(st) {
  return !!st && favorites().some((f) => f.stationuuid === st.stationuuid);
}
function slimStation(st) {
  return {
    stationuuid: st.stationuuid,
    name: (st.name || '').trim(),
    favicon: st.favicon || '',
    url: st.url,
    url_resolved: st.url_resolved,
    countrycode: st.countrycode,
    codec: st.codec,
    bitrate: st.bitrate,
    tags: st.tags || '',
  };
}
function toggleFav(st) {
  if (!st) return;
  const list = favorites();
  const i = list.findIndex((f) => f.stationuuid === st.stationuuid);
  if (i >= 0) list.splice(i, 1);
  else list.push(slimStation(st));
  window.radio.save({ favorites: list });
  syncFavUI();
  if (state.dropdown === 'stations') renderList('stations', true);
}
function syncFavUI() {
  const b = $('#btnFav');
  const on = isFav(state.station);
  b.hidden = !state.station;
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Remove from favorites' : 'Add to favorites';
}
$('#btnFav').addEventListener('click', () => toggleFav(state.station));

// ---------- click to copy "Artist - Song" ----------
function songLine() {
  return [state.artist, state.song].filter(Boolean).join(' - ');
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1300);
}
async function copySong() {
  const line = songLine();
  if (!line) return;
  await window.radio.copy(line);
  toast('✓ ' + line);
}
for (const id of ['#songText', '#artistText', '#vizSmall']) $(id).addEventListener('click', copySong);

function renderNowPlaying() {
  const st = state.station;
  const noInfo = !!st && state.noInfo && !state.song;
  $('#stationName').textContent = st ? st.name : '—';
  $('#stationName').title = st ? st.name : '';
  syncFavUI();
  $('.info').classList.toggle('noinfo', noInfo);
  $('#songText').textContent = noInfo ? NO_INFO_TEXT : state.song || '—';
  const copyTip = songLine() ? `${songLine()}
(click to copy)` : '';
  $('#songText').title = copyTip;
  $('#songText').classList.toggle('can-copy', !!songLine());
  $('#artistText').classList.toggle('can-copy', !!songLine());
  $('#artistText').textContent = state.artist || '—';
  $('#artistText').title = copyTip;

  const tip =
    [state.artist, state.song].filter(Boolean).join(' — ') || (st ? (noInfo ? `${st.name} · ${NO_INFO_TEXT}` : st.name) : '');
  $('#vizSmall').title = songLine() ? `${tip}
(click to copy)` : tip;
  $('#btnLogoSmall').title = st ? st.name : 'Stations';
  $('#logoView').title = st ? [st.name, tip !== st.name ? tip : ''].filter(Boolean).join('\n') : '';
  reportNowPlaying();
}

function setStation(st, autoplay = true) {
  state.station = st ? slimStation(st) : null;
  window.radio.save({ station: state.station });
  for (const id of ['#logoBig', '#logoSmall', '#logoTile']) renderLogo($(id), state.station);
  renderNowPlaying();
  if (autoplay) play();
}

// ---------- visualizer ----------
const vizBig = $('#vizBig');
const vizSmall = $('#vizSmall');
let silentFrames = 0;
let synthPhase = 0;

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (w && (c.width !== w || c.height !== h)) {
    c.width = w;
    c.height = h;
  }
}

function levels(n) {
  const out = new Array(n).fill(0);
  if (state.playing && analyser) {
    analyser.getByteFrequencyData(freq);
    let sum = 0;
    const maxBin = Math.floor(freq.length * 0.72);
    for (let i = 0; i < n; i++) {
      // mirror: center bars = bass, edges = treble (like the sketch's symmetric shape)
      const k = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
      const bin = Math.min(maxBin - 1, Math.floor(Math.pow(k, 1.7) * maxBin));
      const v = freq[bin] / 255;
      out[i] = v;
      sum += v;
    }
    silentFrames = sum === 0 ? silentFrames + 1 : 0;
    if (silentFrames < 45) return out;
  }
  // idle wave when paused, synthetic motion if analyser gives nothing while playing
  synthPhase += state.playing ? 0.09 : 0.025;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
    const wave = (Math.sin(i * 0.55 + synthPhase) + Math.sin(i * 0.23 - synthPhase * 1.7)) * 0.25 + 0.5;
    out[i] = state.playing ? wave * (1 - k * 0.6) * 0.8 : 0.06 + wave * 0.05;
  }
  return out;
}

function drawViz(c, n) {
  fitCanvas(c);
  const g = c.getContext('2d');
  const { width: W, height: H } = c;
  g.clearRect(0, 0, W, H);
  const lv = levels(n);
  const slot = W / n;
  const bw = Math.max(1.5, slot * 0.42);
  const mid = H / 2;
  const t = performance.now() / 4000;
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, lv[i] * H * 0.96);
    const hue = (i / n) * 300 + t * 60;
    g.fillStyle = `hsl(${hue % 360} 80% ${state.playing ? 62 : 45}%)`;
    g.globalAlpha = state.playing ? 0.95 : 0.5;
    const x = i * slot + (slot - bw) / 2;
    const r = bw / 2;
    g.beginPath();
    g.roundRect(x, mid - h / 2, bw, h, r);
    g.fill();
  }
  g.globalAlpha = 1;
}

function frame() {
  if (state.mode === 'expanded') drawViz(vizBig, 38);
  else if (state.mode === 'compact') drawViz(vizSmall, 24);
  requestAnimationFrame(frame);
}

// ---------- modes ----------
let modeBusy = Promise.resolve();
function setMode(next) {
  modeBusy = modeBusy.then(async () => {
    if (state.mode === next) return;
    if (state.dropdown) await closeDropdown(true);
    clearTimeout(logoHoverTimer);
    body.classList.add('switching');
    await window.radio.setMode(next);
    state.mode = next;
    body.dataset.mode = next;
    requestAnimationFrame(() => body.classList.remove('switching'));
    bumpIdle();
  });
  return modeBusy;
}

// ---------- idle handling ----------
let idleTimer = null;
function bumpIdle() {
  clearTimeout(idleTimer);
  if (state.mode !== 'expanded' || state.dropdown) return;
  idleTimer = setTimeout(onIdle, state.settings.stayOnTop ? IDLE_TO_LOGO_MS : IDLE_TO_COMPACT_MS);
}
async function onIdle() {
  if (state.mode !== 'expanded' || state.dropdown) return;
  // a resting pointer over the widget still counts as "using" it
  if (await window.radio.cursorInside()) {
    idleTimer = setTimeout(onIdle, 1000);
    return;
  }
  setMode(state.settings.stayOnTop ? 'logo' : 'compact');
}
for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
  window.addEventListener(ev, bumpIdle, { passive: true });
}
document.documentElement.addEventListener('mouseleave', bumpIdle);

// ---------- volume ----------
function syncVolumeUI() {
  const pct = Math.round((state.muted ? 0 : state.settings.volume) * 100);
  for (const s of [$('#volBig'), $('#volSmall')]) {
    s.value = pct;
    s.style.setProperty('--val', pct + '%');
    s.title = `Volume ${pct}%`;
  }
  setIcon($('#btnMuteBig'), state.muted || pct === 0 ? 'mute' : 'volume');
}
function onVolumeInput(e) {
  state.settings.volume = Number(e.target.value) / 100;
  state.muted = false;
  syncVolumeUI();
  applyVolume();
  saveVolume();
}
let volSaveTimer;
function saveVolume() {
  clearTimeout(volSaveTimer);
  volSaveTimer = setTimeout(() => window.radio.save({ volume: state.settings.volume }), 400);
}
for (const s of [$('#volBig'), $('#volSmall')]) {
  s.addEventListener('input', onVolumeInput);
  s.addEventListener('wheel', (e) => {
    e.preventDefault();
    s.value = Number(s.value) + (e.deltaY < 0 ? 5 : -5);
    onVolumeInput({ target: s });
  });
}
$('#btnMuteBig').addEventListener('click', () => {
  state.muted = !state.muted;
  syncVolumeUI();
  applyVolume();
});

// ---------- toggles ----------
function syncToggles(autoStart) {
  $('#btnPin').setAttribute('aria-pressed', String(!!state.settings.stayOnTop));
  $('#btnPin').title = state.settings.stayOnTop ? 'Stay on top: on' : 'Stay on top: off';
  if (autoStart !== undefined) {
    $('#btnAuto').setAttribute('aria-pressed', String(!!autoStart));
    $('#btnAuto').title = autoStart ? 'Start with Windows: on' : 'Start with Windows: off';
  }
}
$('#btnPin').addEventListener('click', async () => {
  state.settings.stayOnTop = await window.radio.setStayOnTop(!state.settings.stayOnTop);
  syncToggles();
  bumpIdle();
});
$('#btnAuto').addEventListener('click', async () => {
  const on = $('#btnAuto').getAttribute('aria-pressed') !== 'true';
  syncToggles(await window.radio.setAutoStart(on));
});

// ---------- dropdowns ----------
const dd = {
  stations: { root: $('#ddStations'), btn: $('#btnStations') },
  country: { root: $('#ddCountry'), btn: $('#btnCountry') },
};
for (const k of Object.keys(dd)) {
  dd[k].panel = dd[k].root.querySelector('.dd-panel');
  dd[k].list = dd[k].root.querySelector('.dd-list');
  dd[k].input = dd[k].root.querySelector('input');
  dd[k].btn.addEventListener('click', () => (state.dropdown === k ? closeDropdown() : openDropdown(k)));
  dd[k].input.addEventListener('input', () => renderList(k));
  dd[k].input.addEventListener('keydown', (e) => listKeys(k, e));
}

let ddBusy = Promise.resolve();
function openDropdown(kind) {
  ddBusy = ddBusy.then(async () => {
    if (state.mode !== 'expanded') return;
    if (state.dropdown && state.dropdown !== kind) await closeDropdownNow(false);
    if (state.dropdown === kind) return;
    clearTimeout(idleTimer);
    state.dropdown = kind;
    const dir = await window.radio.dropdown(true);
    body.dataset.dd = dir;
    const d = dd[kind];
    d.root.classList.add('open');
    d.panel.hidden = false;
    d.input.value = '';
    renderList(kind);
    d.input.focus();
    if (kind === 'stations') loadStations();
    else loadCountries();
  });
  return ddBusy;
}
function closeDropdown(fromMode = false) {
  ddBusy = ddBusy.then(() => closeDropdownNow(!fromMode));
  return ddBusy;
}
async function closeDropdownNow(restartIdle = true) {
  const kind = state.dropdown;
  if (!kind) return;
  dd[kind].panel.hidden = true;
  dd[kind].root.classList.remove('open');
  state.dropdown = null;
  await window.radio.dropdown(false);
  delete body.dataset.dd;
  if (restartIdle) bumpIdle();
}
window.addEventListener('pointerdown', (e) => {
  if (!state.dropdown) return;
  if (!dd[state.dropdown].root.contains(e.target)) closeDropdown();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.dropdown) closeDropdown();
});
window.addEventListener('blur', () => {
  if (state.dropdown) closeDropdown();
});

function listState(kind, what, retry) {
  const box = el('div', 'dd-state');
  if (what === 'loading') box.appendChild(el('div', 'spinner'));
  else if (what === 'error') {
    const b = el('button');
    b.title = 'Retry';
    b.innerHTML = ICONS.retry;
    b.addEventListener('click', retry);
    box.appendChild(b);
  } else {
    box.innerHTML = ICONS.search;
    box.style.opacity = '0.5';
  }
  dd[kind].list.replaceChildren(box);
}

// short fixed list: Israel plus English-speaking countries
const COUNTRIES = ['IL', 'US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'ZA'];
function loadCountries() {
  if (!state.countries) {
    state.countries = COUNTRIES.map((code) => ({ code, apiName: code, name: countryName(code) }));
  }
  renderList('country');
}

async function loadStations(force = false) {
  const cc = state.settings.country;
  if (!force && state.stationsCountry === cc && state.stations.length) return renderList('stations');
  state.stationsCountry = null;
  if (favorites().length) renderList('stations'); // favorites show while the rest loads
  else listState('stations', 'loading');
  try {
    const rows = await window.radio.api(
      `stations/search?countrycode=${encodeURIComponent(cc)}&hidebroken=true&order=clickcount&reverse=true&limit=400`
    );
    const seen = new Set();
    state.stations = rows.filter((s) => {
      const key = (s.name || '').trim().toLowerCase();
      if (!key || !s.url_resolved || s.hls === 1 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    state.stationsCountry = cc;
    if (state.settings.country === cc) renderList('stations', true);
  } catch {
    listState('stations', 'error', () => loadStations(true));
  }
}

function stationRow(s) {
  const b = el('button', 'st-item');
  b.setAttribute('role', 'option');
  if (state.station && state.station.stationuuid === s.stationuuid) b.classList.add('active');
  const logo = el('span', 'logo xs');
  renderLogo(logo, s);
  const txt = el('span', 'st-text');
  const name = el('span', 'st-name', s.name.trim());
  name.dir = 'auto';
  const meta = [s.codec, s.bitrate ? s.bitrate + 'k' : '', (s.tags || '').split(',').slice(0, 2).join(', ')]
    .filter(Boolean)
    .join(' · ');
  txt.append(name, el('span', 'st-meta', meta));
  const star = el('span', 'fav-btn');
  star.innerHTML = ICONS.star;
  const on = isFav(s);
  star.classList.toggle('on', on);
  star.title = on ? 'Remove from favorites' : 'Add to favorites';
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(s);
  });
  b.append(logo, txt, star);
  b.addEventListener('click', () => {
    closeDropdown();
    setStation(s, true);
  });
  return b;
}

function renderList(kind, keepScroll = false) {
  const d = dd[kind];
  const q = d.input.value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  const scroll = d.list.scrollTop;

  if (kind === 'stations') {
    const match = (s) => !q || s.name.toLowerCase().includes(q) || (s.tags || '').toLowerCase().includes(q);
    const favs = favorites().filter(match);
    const ready = state.stationsCountry === state.settings.country;
    const favIds = new Set(favorites().map((f) => f.stationuuid));
    const items = ready ? state.stations.filter((s) => match(s) && !favIds.has(s.stationuuid)) : [];
    if (!favs.length && !ready) return; // still loading, spinner stays
    if (!favs.length && !items.length) return listState(kind, 'empty');
    for (const s of favs) frag.appendChild(stationRow(s));
    if (favs.length && (items.length || !ready)) frag.appendChild(el('div', 'dd-sep'));
    if (!ready && favs.length) {
      const sp = el('div', 'dd-state');
      sp.style.height = '60px';
      sp.appendChild(el('div', 'spinner'));
      frag.appendChild(sp);
    }
    for (const s of items.slice(0, 250)) frag.appendChild(stationRow(s));
  } else {
    if (!state.countries) return;
    const items = state.countries.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.apiName.toLowerCase().includes(q) ||
        c.code.toLowerCase() === q
    );
    if (!items.length) return listState(kind, 'empty');
    for (const c of items) {
      const b = el('button', 'flag-item');
      b.setAttribute('role', 'option');
      b.title = c.name;
      if (c.code === state.settings.country) b.classList.add('active');
      const f = el('span');
      renderFlag(f, c.code);
      b.appendChild(f);
      b.addEventListener('click', () => chooseCountry(c.code));
      frag.appendChild(b);
    }
  }
  d.list.replaceChildren(frag);
  d.list.scrollTop = keepScroll ? scroll : 0;
}

async function chooseCountry(cc) {
  state.settings.country = cc;
  window.radio.save({ country: cc });
  syncCountryUI();
  await closeDropdown();
  openDropdown('stations'); // next step is picking a station
}

function syncCountryUI() {
  renderFlag($('#countryFlag'), state.settings.country);
  $('#btnCountry').title = countryName(state.settings.country);
}

// keyboard navigation inside a list
function listKeys(kind, e) {
  const items = [...dd[kind].list.querySelectorAll('.st-item, .flag-item')];
  if (!items.length) return;
  let i = items.findIndex((n) => n.classList.contains('kb'));
  const cols = kind === 'country' ? 4 : 1;
  const moves = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: kind === 'country' ? 1 : 0, ArrowLeft: kind === 'country' ? -1 : 0 };
  if (e.key in moves && moves[e.key]) {
    e.preventDefault();
    if (i >= 0) items[i].classList.remove('kb');
    i = Math.max(0, Math.min(items.length - 1, (i < 0 ? -moves[e.key] : i) + moves[e.key]));
    items[i].classList.add('kb');
    items[i].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    (items[i] || items[0]).click();
  }
}

// ---------- window dragging (titlebar / empty parts of compact) ----------
for (const n of [$('.titlebar'), $('#compact')]) {
  n.addEventListener('mousedown', (e) => {
    if (e.button === 0 && e.target === n) window.radio.dragStart();
  });
}

// ---------- expanded / compact controls ----------
$('#btnPlayBig').addEventListener('click', togglePlay);
$('#btnPlaySmall').addEventListener('click', togglePlay);
$('#btnClose').addEventListener('click', () => window.radio.hide()); // keeps playing; quit from the tray
$('#btnCollapse').addEventListener('click', () => setMode(state.settings.stayOnTop ? 'logo' : 'compact'));
$('#btnExpand').addEventListener('click', () => setMode('expanded'));
$('#btnLogoSmall').addEventListener('click', async () => {
  await setMode('expanded');
  openDropdown('stations');
});

// ---------- logo mode: drag / hover / click ----------
const tile = $('#logoView .logo-tile');
let logoHoverTimer = null;
let press = null;

tile.addEventListener('pointerenter', () => {
  clearTimeout(logoHoverTimer);
  if (state.settings.logoOpenOn === 'hover' && !press) {
    logoHoverTimer = setTimeout(() => setMode('expanded'), LOGO_HOVER_DELAY_MS);
  }
});
tile.addEventListener('pointerleave', () => clearTimeout(logoHoverTimer));
tile.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  clearTimeout(logoHoverTimer);
  tile.setPointerCapture(e.pointerId);
  press = { x: e.screenX, y: e.screenY, offX: e.clientX, offY: e.clientY, dragging: false };
});
tile.addEventListener('pointermove', (e) => {
  if (!press || press.dragging) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    // hand the drag to the OS; the backend clamps + saves the spot when it ends
    press = null;
    try {
      tile.releasePointerCapture(e.pointerId);
    } catch {}
    window.radio.dragStart();
  }
});
function endPress(e, cancelled) {
  if (!press) return;
  const p = press;
  press = null;
  if (!cancelled && e.button === 0) {
    setMode('expanded'); // click always opens
  }
}
tile.addEventListener('pointerup', (e) => endPress(e, false));
tile.addEventListener('lostpointercapture', (e) => endPress(e, true));
tile.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.radio.logoMenu();
});

window.radio.onSettings((patch) => {
  const { autoStart, ...rest } = patch;
  Object.assign(state.settings, rest);
  syncToggles(autoStart);
  bumpIdle();
});
window.radio.onTogglePlay(togglePlay);

function reportNowPlaying() {
  window.radio.nowPlaying({
    station: state.station ? state.station.name : '',
    title: [state.artist, state.song].filter(Boolean).join(' — '),
    playing: state.playing,
  });
}
window.radio.onWake(() => setMode('expanded'));

// ---------- boot ----------
(async function boot() {
  const init = await window.radio.init();
  state.settings = init.settings;
  state.proxyPort = init.proxyPort;
  syncVolumeUI();
  syncToggles(init.autoStart);
  syncCountryUI();
  setStation(state.settings.station, false);
  setPlayUI('paused');
  requestAnimationFrame(frame);
  bumpIdle();
  // warm the station list in the background so the dropdown opens instantly
  loadStations();
})();
