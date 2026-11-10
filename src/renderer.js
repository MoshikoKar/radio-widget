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
  // the visualizer samples 30×/s; 0.62 decays like 0.78 did at 60×/s
  analyser.smoothingTimeConstant = 0.62;
  gainNode = actx.createGain();
  src.connect(analyser);
  analyser.connect(gainNode);
  gainNode.connect(actx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);
  applyVolume();
}

// Ads / calls play at a share of the current volume: 32% at 50% → 16%.
// Both at once don't stack — the quieter one wins.
function duckFactor() {
  return Math.min(adQuiet() ? adLevel() : 1, callQuiet() ? callLevel() : 1);
}
function applyVolume(ramp = 0.02) {
  const v = state.muted ? 0 : state.settings.volume * duckFactor();
  if (gainNode) gainNode.gain.setTargetAtTime(v * v, actx.currentTime, ramp); // perceptual curve
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
  resetAd();
  clearTimeout(releaseTimer);
  state.streamId += 1;
  state.artist = '';
  state.song = '';
  state.artwork = '';
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
  clearTimeout(skipTimer);
  skipTimer = setTimeout(() => skipDead(sid), SKIP_AFTER_MS);
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

// Stop = pause, so Windows' media controls keep showing the station and the
// play key still reaches us; the connection is dropped after a while.
const RELEASE_AFTER_MS = 5 * 60 * 1000;
let releaseTimer = null;
function stop() {
  clearTimeout(skipTimer);
  resetAd();
  state.streamId += 1; // ignore metadata still trickling in from the paused stream
  audio.pause();
  direct.pause();
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    if (state.playing) return;
    silence(audio);
    silence(direct);
  }, RELEASE_AFTER_MS);
  state.playing = false;
  setPlayUI('paused');
}

function togglePlay() {
  if (state.playing || $('#btnPlayBig').classList.contains('buffering')) stop();
  else {
    autoSkips = 0;
    play();
  }
}

const current = () => (state.usingProxy ? audio : direct);
for (const a of [audio, direct]) {
  a.addEventListener('playing', () => {
    if (a !== current()) return;
    clearTimeout(skipTimer);
    autoSkips = 0;
    playedSid = state.streamId;
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
    // the stream is down: move on after a moment, so the error is seen
    const sid = state.streamId;
    clearTimeout(skipTimer);
    skipTimer = setTimeout(() => skipDead(sid, true), SKIP_ON_ERROR_MS);
  });
}

