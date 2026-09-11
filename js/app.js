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
  // Every manual "refresh now" button (each row, and the bus detail view) ends
  // up calling the same poll() - there is no per-vehicle endpoint - so the
  // cooldown against bursting an undocumented API has to live here, shared
  // across all of them, not duplicated per button.
  const MANUAL_REFRESH_COOLDOWN_MS = 5000;
  let lastManualRefreshAt = 0;

  let vehicles = [];
  let lastPollAt = 0;
  let lastPosition = null;
  let failures = 0;
  let pollTimer = null;
  let tickTimer = null;
  let activeTab = 'stop';
  let polling = false;   // true while a /vehicles request is in flight

  /* ---------------- status and errors ---------------- */

  function setBanner(text) {
    const b = SB.dom.qs('#banner');
    if (!b) return;
    if (!text) { b.hidden = true; b.textContent = ''; return; }
    b.hidden = false;
    b.textContent = text;
  }

  /* The word ("во живо"/"застарено"/...) is the only part that belongs in the
   * aria-live region. The age ("пред N сек") changes every second by design,
   * and an aria-live region announces every text change it sees - wiring the
   * age into it would have a screen reader read out the feed's age once a
   * second, forever. Only writing #status-state when the word actually
   * changes keeps that region quiet except for real state transitions. */
  function paintStatus(now) {
    const s = SB.dom.qs('#status');
    const stateEl = SB.dom.qs('#status-state');
    const ageEl = SB.dom.qs('#status-age');
    if (!s || !stateEl || !ageEl) return;

    function setWord(cls, word) {
      s.className = 'status ' + cls;
      if (stateEl.textContent !== word) stateEl.textContent = word;
    }

    if (!lastPollAt) {
      setWord('', failures ? 'нема врска' : 'се вчитува');
      ageEl.textContent = '';
      return;
    }
    const age = (now - lastPollAt) / 1000;
    if (failures >= 2) {
      setWord('down', 'нема врска');
    } else if (age > 60) {
      setWord('stale', 'застарено');
    } else {
      setWord('live', 'во живо');
    }
    ageEl.textContent = ' · пред ' + SB.dom.fmtAge(age);
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
    // Without this, the timer, a visibility resume, and setStop's pollNow()
    // could all have a request in flight at once; a response landing out of
    // order can stamp a stale vehicle snapshot as the newest one, which
    // history.js would then read as a real (and wrong) segment timing.
    if (polling) return;
    polling = true;

    SB.api.vehicles().then(function (list) {
      polling = false;
      const now = Date.now();
      vehicles = list;
      lastPollAt = now;
      failures = 0;
      setBanner('');

      SB.history.observe(vehicles, now);
      SB.debug.resolve(vehicles, now);
      // uiStop.onData also refreshes the bus detail overlay, if one is open,
      // from the same recomputed arrivals - one call site, not a second
      // vehicles-consuming module to keep synchronised.
      SB.uiStop.onData(vehicles, now);
      paintStatus(now);
      scheduleNext();
      // Lets a manual per-row refresh know its data has landed, whichever
      // poll actually delivered it - the timer, a visibility resume, or the
      // tap itself. See js/ui-stop.js's row refresh button.
      window.dispatchEvent(new CustomEvent('sb:poll-settled'));
    }).catch(function (err) {
      polling = false;
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
      window.dispatchEvent(new CustomEvent('sb:poll-settled'));
    });
  }

  /**
   * A user-initiated "refresh now" - a row's button, or the bus detail view's.
   * Returns false (and triggers nothing) if one already happened too recently.
   */
  function requestManualRefresh() {
    const now = Date.now();
    if (now - lastManualRefreshAt < MANUAL_REFRESH_COOLDOWN_MS) return false;
    lastManualRefreshAt = now;
    poll();
    return true;
  }

  /** Poll now only if the backoff window since the last attempt has passed. */
  function pollRespectingBackoff() {
    const factor = Math.min(Math.pow(2, failures), MAX_BACKOFF);
    if (!lastPollAt || Date.now() - lastPollAt > POLL_MS * factor) {
      poll();
    } else {
      scheduleNext();
    }
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
    // Not a bottom tab - #btn-settings lives in the header as a small gear
    // icon (Инфо is a settings-shaped screen, not a place you go often), but
    // it is still wired through the exact same TABS machinery: showTab('info')
    // hides/shows the right panel and sets aria-pressed on whichever button
    // points at it, with no special-casing needed.
    info: { panel: '#panel-info', btn: '#btn-settings', mount: function () { SB.uiInfo.mount(); } }
  };

  function showTab(name) {
    const previous = activeTab;
    activeTab = name;
    if (previous && previous !== name && TABS[previous] && TABS[previous].unmount) {
      TABS[previous].unmount();
    }
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
    const gearBtn = SB.dom.qs('#btn-settings');
    if (gearBtn) gearBtn.appendChild(SB.dom.icon('settings'));

    paintStatus(Date.now());
    tickTimer = setInterval(tick, 1000);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(pollTimer);
        clearInterval(tickTimer);
        tickTimer = null;
        SB.history.flush();
      } else {
        if (!tickTimer) tickTimer = setInterval(tick, 1000);
        // Every app switch and screen unlock fires this. Polling immediately
        // every time would defeat the deliberate exponential backoff during an
        // upstream outage - ordinary backgrounding shouldn't erase a designed
        // safeguard against hammering an undocumented API.
        pollRespectingBackoff();
      }
    });
    window.addEventListener('pagehide', function () { SB.history.flush(); });

    let bootRetryMs = 15000;

    function bootNetwork() {
      Promise.all([SB.history.load(), SB.debug.load()])
        .then(function () { return SB.net.ensure(); })
        // Today's timetable, from cache only. Never a 12 MB download on boot.
        .then(function () { return SB.timetable.ensure(Date.now(), { cachedOnly: true }); })
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
          // Without a retry here, one failed boot fetch left the app
          // permanently stuck with an empty stop picker and a dead poll loop -
          // the user's only recovery was closing and reopening the PWA.
          setBanner('Не можам да ги вчитам линиите и постојките. Се обидувам повторно.');
          showTab('stop');
          setTimeout(bootNetwork, bootRetryMs);
          bootRetryMs = Math.min(bootRetryMs * 2, 120000);
        });
    }
    bootNetwork();

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
    requestManualRefresh: requestManualRefresh,
    lastPosition: function () { return lastPosition; },
    lastVehicles: function () { return vehicles; },
    /** Time since the last SUCCESSFUL poll, or null before the first one. */
    feedAgeMs: function () { return lastPollAt ? Date.now() - lastPollAt : null; },
    repaintStop: function () { SB.uiStop.onData(vehicles, Date.now()); },
    nearestStop: nearestStop
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
