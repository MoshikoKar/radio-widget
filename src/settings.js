/* Radio Widget — settings window.
   Opened from the gear button (or the tray menu) and destroyed when closed, so
   it costs nothing while it isn't open. Changes go to the backend, which saves
   them and tells the widget; changes made elsewhere (tray menu) come back the
   same way. Only the open tab is rendered, and flags of off-screen rows aren't
   loaded (content-visibility in the CSS). */
'use strict';

const $ = (sel) => document.querySelector(sel);
const HE = /^he\b/i.test(navigator.language);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
document.querySelectorAll('[data-icon]').forEach((n) => {
  n.innerHTML = ICONS[n.dataset.icon] || '';
});

const ST = HE
  ? {
      title: 'Radio Widget — הגדרות',
      countries: 'מדינות',
      volume: 'ווליום',
      update: 'עדכון',
      search: 'חיפוש מדינה',
      stations: (n) => `${n} תחנות`,
      keepOne: 'צריך להשאיר לפחות מדינה אחת',
      ads: 'להנמיך בזמן פרסומות',
      calls: 'להנמיך בזמן שיחות',
      ofVolume: 'מהווליום הנוכחי',
      version: (v) => `גרסה ${v}`,
      check: 'בדיקת עדכונים',
      checking: 'בודק…',
      latest: 'הגרסה העדכנית מותקנת',
      again: 'בדיקה חוזרת',
      available: (v) => `גרסה ${v} זמינה`,
      updateNow: 'עדכון עכשיו',
      restarts: 'הווידג׳ט יופעל מחדש בסיום',
      openPage: 'לדף ההורדה',
      downloading: (p) => `מוריד… ${p}%`,
      failed: 'הבדיקה נכשלה — בדוק את החיבור לאינטרנט',
      retry: 'ניסיון נוסף',
    }
  : {
      title: 'Radio Widget — Settings',
      countries: 'Countries',
      volume: 'Volume',
      update: 'Update',
      search: 'Search countries',
      stations: (n) => `${n} stations`,
      keepOne: 'Keep at least one country',
      ads: 'Lower volume during ads',
      calls: 'Lower volume during calls',
      ofVolume: 'of the current volume',
      version: (v) => `Version ${v}`,
      check: 'Check for updates',
      checking: 'Checking…',
      latest: 'You have the latest version',
      again: 'Check again',
      available: (v) => `Version ${v} is available`,
      updateNow: 'Update now',
      restarts: 'The widget restarts by itself when it’s done',
      openPage: 'Open download page',
      downloading: (p) => `Downloading… ${p}%`,
      failed: 'Couldn’t check — check your internet connection',
      retry: 'Try again',
    };

