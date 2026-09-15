/* ui-detail.js — one bus, full screen.
 *
 * Replaces the old always-on "every bus in Skopje" map tab: watching 100+
 * markers at once was rarely what anyone actually wanted, and there was no
 * way to leave it except the tab bar. Tapping a row here now shows exactly
 * the one bus that row is about to arrive on, with its own small map - and
 * the only way onto this screen is a tap, so the back arrow at its top is
 * the only way anyone needs to leave it.
 *
 * Identity across polls: `arrivals` is a brand-new array every poll (built in
 * js/ui-stop.js), so this module cannot hold onto the object it was opened
 * with - it holds onto `tripId` instead (present on every row, live or
 * scheduled) and re-finds the freshest matching row out of whatever
 * `update()` is handed each time. That re-find is also what lets a row
 * quietly turn from "predicted, no signal yet" into a live one without this
 * screen needing to know or care which kind it started as.
 *
 * Leaflet is vendored and lazy-loaded exactly as the old map did - see
 * CLAUDE.md for why (sw.js ignores cross-origin GETs, so only a vendored copy
 * can ever be precached). Unlike the old tab, this map is a SINGLETON: it is
 * created once on first open and reused for every later one (setView + swap
 * markers), never destroyed - there is exactly one place this screen can be
 * shown, so the double-init class of bug the old tab had to guard against
 * cannot occur here.
 *
 * Honesty notes carried over from the old map:
 *  - The bus marker tweens between two REPORTED positions and then stops.
 *    Dead-reckoning along heading/speed would be drawing a position nobody
 *    reported.
 *  - A bus that drops out of the merged arrivals entirely (arrived, passed
 *    the stop, or lost GPS) does not vanish silently - the screen says so.
 */
