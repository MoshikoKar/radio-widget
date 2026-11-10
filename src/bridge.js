// Bridge: exposes the `window.radio` API the UI uses,
// implemented on top of Tauri's global API (app.withGlobalTauri = true).
'use strict';
(function () {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const listen = T.event.listen;
  const appWindow = () => T.window.getCurrentWindow();

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback for contexts where the async clipboard API is unavailable
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  window.radio = {
    init: () => invoke('init'),
    setMode: (next) => invoke('set_mode', { next }),
    dropdown: (open) => invoke('dropdown', { open }),
    setStayOnTop: (on) => invoke('set_stay_on_top_cmd', { on }),
    setAutoStart: (on) => invoke('set_auto_start_cmd', { on }),
    save: (patch) => invoke('save', { patch }),
    api: (q) => invoke('api', { q }),
    cursorInside: () => invoke('cursor_inside'),
    // native OS window drag; the backend saves the position when it ends
    dragStart: () => appWindow().startDragging(),
    dragEnd: () => {},
    logoMenu: () => invoke('logo_menu'),
    quit: () => invoke('quit'),
    hide: () => invoke('hide'),
    copy,
    nowPlaying: (np) => invoke('now_playing', { np }),
    openSpotify: (query) => invoke('open_spotify', { query }),
    onCall: (cb) => listen('call', (e) => cb(e.payload)),
    onTogglePlay: (cb) => listen('toggle-play', () => cb()),
    onMetadata: (cb) => listen('metadata', (e) => cb(e.payload)),
    onSettings: (cb) => listen('settings-changed', (e) => cb(e.payload)),
    onWake: (cb) => listen('wake', () => cb()),
    openSettings: () => invoke('open_settings'),
    // after a start with Windows the window stays hidden until the UI is in its mode
    showReady: () => invoke('show_ready'),
    // settings window → backend: saves, refreshes the tray, tells the widget
    setSettings: (patch) => invoke('set_settings', { patch }),
    updateState: () => invoke('update_state'),
    updateClick: () => invoke('update_click'),
    onUpdateState: (cb) => listen('update-state', (e) => cb(e.payload)),
    onUpdateFailed: (cb) => listen('update-failed', () => cb()),
    onOcclusion: (cb) => listen('widget-occlusion', (e) => cb(e.payload)),
  };
})();