// every country with a bundled flag (ISO 3166-1, minus places without radio)
const ALL_COUNTRIES = (
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
).split(' ');
const DEFAULT_COUNTRIES = ['IL', 'US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'ZA'];

const names = (locales) => {
  try {
    return new Intl.DisplayNames(locales, { type: 'region' });
  } catch {
    return null;
  }
};
const regionNames = names([navigator.language, 'en']);
const enRegionNames = names(['en']);
const countryName = (cc) => (regionNames && regionNames.of(cc)) || cc;

const ui = { tab: 'countries', order: [], counts: null };
let settings = {};
let updateInfo = { state: 'idle', version: null, percent: 0, current: '', portable: false };

const search = $('#countrySearch');
const list = $('#countryList');
const page = (id) => $(`.tab-page[data-page="${id}"]`);

function myCountries() {
  return Array.isArray(settings.countries) && settings.countries.length ? settings.countries : DEFAULT_COUNTRIES;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- tabs ----------
function showTab(id) {
  ui.tab = id;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
  for (const pg of document.querySelectorAll('.tab-page')) pg.hidden = pg.dataset.page !== id;
  render();
  if (id === 'countries') search.focus();
}

function render(keepScroll = false) {
  const hasUpdate = updateInfo.state === 'available' || updateInfo.state === 'downloading';
  $('.tab[data-tab="update"]').classList.toggle('dot', hasUpdate);
  if (ui.tab === 'countries') renderCountries(keepScroll);
  else if (ui.tab === 'volume') renderVolume();
  else renderUpdate();
}

// ---------- countries ----------
function renderCountries(keepScroll) {
  const q = search.value.trim().toLowerCase();
  const mine = new Set(myCountries());
  const scroll = list.scrollTop;
  const frag = document.createDocumentFragment();
  for (const cc of ui.order) {
    const on = mine.has(cc);
    const n = ui.counts ? ui.counts.get(cc) || 0 : null;
    if (n === 0 && !on) continue; // no stations there
    const name = countryName(cc);
    if (q) {
      const en = (enRegionNames && enRegionNames.of(cc)) || '';
      if (!name.toLowerCase().includes(q) && !en.toLowerCase().includes(q) && cc.toLowerCase() !== q) continue;
    }
    const b = el('button', 'st-item ct-item');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(on));
    const txt = el('span', 'st-text');
    txt.appendChild(el('span', 'st-name', name));
    const check = el('span', 'ct-check');
    check.innerHTML = ICONS.check;
    b.append(el('span', `flag fi fi-${cc.toLowerCase()}`), txt);
    if (n) b.appendChild(el('span', 'ct-count', ST.stations(n)));
    b.appendChild(check);
    b.addEventListener('click', () => toggleCountry(cc));
    frag.appendChild(b);
  }
  if (!frag.childElementCount) {
    const box = el('div', 'dd-state');
    box.innerHTML = ICONS.search;
    box.style.opacity = '0.5';
    frag.appendChild(box);
  }
  list.replaceChildren(frag);
  list.scrollTop = keepScroll ? scroll : 0;
}

async function toggleCountry(cc) {
  // the widget may have switched country since this window opened
  try {
    settings.country = (await window.radio.init()).settings.country;
  } catch {}
  const mine = [...myCountries()];
  const i = mine.indexOf(cc);
  if (i >= 0) {
    if (mine.length === 1) return toast(ST.keepOne);
    mine.splice(i, 1);
  } else {
    mine.push(cc);
  }
  const patch = { countries: mine };
  // the country being browsed was removed: the widget shows the first one left
  // (whatever is playing keeps playing)
  if (i >= 0 && settings.country === cc) patch.country = mine[0];
  apply(patch);
}

function apply(patch) {
  Object.assign(settings, patch);
  window.radio.setSettings(patch);
  render(true);
}

search.addEventListener('input', () => render());
search.addEventListener('keydown', (e) => {
  const items = [...list.querySelectorAll('.ct-item')];
  if (!items.length) return;
  let i = items.findIndex((n) => n.classList.contains('kb'));
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (step) {
    e.preventDefault();
    if (i >= 0) items[i].classList.remove('kb');
    i = Math.max(0, Math.min(items.length - 1, (i < 0 ? -step : i) + step));
    items[i].classList.add('kb');
    items[i].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    (items[i] || items[0]).click();
  }
});

// ---------- ad / call volume ----------
function renderVolume() {
  const block = (title, onKey, levelKey) => {
    const on = settings[onKey] !== false;
    const cur = Math.round((Number(settings[levelKey]) || 0.5) * 100);
    const box = el('div', 'set-block');
    const head = el('div', 'set-row');
    const sw = el('button', 'switch');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', title);
    sw.addEventListener('click', () => apply({ [onKey]: !on }));
    head.append(el('span', 'set-label', title), sw);
    const row = el('div', 'set-row');
    const seg = el('div', 'seg');
    for (const pct of [30, 50, 70]) {
      const b = el('button', '', pct + '%');
      b.setAttribute('aria-pressed', String(cur === pct));
      b.disabled = !on;
      b.addEventListener('click', () => apply({ [levelKey]: pct / 100 }));
      seg.appendChild(b);
    }
    row.append(seg, el('span', 'set-hint', ST.ofVolume));
    box.append(head, row);
    return box;
  };
  page('volume').replaceChildren(block(ST.ads, 'adDuck', 'adLevel'), el('div', 'set-sep'), block(ST.calls, 'callDuck', 'callLevel'));
}

// ---------- update ----------
function renderUpdate() {
  const u = updateInfo;
  const status = el('div', 'upd-status');
  const btn = el('button', 'btn');
  btn.disabled = u.state === 'checking' || u.state === 'downloading';
  btn.addEventListener('click', () => window.radio.updateClick());
  const parts = [el('div', 'upd-ver', 'Radio Widget'), el('div', 'set-hint', ST.version(u.current)), el('div', 'set-sep'), status];
  if (u.state === 'available') {
    status.textContent = ST.available(u.version);
    status.classList.add('good');
    btn.textContent = u.portable ? ST.openPage : ST.updateNow;
    if (!u.portable) parts.push(el('div', 'set-hint', ST.restarts));
  } else if (u.state === 'downloading') {
    status.textContent = ST.downloading(u.percent);
    const bar = el('div', 'upd-bar');
    const fill = el('i');
    fill.style.width = u.percent + '%';
    bar.appendChild(fill);
    parts.push(bar);
    btn.textContent = ST.updateNow;
  } else if (u.state === 'checking') {
    status.textContent = ST.checking;
    btn.textContent = ST.check;
  } else if (u.state === 'uptodate') {
    status.textContent = ST.latest;
    status.classList.add('good');
    btn.textContent = ST.again;
    btn.classList.add('ghost');
  } else if (u.state === 'failed') {
    status.textContent = ST.failed;
    status.classList.add('bad');
    btn.textContent = ST.retry;
  } else {
    btn.textContent = ST.check;
    btn.classList.add('ghost');
  }
  parts.push(btn);
  page('update').replaceChildren(...parts);
}

// ---------- live changes from the widget / tray ----------
window.radio.onSettings((patch) => {
  const { autoStart, ...rest } = patch;
  Object.assign(settings, rest);
  render(true);
});
window.radio.onUpdateState((u) => {
  if (!u) return;
  updateInfo = u;
  render(true);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

// ---------- boot ----------
(async function boot() {
  document.title = ST.title;
  document.documentElement.dir = HE ? 'rtl' : 'ltr';
  search.placeholder = ST.search;
  const tabs = $('.tabs');
  for (const id of ['countries', 'volume', 'update']) {
    const b = el('button', 'tab', ST[id]);
    b.dataset.tab = id;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => showTab(id));
    tabs.appendChild(b);
  }
  const [init, upd] = await Promise.all([window.radio.init(), window.radio.updateState()]);
  settings = init.settings;
  if (upd) updateInfo = upd;

  // selected countries first, then the rest by name
  const mine = new Set(myCountries());
  const byName = (a, b) => countryName(a).localeCompare(countryName(b));
  ui.order = [
    ...ALL_COUNTRIES.filter((c) => mine.has(c)).sort(byName),
    ...ALL_COUNTRIES.filter((c) => !mine.has(c)).sort(byName),
  ];
  // an update is waiting: open on it
  showTab(updateInfo.state === 'available' || updateInfo.state === 'downloading' ? 'update' : 'countries');

  // how many stations each country has; countries with none are left out
  try {
    const rows = await window.radio.api('countries?hidebroken=true');
    const m = new Map();
    for (const r of rows) m.set(String(r.iso_3166_1 || '').toUpperCase(), Number(r.stationcount) || 0);
    if (m.size) {
      ui.counts = m;
      if (ui.tab === 'countries') render(true);
    }
  } catch {}
})();
