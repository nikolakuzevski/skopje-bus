/* store.js — the only code that touches localStorage. Small by design:
 * everything here is user preference, never transit data. */
(function () {
  const SB = (window.SB = window.SB || {});
  const KEY = 'sb.v1';

  const defaults = {
    pinnedStopId: null,     // the stop shown on boot, before geolocation answers
    favouriteStops: [],     // stop ids, ordered
    savedLines: [],         // route ids the user actually rides
    settings: {
      useGeolocation: true,
      debug: false
    }
  };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(defaults));
      const parsed = JSON.parse(raw);
      return {
        pinnedStopId: parsed.pinnedStopId != null ? parsed.pinnedStopId : null,
        favouriteStops: Array.isArray(parsed.favouriteStops) ? parsed.favouriteStops : [],
        savedLines: Array.isArray(parsed.savedLines) ? parsed.savedLines : [],
        settings: Object.assign({}, defaults.settings, parsed.settings || {})
      };
    } catch (err) {
      return JSON.parse(JSON.stringify(defaults));
    }
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (err) { /* private mode */ }
    window.dispatchEvent(new CustomEvent('sb:store'));
  }

  SB.store = {
    get: function () { return state; },

    pinnedStopId: function () { return state.pinnedStopId; },
    setPinnedStop: function (id) { state.pinnedStopId = id; persist(); },

    favourites: function () { return state.favouriteStops.slice(); },
    isFavourite: function (id) { return state.favouriteStops.indexOf(id) !== -1; },
    toggleFavourite: function (id) {
      const i = state.favouriteStops.indexOf(id);
      if (i === -1) {
        state.favouriteStops.push(id);
      } else {
        state.favouriteStops.splice(i, 1);
        if (state.pinnedStopId === id) state.pinnedStopId = null;
      }
      persist();
      return SB.store.isFavourite(id);
    },

    savedLines: function () { return state.savedLines.slice(); },
    isSavedLine: function (routeId) { return state.savedLines.indexOf(routeId) !== -1; },
    toggleLine: function (routeId) {
      const i = state.savedLines.indexOf(routeId);
      if (i === -1) state.savedLines.push(routeId);
      else state.savedLines.splice(i, 1);
      persist();
      return SB.store.isSavedLine(routeId);
    },

    settings: function () { return state.settings; },
    setSetting: function (key, value) { state.settings[key] = value; persist(); }
  };
})();
