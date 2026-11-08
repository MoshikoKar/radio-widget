// Inline SVG icons (static markup only).
const svg = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

window.ICONS = {
  star: svg('<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>'),
  play: svg('<path d="M8 5.2v13.6a.6.6 0 0 0 .9.5l11-6.8a.6.6 0 0 0 0-1L8.9 4.7a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>'),
  volume: svg('<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke-width="1.5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  mute: svg('<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke-width="1.5"/><path d="m16 9 5 6"/><path d="m21 9-5 6"/>'),
  pin: svg('<path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z" fill="currentColor" fill-opacity=".25"/><path d="M12 15v6"/>'),
  windows:
    '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">' +
    '<rect class="w1" x="2.5" y="2.5" width="9" height="9" rx="1"/><rect class="w2" x="12.5" y="2.5" width="9" height="9" rx="1"/>' +
    '<rect class="w3" x="2.5" y="12.5" width="9" height="9" rx="1"/><rect class="w4" x="12.5" y="12.5" width="9" height="9" rx="1"/></svg>',
  radio: svg('<rect x="3" y="8" width="18" height="12" rx="2.5"/><path d="m7 8 9-5"/><circle cx="15.5" cy="14" r="2.6"/><path d="M6.5 12.5h3M6.5 15.5h3"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  maximize: svg('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>'),
  minimize: svg('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  note: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>'),
  retry: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  warn: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'),
};
