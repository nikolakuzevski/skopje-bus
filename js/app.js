/* app.js — boot, the poll loop, tabs, and the one-second clock.
 *
 * Boot order matters and is the whole answer to "why is this fast": the cached
 * stop list draws a screen before any network call is made, and the live poll
 * only fills in numbers on a page that is already there. */
(function () {
  const SB = (window.SB = window.SB || {});

  const POLL_MS = 15000;
  const MAX_BACKOFF = 8;          // 15s * 8 = two minutes between retries
  const GEO_TIMEOUT_MS = 8000;
  const NEAREST_MAX_M = 1200;

  let vehicles = [];
  let lastPollAt = 0;
  let lastPosition = null;
  let failures = 0;
  let pollTimer = null;
  let tickTimer = null;
  let activeTab = 'stop';

  /* ---------------- status and errors ---------------- */

  function setBanner(text) {
    const b = SB.dom.qs('#banner');
    if (!b) return;
    if (!text) { b.hidden = true; b.textContent = ''; return; }
    b.hidden = false;
    b.textContent = text;
  }

  function paintStatus(now) {
    const s = SB.dom.qs('#status');
    if (!s) return;
    if (!lastPollAt) {
      s.className = 'status';
      s.textContent = failures ? 'нема врска' : 'се вчитува';
      return;
    }
    const age = (now - lastPollAt) / 1000;
    if (failures >= 2) {
      s.className = 'status down';
      s.textContent = 'нема врска · пред ' + SB.dom.fmtAge(age);
    } else if (age > 60) {
      s.className = 'status stale';
      s.textContent = 'застарено · пред ' + SB.dom.fmtAge(age);
    } else {
      s.className = 'status live';
      s.textContent = 'во живо · пред ' + SB.dom.fmtAge(age);
    }
  }

  /* ---------------- the poll loop ---------------- */

  function scheduleNext() {
    clearTimeout(pollTimer);
    if (document.hidden) return;   // never poll a screen nobody is looking at
    const factor = Math.min(Math.pow(2, failures), MAX_BACKOFF);
    pollTimer = setTimeout(poll, POLL_MS * factor);
  }

  function poll() {
    clearTimeout(pollTimer);
    if (document.hidden) return;

    SB.api.vehicles().then(function (list) {
      const now = Date.now();
      vehicles = list;
      lastPollAt = now;
      failures = 0;
      setBanner('');

      SB.history.observe(vehicles, now);
      SB.debug.resolve(vehicles, now);
      SB.uiStop.onData(vehicles, now);
      paintStatus(now);
      scheduleNext();
    }).catch(function (err) {
      failures += 1;
      if (err.kind === 'offline') {
        setBanner('Нема интернет врска. Се прикажуваат последните познати податоци.');
      } else if (err.kind === 'timeout') {
        setBanner('Изворот на податоци не одговара. Се обидувам повторно.');
      } else {
        setBanner('Изворот на податоци врати грешка. Се обидувам повторно.');
      }
      paintStatus(Date.now());
      scheduleNext();
    });
  }

  /* ---------------- geolocation ---------------- */

  function nearestStop(lat, lon) {
    let best = null;
    let bestD = Infinity;
    SB.net.stops.forEach(function (s) {
      const d = SB.dom.haversine(lat, lon, s.lat, s.lon);
      if (d < bestD) { bestD = d; best = s; }
    });
    return bestD <= NEAREST_MAX_M ? best : null;
  }

  function locate(force) {
    if (!force && !SB.store.settings().useGeolocation) {
      return Promise.resolve(null);
    }
    if (!navigator.geolocation) {
      return Promise.reject(new Error('Уредот не подржува локација.'));
    }
    return new Promise(function (resolve, reject) {
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          lastPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          resolve(SB.net.isLoaded() ? nearestStop(lastPosition.lat, lastPosition.lon) : null);
        },
        function () { reject(new Error('Локацијата не е достапна.')); },
        { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60000 }
      );
    });
  }

  /* ---------------- tabs ---------------- */

  const TABS = {
    stop: { panel: '#panel-stop', btn: '#tab-stop', mount: function () { SB.uiStop.render(); } },
    pick: { panel: '#panel-pick', btn: '#tab-pick', mount: function () { SB.uiPick.mount(); } },
    info: { panel: '#panel-info', btn: '#tab-info', mount: function () { SB.uiInfo.mount(); } }
  };

  function showTab(name) {
    activeTab = name;
    Object.keys(TABS).forEach(function (k) {
      const t = TABS[k];
      const panel = SB.dom.qs(t.panel);
      const btn = SB.dom.qs(t.btn);
      if (panel) panel.hidden = k !== name;
      if (btn) btn.setAttribute('aria-pressed', String(k === name));
    });
    TABS[name].mount();
  }

  /* ---------------- boot ---------------- */

  function chooseInitialStop() {
    const pinned = SB.store.pinnedStopId();
    if (pinned != null && SB.net.stopById.has(pinned)) return pinned;
    const favs = SB.store.favourites().filter(function (id) { return SB.net.stopById.has(id); });
    if (favs.length) return favs[0];
    return null;
  }

  function tick() {
    const now = Date.now();
    paintStatus(now);
    if (activeTab === 'stop') SB.uiStop.tick(now);
  }

  function boot() {
    Object.keys(TABS).forEach(function (k) {
      const btn = SB.dom.qs(TABS[k].btn);
      if (btn) btn.addEventListener('click', function () { showTab(k); });
    });

    paintStatus(Date.now());
    tickTimer = setInterval(tick, 1000);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(pollTimer);
        SB.history.flush();
      } else {
        poll();
      }
    });
    window.addEventListener('pagehide', function () { SB.history.flush(); });

    Promise.all([SB.history.load(), SB.debug.load()])
      .then(function () { return SB.net.ensure(); })
      .then(function () {
        // A screen exists from here on, before any live data arrives.
        const initial = chooseInitialStop();
        if (initial != null) SB.uiStop.setStop(initial);
        showTab('stop');
        poll();

        // Location is a nicety, never a blocker: it can only override an
        // empty screen, not a stop the user deliberately pinned.
        if (initial == null) {
          locate(false).then(function (stop) {
            if (stop && SB.uiStop.currentStopId() == null) SB.uiStop.setStop(stop.id);
          }).catch(function () { /* silent: the picker still works */ });
        } else {
          locate(false).then(function () { SB.uiStop.refreshHead(); })
            .catch(function () { /* silent */ });
        }
      })
      .catch(function () {
        setBanner('Не можам да ги вчитам линиите и постојките. Проверете ја врската.');
        showTab('stop');
      });

    window.addEventListener('sb:network', function () {
      if (activeTab === 'stop') SB.uiStop.render();
      if (activeTab === 'pick') SB.uiPick.render();
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* offline is optional */ });
      });
    }
  }

  SB.app = {
    showTab: showTab,
    locate: locate,
    pollNow: poll,
    lastPosition: function () { return lastPosition; },
    lastVehicles: function () { return vehicles; },
    repaintStop: function () { SB.uiStop.onData(vehicles, Date.now()); },
    nearestStop: nearestStop
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