// A station that hasn't started playing within 15 s (or whose stream fails)
// is skipped for a random one. After a few dead stations in a row it stops
// trying, and nothing is skipped while Windows reports no network.
const SKIP_AFTER_MS = 15000;
const SKIP_ON_ERROR_MS = 2500;
const MAX_AUTO_SKIPS = 5;
let skipTimer = null;
let autoSkips = 0;
let playedSid = -1; // the last stream that actually started playing
// (state.playing can't tell: it stays true while switching from a playing station)
function skipDead(sid, failed = false) {
  if (sid !== state.streamId || !state.station) return;
  if (!failed && playedSid === sid) return; // it started in time
  if (!navigator.onLine) return;
  const name = state.station.name;
  if (autoSkips >= MAX_AUTO_SKIPS) {
    autoSkips = 0;
    silence(audio);
    silence(direct);
    state.playing = false;
    setPlayUI('error');
    return toast(HE ? 'כמה תחנות ברצף לא ניגנו — עצרתי' : 'Several stations in a row didn’t play — stopped');
  }
  autoSkips += 1;
  toast(HE ? `${name} לא מנגנת — עובר לתחנה אחרת` : `${name} isn’t playing — trying another station`);
  playRandom();
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

// Filler that some CDNs / stations put in StreamTitle instead of a real song:
// "Powered by…", a bare "Live", or a status word ("מנגן", "Now playing"),
// alone or next to the station's own name ("Mizrahit.Fm - מנגן").
const GENERIC_WORDS =
  /^(מנגן|מנגנים|מתנגן|עכשיו מנגן|משדר|משדרים|משדרים עכשיו|בשידור|בשידור חי|שידור חי|חי|אונליין|רדיו|מוזיקה|שיר|אמן|ללא שם|now playing|playing|play|on air|live|live stream|live radio|online|radio|music|stream|song|artist|title|untitled|no title|unknown|unknown artist|unknown title|various|various artists|n\/a|null|undefined|none|[-–—.·|:_\s]*)$/i;
const squash = (s) => s.toLowerCase().replace(/[\s.\-–—_|:'"״׳!()[\]]+/g, '');
function isStationName(x) {
  const st = squash((state.station && state.station.name) || '');
  const y = squash(x).replace(/(fm|radio|רדיו)$/, '');
  return !!st && y.length >= 2 && (st.includes(y) || y.includes(st));
}
// The station's server turned letters it couldn't encode into "?" before
// sending ("??????? - ??? ??????"): the text is gone, so there's nothing to show.
function isLostText(t) {
  const lost = (t.match(/[?�]/g) || []).length;
  const letters = (t.match(/\p{L}/gu) || []).length;
  return lost >= 3 && lost > letters;
}
function isFillerTitle(t) {
  if (!t) return true;
  if (isLostText(t)) return true;
  if (/powered by|streaming|^cdn\b/i.test(t) || GENERIC_WORDS.test(t.trim()) || isAdTitle(t)) return true;
  const parts = t.split(/\s+[-–—|]\s+/).map((x) => x.trim());
  // the song slot is a status word, or every part is a status word / the station name
  if (parts.length > 1 && GENERIC_WORDS.test(parts[parts.length - 1])) return true;
  return parts.every((p) => GENERIC_WORDS.test(p) || isStationName(p));
}

// ---------- ads: lower the volume while the station says an ad is on ----------
// Only explicit signals count: the ad server's own marker (adw_ad, parsed by the
// proxy) or a title that is nothing but "Advertisement" / "פרסומת" etc. A missing
// title, the station name, or talk never count — talk stations and DJ breaks
// would be hit otherwise.
const AD_WORDS =
  /^(advertisements?|advert|ads|commercials?|commercial break|ad ?break|spot ?block|sponsored|פרסומת|פרסומות|תשדיר|תשדירים|תשדירי פרסומת|פרסומות ותשדירים)$/i;
function isAdTitle(t) {
  const s = t.trim();
  if (AD_WORDS.test(s)) return true;
  // "Advertisement - 103FM" / "103FM - פרסומות". Not "Artist - <song titled Ads>":
  // an ad word in the song slot counts only when the other side is the station.
  const parts = s.split(/\s+[-–—|:]\s+/).map((x) => x.trim());
  if (parts.length !== 2) return false;
  const st = ((state.station && state.station.name) || '').toLowerCase();
  const isStation = (x) => !!st && !!x && (st.includes(x.toLowerCase()) || x.toLowerCase().includes(st));
  return AD_WORDS.test(parts[0]) || (AD_WORDS.test(parts[1]) && isStation(parts[0]));
}
const AD_MAX_MS = 6 * 60 * 1000; // never stay quiet longer than this without a new ad marker
const ad = { on: false, quiet: false, skipped: false, switchTimer: null, safetyTimer: null };
const adLevel = () => Math.min(1, Math.max(0.05, Number(state.settings.adLevel) || 0.5));
const adQuiet = () => ad.quiet && !ad.skipped && state.settings.adDuck !== false;

// The proxy reads metadata as the bytes arrive, but we hear them only after the
// player's buffer drains — wait that long so a song's tail isn't cut.
function bufferLeadMs() {
  const b = audio.buffered;
  if (!state.usingProxy || !b.length) return 0;
  return Math.min(20000, Math.max(0, (b.end(b.length - 1) - audio.currentTime) * 1000));
}
function setAdQuiet(q) {
  if (ad.quiet === q) return;
  ad.quiet = q;
  if (!q) ad.skipped = false;
  duckChanged();
}
// fade (~1s) to the new level and show it on the slider + song line
function duckChanged() {
  if (!state.settings) return; // before boot
  applyVolume(0.4);
  syncVolumeUI();
  renderNowPlaying();
}
// The user wants to hear it (or it was a wrong guess): full volume until this
// ad break / call is over. Used by the song-line click and by the slider.
function liftDuck() {
  if (adQuiet()) ad.skipped = true;
  if (callQuiet()) call.skipped = true;
}

// ---------- calls: lower the volume while another app uses the microphone ----------
const call = { active: false, skipped: false, apps: [] };
const callLevel = () => Math.min(1, Math.max(0.05, Number(state.settings.callLevel) || 0.5));
const callQuiet = () => call.active && !call.skipped && state.settings.callDuck !== false;
window.radio.onCall(({ active, apps }) => {
  call.active = active;
  call.apps = apps || [];
  if (!active) call.skipped = false; // next call ducks again
  duckChanged();
});
function adStart(ms) {
  clearTimeout(ad.safetyTimer);
  ad.safetyTimer = setTimeout(adEnd, (ms ? ms + 5000 : AD_MAX_MS) + bufferLeadMs());
  if (ad.on) return;
  ad.on = true;
  clearTimeout(ad.switchTimer);
  ad.switchTimer = setTimeout(() => setAdQuiet(true), bufferLeadMs());
}
function adEnd() {
  clearTimeout(ad.safetyTimer);
  if (!ad.on) return;
  ad.on = false;
  clearTimeout(ad.switchTimer);
  ad.switchTimer = setTimeout(() => setAdQuiet(false), bufferLeadMs());
}
function resetAd() {
  clearTimeout(ad.switchTimer);
  clearTimeout(ad.safetyTimer);
  ad.on = false;
  ad.skipped = false;
  if (ad.quiet) {
    ad.quiet = false;
    applyVolume();
    syncVolumeUI();
  }
}

// iHeart streams pack extra fields into the title:
//   Migos - text="Handsome And Wealthy" song_spot="M" length="00:03:30" amgArtworkURL="https://…" …
// Keep "Artist - Song" and the cover URL; drop the rest.
function parseTitle(raw) {
  const at = raw.search(/\btext="/);
  if (at < 0) return { title: raw, art: '' };
  const f = {};
  for (const [, k, v] of raw.slice(at).matchAll(/(\w+)="([^"]*)"/g)) f[k] = v;
  const artist = raw.slice(0, at).replace(/\s*[-–]\s*$/, '').trim();
  const song = (f.text || '').trim();
  const art = /^https:\/\//.test(f.amgArtworkURL || '') ? f.amgArtworkURL : '';
  return { title: artist && song ? `${artist} - ${song}` : song || artist, art };
}

window.radio.onMetadata(({ id, title, ad: adFlag, ad_ms }) => {
  if (Number(id) !== state.streamId) return;
  const parsed = parseTitle((title || '').trim());
  const t = parsed.title;
  if (adFlag || (t && isAdTitle(t))) {
    adStart(ad_ms); // the last real song stays on screen
    return;
  }
  if (title != null) adEnd(); // any new non-ad metadata means the break is over
  if (isFillerTitle(t)) {
    // keep the last real song if the station only sent filler between songs
    if (!state.song) state.noInfo = true;
    renderNowPlaying();
    return;
  }
  state.noInfo = false;
  state.artwork = parsed.art;
  const i = t.indexOf(' - ');
  if (i > 0) {
    state.artist = t.slice(0, i).trim();
    state.song = t.slice(i + 3).trim();
  } else {
    state.artist = '';
    state.song = t;
  }
  renderNowPlaying();
  noteForHistory();
});

// ---------- recently played ----------
// A song is logged once it has really played for a while, so titles that
// flash by (jingles, mis-sends, a quick station switch) stay out.
const HISTORY_MAX = 10;
const HISTORY_MIN_MS = 20000;
let histPending = null;
function history() {
  return Array.isArray(state.settings.history) ? state.settings.history : (state.settings.history = []);
}
const sameSong = (a, b) => a.artist.toLowerCase() === b.artist.toLowerCase() && a.song.toLowerCase() === b.song.toLowerCase();
function noteForHistory() {
  const line = songLine();
  if (histPending && histPending.line === line) return;
  if (histPending) clearTimeout(histPending.timer);
  histPending = null;
  if (!line || !state.station || !currentIsSong()) return;
  const entry = { artist: state.artist, song: state.song, station: state.station.name };
  const sid = state.streamId;
  histPending = {
    line,
    // metadata arrives before the audio is heard: count from when it's audible
    timer: setTimeout(() => {
      histPending = null;
      if (sid !== state.streamId || !state.playing || songLine() !== line) return;
      const list = history().filter((h) => !sameSong(h, entry));
      list.unshift({ ...entry, t: Date.now() });
      state.settings.history = list.slice(0, HISTORY_MAX);
      window.radio.save({ history: state.settings.history });
      if (state.dropdown === 'history') renderList('history', true);
    }, HISTORY_MIN_MS + bufferLeadMs()),
  };
}

// ---------- Spotify ----------
// Some stations put a show name, promo, spot code, phone number or frequency
// where the song goes ("Breakfasters with Daniel Burt", "- Tim Hanley Show",
// "Arby's - RBRA0026000 ~", "Xplore - Coming Soon ~", "kz"). Those still show
// as text, but get no Spotify link and stay out of recently played.
// Only sure signs count: anything that might be a real song keeps its link.
// a web address in either slot, or a "<name> is live" placeholder that some
// streaming servers send when nothing is playing
const PROMO = /www\.|https?:\/\/|\b[a-z0-9-]+\.(?:com|net|org|fm|io|radio|live|online|info|tv|co\.[a-z]{2})\b/i;
const PROMO_SONG = /^(coming soon|up next|stay tuned|call now|listen live)$|\S\s+is\s+(?:now\s+)?(?:live|on air)!*$/i; // in the song slot
// a lone title that names a show: "Breakfasters with Daniel Burt", "The Morning Show"
const SHOW = /\S\s+with\s+\p{Lu}|\b(show|breakfast|program(me)?)$|^(תוכנית|התוכנית)\s/iu;
const SPOT_CODE = /\b[A-Z]{2,}\d{3,}[A-Z0-9]*\b/; // RBRA0026000
const FREQ = /\b\d{2,3}(?:[.,]\d{1,2})?\s?(?:fm|am|mhz|khz)\b|\b(?:fm|am)\s?\d{2,3}(?:[.,]\d{1,2})?\b/i;
// Reads like a station's name, not a band's: "Radio"/"FM" as the first or last
// word, or an FM frequency (87–108) as the first or last word. Band names have
// these inside them or attached to other words, or use other numbers, so they
// don't match.
const STATIONISH = /^(?:radio|רדיו|fm)\s|\s(?:radio|רדיו|fm)$|[\p{L}\d]fm$|^(?:8[7-9]|9\d|10[0-8])(?:[.,]\d{1,2})?\s|\s(?:8[7-9]|9\d|10[0-8])(?:[.,]\d{1,2})?$/iu;
const digitsIn = (s) => (s.match(/\d/g) || []).length;
const PHONE = (s) => /(?:\+|\b)\d[\d\s().-]{5,}\d\b/.test(s) && digitsIn(s.match(/(?:\+|\b)\d[\d\s().-]{5,}\d\b/)[0]) >= 8; // not "867-5309"
function isSong(artist, song, stationName) {
  artist = (artist || '').trim();
  song = (song || '').trim();
  if (!song || /~\s*$/.test(song) || PROMO_SONG.test(song)) return false; // "~" marks promos/ads on some stations
  if (/^[-–—]\s/.test(song)) return false; // "- Tim Hanley Show": empty artist slot
  // a lone title: only a tag of 1–3 letters ("kz") or a show name is sure
  if (!artist && (/^\p{L}{1,3}$/u.test(song) || SHOW.test(song))) return false;
  const st = squash(stationName || '');
  for (const [p, isSongSlot] of [[artist, false], [song, true]]) {
    if (!p) continue;
    if (PROMO.test(p) || SPOT_CODE.test(p) || FREQ.test(p) || PHONE(p)) return false;
    // the station's own name in full, or a station-like part of it
    const full = squash(p);
    const named = st && (full === st || (full.length >= 4 && st.includes(full)));
    // Only a name that reads like a station counts: a station that plays one
    // artist is often named after them and sends that name as the artist of
    // every real song. In the song slot an exact match is enough too.
    const stationish = STATIONISH.test(p);
    if (named && (stationish || (isSongSlot && full === st))) return false;
  }
  return true;
}
const currentIsSong = () => isSong(state.artist, state.song, state.station && state.station.name);

function openSpotify(artist, song) {
  const q = [artist, song].filter(Boolean).join(' ').trim();
  if (q) window.radio.openSpotify(q);
}
$('#btnSpotify').addEventListener('click', () => openSpotify(state.artist, state.song));

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
for (const id of ['#songText', '#artistText', '#vizSmall']) {
  $(id).addEventListener('click', () => {
    if (duckFactor() < 1) {
      liftDuck();
      duckChanged();
      return;
    }
    copySong();
  });
}

const HE = /^he\b/i.test(navigator.language);
const AD_TEXT = HE ? 'פרסומות · הווליום הונמך' : 'Ads · volume lowered';
const AD_TIP = HE ? 'לחיצה מחזירה את הווליום עד סוף הפרסומות' : 'Click to restore the volume for this break';
const CALL_TEXT = HE ? 'שיחה פעילה · הווליום הונמך' : 'On a call · volume lowered';
const CALL_TIP = HE ? 'לחיצה (או הזזת הווליום) מחזירה את הווליום עד סוף השיחה' : 'Click (or move the volume) to restore it for this call';

function renderNowPlaying() {
  const st = state.station;
  const noInfo = !!st && state.noInfo && !state.song;
  const inCall = callQuiet();
  const adShown = inCall || adQuiet();
  const duckText = inCall ? CALL_TEXT : AD_TEXT;
  const duckTip = inCall ? `${CALL_TIP}${call.apps.length ? `\n(${call.apps.join(', ')})` : ''}` : AD_TIP;
  body.classList.toggle('ad-quiet', adShown);
  $('#btnSpotify').hidden = !songLine() || adShown || !currentIsSong();
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
  if (adShown) {
    $('#songText').textContent = duckText;
    $('#songText').title = duckTip;
    $('#songText').classList.add('can-copy');
  }

  const tip = adShown
    ? `${duckText}\n${duckTip}`
    : [state.artist, state.song].filter(Boolean).join(' — ') || (st ? (noInfo ? `${st.name} · ${NO_INFO_TEXT}` : st.name) : '');
  $('#vizSmall').title = songLine() && !adShown ? `${tip}
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

// ---------- random station ----------
// Every press is a fresh, unbiased crypto draw — no pre-shuffled order to walk
// through: first a country (any of them, the current one included), then a
// station in it. Stations picked recently are left out so the same few don't
// keep coming back.
const shuffleRecent = [];

function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n; // reject the tail → no modulo bias
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

async function playRandom() {
  const btn = $('#btnShuffle');
  if (btn.classList.contains('busy')) return;
  const curId = state.station && state.station.stationuuid;

  // draw a country; if its list can't load, draw again from the rest
  let cc = null;
  let pool = [];
  const left = [...COUNTRIES];
  btn.classList.add('busy');
  while (left.length && !pool.length) {
    cc = left.splice(randomIndex(left.length), 1)[0];
    try {
      pool = (await fetchStations(cc)).filter((s) => s.stationuuid !== curId);
    } catch {
      pool = [];
    }
  }
  btn.classList.remove('busy');
  if (!pool.length) return toast(HE ? 'אין תחנות להגרלה' : 'No stations to pick from');

  // remember up to half the pool (max 40) so repeats stay rare but possible
  const memory = Math.min(40, Math.floor(pool.length / 2));
  const recent = new Set(shuffleRecent.slice(shuffleRecent.length - memory));
  const fresh = pool.filter((s) => !recent.has(s.stationuuid));
  const choices = fresh.length ? fresh : pool;
  const pick = choices[randomIndex(choices.length)];

  if (curId && shuffleRecent[shuffleRecent.length - 1] !== curId) shuffleRecent.push(curId);
  shuffleRecent.push(pick.stationuuid);
  if (shuffleRecent.length > 80) shuffleRecent.splice(0, shuffleRecent.length - 80);
  if (state.dropdown) closeDropdown();
  if (cc !== state.settings.country) {
    // follow the station: flag and stations list now show its country
    state.settings.country = cc;
    window.radio.save({ country: cc });
    syncCountryUI();
  }
  state.stations = await fetchStations(cc);
  state.stationsCountry = cc;
  setStation(pick, true);
}

// ---------- visualizer ----------
const vizBig = $('#vizBig');
const vizSmall = $('#vizSmall');
let silentFrames = 0;
let synthPhase = 0;
const VIZ_TONES = (() => {
  const cs = getComputedStyle(document.documentElement);
  return ['--tone-1', '--tone-2', '--tone-3'].map((v) => cs.getPropertyValue(v).trim());
})();

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (w && (c.width !== w || c.height !== h)) {
    c.width = w;
    c.height = h;
  }
}

// `step` = frames' worth of time since the last draw (1 = 1/60 s), so the
// synthetic wave moves at the same speed whatever the frame rate.
function levels(n, step) {
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
    if (silentFrames < 23) return out; // ~0.75 s of silence
  }
  // idle wave when paused, synthetic motion if analyser gives nothing while playing
  synthPhase += (state.playing ? 0.09 : 0.025) * step;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
    const wave = (Math.sin(i * 0.55 + synthPhase) + Math.sin(i * 0.23 - synthPhase * 1.7)) * 0.25 + 0.5;
    out[i] = state.playing ? wave * (1 - k * 0.6) * 0.8 : 0.06 + wave * 0.05;
  }
  return out;
}

function drawViz(c, n, step) {
  fitCanvas(c);
  const g = c.getContext('2d');
  const { width: W, height: H } = c;
  g.clearRect(0, 0, W, H);
  const lv = levels(n, step);
  const slot = W / n;
  const bw = Math.max(1.5, slot * 0.42);
  const mid = H / 2;
  g.globalAlpha = state.playing ? 0.95 : 0.45;
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, lv[i] * H * 0.96);
    // three solid bands, mirrored: core (bass) in the middle, lighter toward the edges
    const k = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
    g.fillStyle = VIZ_TONES[k < 0.36 ? 0 : k < 0.7 ? 1 : 2];
    const x = i * slot + (slot - bw) / 2;
    const r = bw / 2;
    g.beginPath();
    g.roundRect(x, mid - h / 2, bw, h, r);
    g.fill();
  }
  g.globalAlpha = 1;
}

// Every repaint of this transparent window costs GPU time, so the visualizer
// doesn't run at the screen's rate: 30 fps while playing, 12 fps for the idle
// wave, nothing in logo mode or while the window is hidden. Waiting on a timer
// between frames (not a back-to-back rAF loop) lets the compositor sleep.
const FRAME_GAP = { playing: 1000 / 30, idle: 1000 / 12 };
let lastDraw = 0;
function frame(now) {
  const step = lastDraw ? Math.min(6, (now - lastDraw) / (1000 / 60)) : 1;
  lastDraw = now;
  if (!document.hidden) {
    if (state.mode === 'expanded') drawViz(vizBig, 38, step);
    else if (state.mode === 'compact') drawViz(vizSmall, 24, step);
  }
  // minus a few ms: the rAF then lands on the next vsync instead of one later
  const gap = state.playing ? FRAME_GAP.playing : FRAME_GAP.idle;
  setTimeout(() => requestAnimationFrame(frame), gap - 6);
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
// While ducked the slider shows what you actually hear (32% at 50% → 16%),
// so grabbing it continues from there.
function syncVolumeUI() {
  const pct = Math.round((state.muted ? 0 : state.settings.volume * duckFactor()) * 100);
  for (const s of [$('#volBig'), $('#volSmall')]) {
    s.value = pct;
    s.style.setProperty('--val', pct + '%');
    s.title = `Volume ${pct}%`;
  }
  setIcon($('#btnMuteBig'), state.muted || pct === 0 ? 'mute' : 'volume');
}
function onVolumeInput(e) {
  // moving the volume during an ad / call means "I want to set it myself":
  // the duck lets go for the rest of it, and nothing restores over the new value
  const ducked = duckFactor() < 1;
  if (ducked) liftDuck();
  state.settings.volume = Number(e.target.value) / 100;
  state.muted = false;
  syncVolumeUI();
  applyVolume();
  saveVolume();
  if (ducked) renderNowPlaying();
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
  history: { root: $('#ddHistory'), btn: $('#btnHistory') },
};
for (const k of Object.keys(dd)) {
  dd[k].panel = dd[k].root.querySelector('.dd-panel');
  dd[k].list = dd[k].root.querySelector('.dd-list');
  dd[k].input = dd[k].root.querySelector('input');
  dd[k].btn.addEventListener('click', () => (state.dropdown === k ? closeDropdown() : openDropdown(k)));
  if (!dd[k].input) continue;
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
    if (d.input) d.input.value = '';
    renderList(kind);
    if (d.input) d.input.focus();
    if (kind === 'stations') loadStations();
    else if (kind === 'country') loadCountries();
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
    const list = await fetchStations(cc, force);
    if (state.settings.country !== cc) return; // switched country meanwhile
    state.stations = list;
    state.stationsCountry = cc;
    renderList('stations', true);
  } catch {
    if (state.settings.country === cc) listState('stations', 'error', () => loadStations(true));
  }
}

// One list per country, kept for the session (random play draws from all of them).
const stationCache = new Map(); // cc → Promise<station[]>
function fetchStations(cc, force = false) {
  if (force || !stationCache.has(cc)) {
    const p = window.radio
      .api(`stations/search?countrycode=${encodeURIComponent(cc)}&hidebroken=true&order=clickcount&reverse=true&limit=400`)
      .then((rows) => {
        const seen = new Set();
        return rows.filter((s) => {
          const key = (s.name || '').trim().toLowerCase();
          if (!key || !s.url_resolved || s.hls === 1 || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    p.catch(() => stationCache.get(cc) === p && stationCache.delete(cc)); // a failed load is retried next time
    stationCache.set(cc, p);
  }
  return stationCache.get(cc);
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
  const q = d.input ? d.input.value.trim().toLowerCase() : '';
  const frag = document.createDocumentFragment();
  const scroll = d.list.scrollTop;

  if (kind === 'history') {
    const list = history();
    if (!list.length) {
      const box = el('div', 'dd-state hist-empty', HE ? 'עוד לא הושמעו שירים' : 'No songs played yet');
      return d.list.replaceChildren(box);
    }
    for (const h of list) frag.appendChild(historyRow(h));
  } else if (kind === 'stations') {
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

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
function whenPlayed(t) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? timeFmt.format(d) : `${dayFmt.format(d)} ${timeFmt.format(d)}`;
}

// click the row = copy "Artist - Song"; the Spotify icon opens it there
function historyRow(h) {
  const line = [h.artist, h.song].filter(Boolean).join(' - ');
  const b = el('button', 'st-item hist-item');
  b.title = `${line}\n(click to copy)`;
  const txt = el('span', 'st-text');
  const name = el('span', 'st-name', h.song);
  name.dir = 'auto';
  const meta = el('span', 'st-meta', [whenPlayed(h.t), h.artist, h.station].filter(Boolean).join(' · '));
  meta.dir = 'auto';
  txt.append(name, meta);
  const spot = el('span', 'spot-btn');
  spot.innerHTML = ICONS.spotify;
  spot.title = 'Open in Spotify';
  spot.addEventListener('click', (e) => {
    e.stopPropagation();
    openSpotify(h.artist, h.song);
  });
  // entries saved before the song check existed may be shows or promos
  if (isSong(h.artist, h.song, h.station)) b.append(txt, spot);
  else b.append(txt);
  b.addEventListener('click', async () => {
    await window.radio.copy(line);
    toast('✓ ' + line);
  });
  return b;
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
$('#btnShuffle').addEventListener('click', () => {
  autoSkips = 0;
  playRandom();
});
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
  if (['adDuck', 'adLevel', 'callDuck', 'callLevel'].some((k) => k in rest)) duckChanged();
  bumpIdle();
});
window.radio.onTogglePlay(togglePlay);

function reportNowPlaying() {
  window.radio.nowPlaying({
    station: state.station ? state.station.name : '',
    title: [state.artist, state.song].filter(Boolean).join(' — '),
    playing: state.playing,
  });
  updateMediaSession();
}

// ---------- Windows media controls (SMTC) ----------
// WebView2 hands the Media Session to Windows: the volume flyout / lock screen
// show the song + station, and the keyboard's media keys drive the widget.
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
let msKey = '';
function updateMediaSession() {
  if (!ms) return;
  const st = state.station;
  const meta = st
    ? {
        title: state.song || st.name,
        // the flyout shows only title + artist, so the station rides along here
        artist: state.song ? [state.artist, st.name].filter(Boolean).join(' · ') : '',
        album: st.name,
        artwork: state.artwork ? [{ src: state.artwork }] : st.favicon ? [{ src: st.favicon }] : [],
      }
    : null;
  const key = JSON.stringify(meta);
  if (key !== msKey) {
    msKey = key;
    ms.metadata = meta ? new MediaMetadata(meta) : null;
  }
  ms.playbackState = state.playing ? 'playing' : st ? 'paused' : 'none';
}
// next / previous step through favorites (or the country list without favorites)
function stepStation(dir) {
  const list = favorites().length ? favorites() : state.stations;
  if (!list.length) return;
  const i = state.station ? list.findIndex((s) => s.stationuuid === state.station.stationuuid) : -1;
  const next = list[(i + dir + list.length) % list.length];
  if (next) setStation(next, true);
}
if (ms) {
  const handlers = {
    play: () => !state.playing && play(),
    pause: () => state.playing && stop(),
    stop: () => stop(),
    nexttrack: () => stepStation(1),
    previoustrack: () => stepStation(-1),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(action, fn);
    } catch {}
  }
}
window.radio.onWake(() => setMode('expanded'));
// a new version is announced by the backend (dialog + dot on the tray icon)
window.radio.onUpdateFailed(() => toast(HE ? 'העדכון נכשל — נסה שוב מתפריט המגש' : 'The update failed — try again from the tray menu'));

// ---------- boot ----------
(async function boot() {
  const init = await window.radio.init();
  state.settings = init.settings;
  state.proxyPort = init.proxyPort;
  // history saved before iHeart titles were parsed
  for (const h of history()) {
    if (/\btext="/.test(h.song)) h.song = parseTitle(`- ${h.song}`).title;
  }
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
