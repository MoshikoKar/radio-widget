// Inline SVG icons (static markup only).
const svg = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

window.ICONS = {
  star: svg('<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>'),
  // filled, with a matching stroke to round the corners; drawn edges span x 6–18.9,
  // centered in the 24 box with a ~0.4 nudge right so the triangle reads as centered
  play: svg('<path d="M6.8 6.3v11.4a1 1 0 0 0 1.5.86l9.3-5.7a1 1 0 0 0 0-1.72l-9.3-5.7A1 1 0 0 0 6.8 6.3z" fill="currentColor" stroke-width="1.6"/>'),
  pause: svg('<rect x="6.5" y="5.5" width="3.6" height="13" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.9" y="5.5" width="3.6" height="13" rx="1.3" fill="currentColor" stroke="none"/>'),
  shuffle: svg('<path d="M16 4h4v4"/><path d="M4 19 20 4"/><path d="M20 16v4h-4"/><path d="m14.5 14.5 5.5 5.5"/><path d="M4 5l5 5"/>'),
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
  history: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>'),
  spotify:
    '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="10.5" fill="#1ed760"/>' +
    '<path d="M6.6 9.3Q12 7.5 17.6 10.2M7.3 12.5Q12 11 16.5 13.3M8 15.6Q12 14.5 15.4 16.1" fill="none" stroke="#121212" stroke-width="1.7" stroke-linecap="round"/></svg>',
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  warn: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'),
};