(function () {
  const SB = (window.SB = window.SB || {});
  const el = SB.dom.el;

  const TWEEN_MS = 1200;
  const STALE_MS = 90000;          // matches eta.js's per-vehicle staleness gate
  const REFRESH_TIMEOUT_MS = 10000;

  let open = false;
  let currentTripId = null;
  let lastRow = null;              // most recent matching arrival, or null if lost
  let lastFixAt = null;            // epoch ms of lastRow's GPS fix, so its age can tick
  let fitKey = null;               // re-fit the map only when a marker actually moved

  let map = null;
  let loading = null;
  let mapReady = false;
  let busMarker = null;
  let stopMarker = null;
  let rafId = null;
  let tween = null;                // {from, to, start}
  let sizeObserver = null;
  let spinning = false;

  let els = null;                  // cached DOM refs, built once

  /* ---------------- lazy Leaflet load (mirrors the old ui-map.js) ---------------- */

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);

      const js = document.createElement('script');
      js.src = 'vendor/leaflet/leaflet.js';
      js.onload = function () {
        if (window.L) resolve(window.L); else reject(new Error('Leaflet loaded but window.L is missing'));
      };
      js.onerror = function () { reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(js);
    });
    return loading;
  }

  function watchSize(host) {
    if (sizeObserver || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    sizeObserver = new ResizeObserver(function (entries) {
      const box = entries[0] && entries[0].contentRect;
      if (!box || !map) return;
      const area = Math.round(box.width) * Math.round(box.height);
      if (area === 0 || area === last) return;
      last = area;
      map.invalidateSize();
    });
    sizeObserver.observe(host);
  }

  function busIcon(L, heading, speed) {
    const showArrow = heading != null && (speed == null || speed > 1);
    const arrow = showArrow
      ? '<span class="bus-arrow" style="transform:rotate(' + Math.round(heading) + 'deg)"></span>'
      : '<span class="bus-dot"></span>';
    return L.divIcon({
      className: '',
      html: '<span class="bus-pin">' + arrow + '<span class="bus-num"></span></span>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  function ensureMap() {
    if (map) return Promise.resolve(map);
    if (!els.mapHost) return Promise.reject(new Error('no map container'));
    els.mapHost.textContent = 'Се вчитува мапата.';
    return loadLeaflet().then(function (L) {
      els.mapHost.textContent = '';
      map = L.map(els.mapHost, {
        center: [41.9981, 21.4254],
        zoom: 13,
        zoomControl: true,
        preferCanvas: true,
        attributionControl: true
      });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(map);
      watchSize(els.mapHost);
      mapReady = true;
      return map;
    });
  }

  /* ---------------- the single bus + stop markers ---------------- */

  /* What tapping the bus marker itself answers: is it moving right now, and
   * how fast. `speed` is upstream's own reported figure (m/s) - shown, not
   * derived - and "moving" is read off it with a small dead-band rather than
   * treating any speed above zero as motion, since a GPS fix sitting at a red
   * light can jitter a little around zero. `STOPPED_AT` is upstream's own
   * stronger claim ("this bus is currently at a stop") and is trusted over the
   * speed figure when both are present, since it is the more specific signal. */
  function movementText(a) {
    if (a.stopStatus === 'STOPPED_AT') return 'запрен на постојка';
    if (typeof a.speed !== 'number') return 'непозната брзина';
    if (a.speed < 0.6) return 'стои (0 км/ч)';
    return 'во движење · ' + Math.round(a.speed * 3.6) + ' км/ч';
  }

  function busPopupHtml(a, now) {
    const age = a.ageSec != null ? SB.dom.fmtAge(a.ageSec) : 'непозната';
    const lines = [
      'Линија ' + a.routeName + (a.headsign ? ' · ' + a.headsign : ''),
      movementText(a),
      'Позиција од пред ' + age
    ];
    return lines.map(function (t) { return '<div>' + t.replace(/[<>&]/g, '') + '</div>'; }).join('');
  }

  function paintBusMarker(L, a, now) {
    if (!busMarker) {
      busMarker = L.marker([a.lat, a.lon], { icon: busIcon(L, a.heading, a.speed), keyboard: false });
      busMarker.addTo(map);
      busMarker.bindPopup('');
      // Content is built fresh on each click, from whatever `lastRow` is at
      // that moment, not baked in at marker creation - speed and status keep
      // changing every poll while the marker itself is reused.
      busMarker.on('click', function () {
        if (lastRow) busMarker.setPopupContent(busPopupHtml(lastRow, Date.now()));
      });
      tween = null;
    } else {
      const cur = busMarker.getLatLng();
      if (Math.abs(cur.lat - a.lat) > 1e-7 || Math.abs(cur.lng - a.lon) > 1e-7) {
        tween = { from: [cur.lat, cur.lng], to: [a.lat, a.lon], start: now };
      }
      busMarker.setIcon(busIcon(L, a.heading, a.speed));
    }
    const rootEl = busMarker.getElement();
    if (rootEl) {
      const num = rootEl.querySelector('.bus-num');
      if (num) num.textContent = a.routeName;
      const pin = rootEl.querySelector('.bus-pin');
      // Unknown fix age counts as stale, not fresh - same rule as eta.js.
      if (pin) pin.classList.toggle('is-stale', a.ageSec == null || a.ageSec * 1000 > STALE_MS);
    }
    kick();
  }

  function step() {
    rafId = null;
    if (!tween || !busMarker) return;
    const now = Date.now();
    const t = Math.min(1, (now - tween.start) / TWEEN_MS);
    const lat = tween.from[0] + (tween.to[0] - tween.from[0]) * t;
    const lon = tween.from[1] + (tween.to[1] - tween.from[1]) * t;
    busMarker.setLatLng([lat, lon]);
    if (t >= 1) tween = null; else rafId = requestAnimationFrame(step);
  }
  function kick() { if (rafId == null && tween) rafId = requestAnimationFrame(step); }

  function paintStopMarker(L, stop) {
    if (stopMarker) { map.removeLayer(stopMarker); stopMarker = null; }
    if (!stop) return;
    stopMarker = L.circleMarker([stop.lat, stop.lon], {
      radius: 8, color: '#f2b134', weight: 3, fillColor: '#101820', fillOpacity: 1
    }).addTo(map);
    stopMarker.bindPopup(stop.name.replace(/[<>&]/g, ''));
  }

  function fitToMarkers() {
    if (!map) return;
    const pts = [];
    if (busMarker) pts.push(busMarker.getLatLng());
    if (stopMarker) pts.push(stopMarker.getLatLng());
    if (pts.length === 2) map.fitBounds(pts, { padding: [36, 36], maxZoom: 16 });
    else if (pts.length === 1) map.setView(pts[0], 15);
  }

  /* ---------------- text content ---------------- */

  function destinationLine(a) {
    return a.headsign || SB.net.routeName(a.routeId);
  }

  function paintText(a, now) {
    els.badge.textContent = a.routeName;
    els.headsign.textContent = destinationLine(a);

    if (a.scheduled) {
      const lbl = SB.timetable.label(a, now);
      els.time.textContent = lbl.text;
      els.timeSub.textContent = lbl.sub;
      els.age.textContent = SB.timetable.detail(a);
    } else {
      const lbl = SB.eta.label(a, now);
      els.time.textContent = lbl.text;
      els.timeSub.textContent = lbl.sub;
      // The cadence note is there because the age climbing from ~10s to ~25s
      // and back is normal, not a stuck app: see FAST_POLL_MS in js/app.js.
      els.age.textContent = a.ageSec != null
        ? 'Последен сигнал пред ' + SB.dom.fmtAge(a.ageSec) +
          '. Автобусот ја праќа локацијата на секои 15 секунди.'
        : 'Непозната старост на сигналот';
    }
  }

  function paintLost() {
    els.time.textContent = 'нема информации';
    els.timeSub.textContent = '';
    els.age.textContent = 'Возилото веќе не е во дофат - веројатно ја помина постојката или изгуби ГПС сигнал.';
  }

  /* ---------------- refresh button ---------------- */

  function stopSpin() {
    spinning = false;
    if (els) { els.refreshBtn.classList.remove('is-spinning'); els.refreshBtn.disabled = false; }
  }
  window.addEventListener('sb:poll-settled', stopSpin);

  function requestRefresh() {
    if (!SB.app.requestManualRefresh()) {
      SB.dom.toast('Веќе е освежено пред кратко.');
      return;
    }
    spinning = true;
    els.refreshBtn.classList.add('is-spinning');
    els.refreshBtn.disabled = true;
    setTimeout(function () { if (spinning) stopSpin(); }, REFRESH_TIMEOUT_MS);
  }

  /* ---------------- build (once) ---------------- */

  function build() {
    const overlay = SB.dom.qs('#panel-detail');
    if (!overlay) return null;

    const badge = el('span', { class: 'route-badge' });
    const headsign = el('span', { class: 'detail-headsign' });
    const time = el('span', { class: 'detail-time' });
    const timeSub = el('span', { class: 'detail-sub' });
    const age = el('p', { class: 'detail-age' });
    const refreshBtn = el('button', {
      class: 'icon-btn row-refresh', type: 'button', 'aria-label': 'Освежи сега',
      onclick: requestRefresh
    }, [SB.dom.icon('refresh', 'refresh-icon'), ' Освежи']);
    const backBtn = el('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Назад',
      onclick: function () { close(); }
    }, [SB.dom.icon('back')]);
    const mapHost = el('div', { id: 'detail-map' });

    SB.dom.clear(overlay);
    overlay.appendChild(el('div', { class: 'detail-head' }, [backBtn, badge, headsign]));
    overlay.appendChild(el('div', { class: 'detail-body' }, [
      time, timeSub, age,
      el('div', { class: 'detail-actions' }, [refreshBtn])
    ]));
    overlay.appendChild(mapHost);

    return { overlay: overlay, badge: badge, headsign: headsign, time: time, timeSub: timeSub,
      age: age, refreshBtn: refreshBtn, mapHost: mapHost };
  }

  /* ---------------- public API ---------------- */

  function paint(now) {
    if (!lastRow) {
      paintLost();
      // Leave the marker exactly where it last was - a real last-known
      // position, honestly aged, is worth more than making it vanish.
      if (mapReady && busMarker) {
        const rootEl = busMarker.getElement();
        const pin = rootEl && rootEl.querySelector('.bus-pin');
        if (pin) pin.classList.add('is-stale');
      }
      return;
    }
    paintText(lastRow, now || Date.now());

    if (!mapReady) return;
    const L = window.L;
    const stopId = SB.uiStop.currentStopId();
    const stop = stopId != null ? SB.net.stopById.get(stopId) : null;
    paintStopMarker(L, stop);

    if (typeof lastRow.lat === 'number' && typeof lastRow.lon === 'number') {
      paintBusMarker(L, lastRow, now || Date.now());
    } else if (busMarker) {
      map.removeLayer(busMarker);
      busMarker = null;
    }
    // With polls every 3s, re-fitting on every paint would keep yanking back
    // a user's own zoom or pan even while the bus has not moved.
    const k = [stopId, lastRow.lat, lastRow.lon].join(',');
    if (k !== fitKey) { fitKey = k; fitToMarkers(); }
  }

  function rememberFix(a, now) {
    lastFixAt = a && !a.scheduled && a.ageSec != null ? now - a.ageSec * 1000 : null;
  }

  function open_(a) {
    if (!a) return;
    if (!els) els = build();
    if (!els) return;

    open = true;
    currentTripId = a.tripId;
    lastRow = a;
    fitKey = null;
    rememberFix(a, Date.now());
    els.overlay.hidden = false;
    SB.app.setFastPoll(true);

    paintText(a, Date.now());
    ensureMap().then(function () { paint(Date.now()); })
      .catch(function () {
        els.mapHost.textContent = '';
        els.mapHost.appendChild(el('p', {
          class: 'empty', text: 'Мапата не може да се вчита. Проверете ја врската.'
        }));
      });
  }

  function close() {
    open = false;
    if (els) els.overlay.hidden = true;
    SB.app.setFastPoll(false);
  }

  /** Called by ui-stop.js after every recompute of `arrivals`. Cheap no-op if closed. */
  function update(arrivals, now) {
    if (!open) return;
    const t = now || Date.now();
    lastRow = (arrivals || []).find(function (a) { return a.tripId === currentTripId; }) || null;
    rememberFix(lastRow, t);
    paint(t);
  }

  /* Called by app.js for the fast polls in between the full ones. Takes the
   * raw feed and moves only the position, heading, speed and fix age of the
   * open bus. The arrival estimate stays whatever the last full poll computed,
   * so eta.js's smoothing is not run five times as often. */
  function liveUpdate(vehicles, now) {
    if (!open || !lastRow || lastRow.scheduled) return;
    const v = (vehicles || []).find(function (x) {
      return x.vehicleId === lastRow.vehicleId && x.tripId === lastRow.tripId;
    });
    if (!v) return;   // the next full poll decides whether it is really gone
    lastRow = Object.assign({}, lastRow, {
      lat: v.lat, lon: v.lon, heading: v.heading, speed: v.speed,
      stopStatus: v.stopStatus,
      ageSec: v.lastUpdated ? (now - v.lastUpdated) / 1000 : null
    });
    rememberFix(lastRow, now);
    paint(now);
  }

  /** Once a second: keeps the countdown and the signal age moving between polls. */
  function tick(now) {
    if (!open || !lastRow || !els) return;
    const row = lastFixAt != null
      ? Object.assign({}, lastRow, { ageSec: (now - lastFixAt) / 1000 })
      : lastRow;
    paintText(row, now);
  }

  SB.uiDetail = {
    open: open_,
    close: close,
    update: update,
    liveUpdate: liveUpdate,
    tick: tick,
    isOpen: function () { return open; }
  };
})();
