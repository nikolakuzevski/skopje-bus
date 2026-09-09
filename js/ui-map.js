/* ui-map.js — watching the buses move.
 *
 * This module is a SUBSCRIBER, never a fetcher. It owns no timers and makes no
 * API calls: js/app.js hands it each poll's vehicles. Giving the map its own
 * poll would double the load on an undocumented API for zero extra information.
 *
 * Leaflet is vendored (vendor/leaflet/) rather than loaded from a CDN, because
 * sw.js deliberately ignores cross-origin GETs, so a CDN script could never be
 * precached and the map would be dead offline. It is injected lazily on first
 * mount so that a user who never opens this tab pays nothing for it at boot,
 * which is the property CLAUDE.md's "why the app feels fast" section rests on.
 *
 * Honesty notes, since this view can imply things the list cannot:
 *  - Positions are 15-35s old when they arrive. Markers tween between two
 *    genuinely reported points over 1.2s and then STOP. Dead-reckoning a bus
 *    forward along its heading would be drawing a position nobody reported.
 *  - `heading` is null for some vehicles. Those render as a plain dot; an arrow
 *    pointing north on a bus of unknown heading is a small invented fact.
 *  - The API publishes no route geometry, only ordered stop ids, so a line
 *    drawn through stop coordinates cuts corners across blocks. It is drawn
 *    faintly and captioned rather than passed off as the real route.
 *  - Buses with no GPS cannot be drawn at all - the /vehicles feed only ever
 *    contains buses that ARE reporting, so its length can never be compared
 *    against the drawn count to detect this. The header states how many are
 *    missing only when the timetable download makes that count knowable.
 */
(function () {
  const SB = (window.SB = window.SB || {});
  const el = SB.dom.el;

  const SKOPJE = [41.9981, 21.4254];
  const TWEEN_MS = 1200;
  const STALE_MS = 90000;

  let map = null;
  let loading = null;
  let mounting = false;  // true from the first mount() call until L.map() resolves
  let busLayer = null;
  let stopMarker = null;
  let routeLine = null;
  let mounted = false;

  const markers = new Map();   // vehicleId -> {marker, from, to, start, data}
  let rafId = null;
  let latest = { vehicles: [], now: 0 };
  let sizeObserver = null;

  /* Leaflet caches the container's pixel size at init and only loads tiles for
   * that rectangle. Any map created while its panel is hidden, or any device
   * rotation afterwards, leaves it convinced it is the wrong size and it loads
   * a single tile into a mostly empty view. Watching the container is the
   * robust fix; a one-shot invalidateSize after mount is not. */
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

  /* ---------------- lazy library load ---------------- */

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
        if (window.L) resolve(window.L);
        else reject(new Error('Leaflet loaded but window.L is missing'));
      };
      js.onerror = function () { reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(js);
    });
    return loading;
  }

  /* ---------------- markers ---------------- */

  function busIcon(v) {
    const showArrow = v.heading != null && (v.speed == null || v.speed > 1);
    const arrow = showArrow
      ? '<span class="bus-arrow" style="transform:rotate(' + Math.round(v.heading) + 'deg)"></span>'
      : '<span class="bus-dot"></span>';
    return window.L.divIcon({
      className: '',
      html: '<span class="bus-pin">' + arrow +
            '<span class="bus-num"></span></span>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  function paintMarker(rec, now) {
    const elRoot = rec.marker.getElement();
    if (!elRoot) return;
    const v = rec.data;

    const num = elRoot.querySelector('.bus-num');
    if (num && num.textContent !== v.routeName) num.textContent = v.routeName;

    // Leaflet rewrites `transform` on the marker's ROOT element on every
    // setLatLng, pan and zoom. Rotation therefore lives on the inner span; put
    // it on the root and every poll silently erases the heading.
    const arrow = elRoot.querySelector('.bus-arrow');
    if (arrow && v.heading != null) {
      const want = 'rotate(' + Math.round(v.heading) + 'deg)';
      if (arrow.style.transform !== want) arrow.style.transform = want;
    }

    const pin = elRoot.querySelector('.bus-pin');
    if (pin) {
      // Unknown fix age is not the same as a fresh one - if lastUpdated is
      // missing this must read as stale, not slip past the check below.
      const stale = !v.lastUpdated || (now - v.lastUpdated) > STALE_MS;
      pin.classList.toggle('is-stale', !!stale);
      pin.classList.toggle('is-here', !!v.servesCurrentStop);
    }
  }

  function popupHtml(v, now) {
    const age = v.lastUpdated ? SB.dom.fmtAge((now - v.lastUpdated) / 1000) : 'непознато';
    const bits = [
      'Линија ' + v.routeName,
      v.headsign || '',
      'позиција од пред ' + age
    ];
    if (v.speed != null) bits.push(Math.round(v.speed * 3.6) + ' км/ч');
    return bits.filter(Boolean).map(function (t) {
      return '<div>' + t.replace(/[<>&]/g, '') + '</div>';
    }).join('');
  }

  function syncMarkers(vehicles, now) {
    if (!map || !window.L) return;
    const seen = new Set();

    vehicles.forEach(function (v) {
      if (typeof v.lat !== 'number' || typeof v.lon !== 'number') return;
      seen.add(v.vehicleId);

      let rec = markers.get(v.vehicleId);
      if (!rec) {
        const marker = window.L.marker([v.lat, v.lon], {
          icon: busIcon(v),
          keyboard: false,
          riseOnHover: true
        });
        marker.addTo(busLayer);
        rec = { marker: marker, from: [v.lat, v.lon], to: [v.lat, v.lon], start: 0, data: v };
        markers.set(v.vehicleId, rec);
        marker.bindPopup('');
        marker.on('click', function () {
          marker.setPopupContent(popupHtml(rec.data, Date.now()));
        });
      } else {
        const cur = rec.marker.getLatLng();
        rec.from = [cur.lat, cur.lng];
        rec.to = [v.lat, v.lon];
        rec.start = now;
        rec.data = v;
      }
      paintMarker(rec, now);
    });

    markers.forEach(function (rec, id) {
      if (seen.has(id)) return;
      busLayer.removeLayer(rec.marker);
      markers.delete(id);
    });
  }

  /* Tween between two REPORTED positions. Never past the newest one. */
  function step() {
    rafId = null;
    if (!mounted || !map) return;
    const now = Date.now();
    let moving = false;

    markers.forEach(function (rec) {
      if (!rec.start) return;
      const t = Math.min(1, (now - rec.start) / TWEEN_MS);
      const lat = rec.from[0] + (rec.to[0] - rec.from[0]) * t;
      const lon = rec.from[1] + (rec.to[1] - rec.from[1]) * t;
      rec.marker.setLatLng([lat, lon]);
      if (t >= 1) rec.start = 0; else moving = true;
    });

    if (moving) rafId = requestAnimationFrame(step);
  }

  function kick() {
    if (rafId == null && mounted) rafId = requestAnimationFrame(step);
  }

  /* ---------------- stop and route context ---------------- */

  function drawStopContext() {
    if (!map || !window.L) return;
    const id = SB.uiStop.currentStopId();
    const stop = id != null ? SB.net.stopById.get(id) : null;

    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (stopMarker) { map.removeLayer(stopMarker); stopMarker = null; }
    if (!stop) return;

    stopMarker = window.L.circleMarker([stop.lat, stop.lon], {
      radius: 8, color: '#f2b134', weight: 3, fillColor: '#101820', fillOpacity: 1
    }).addTo(map);
    stopMarker.bindPopup(stop.name.replace(/[<>&]/g, ''));
  }

  /* ---------------- header ---------------- */

  function renderHead(now) {
    const host = SB.dom.qs('#map-head');
    if (!host) return;
    SB.dom.clear(host);

    const drawn = markers.size;

    const bits = [drawn + ' возила на мапа'];
    // The /vehicles feed only ever contains buses that ARE reporting a
    // position, so comparing its length to the drawn count cannot detect a
    // bus with no GPS - that count only exists via the timetable, and only
    // once one has been downloaded and is still fresh.
    if (SB.timetable.isFresh()) {
      const dark = SB.timetable.runningWithoutGps(latest.vehicles, latest.now).length;
      if (dark > 0) bits.push(dark + ' без ГПС');
    }
    const id = SB.uiStop.currentStopId();
    const stop = id != null ? SB.net.stopById.get(id) : null;
    if (stop) bits.push(stop.name);

    host.appendChild(el('div', { class: 'map-line', text: bits.join(' · ') }));
    host.appendChild(el('div', {
      class: 'map-note',
      text: 'Позициите доцнат околу пола минута. Возило без ГПС не може да се прикаже на мапа.'
    }));

    const actions = el('div', { class: 'map-actions' }, [
      el('button', {
        class: 'btn', type: 'button',
        onclick: function () {
          const s = SB.uiStop.currentStopId();
          const st = s != null ? SB.net.stopById.get(s) : null;
          if (st && map) map.setView([st.lat, st.lon], 15);
          else if (map) map.setView(SKOPJE, 13);
        }
      }, 'Центрирај на постојката')
    ]);
    host.appendChild(actions);
  }

  /* ---------------- lifecycle ---------------- */

  function mount() {
    const host = SB.dom.qs('#map');
    if (!host) return;
    mounted = true;

    if (map) {
      // Leaflet miscalculates size when it was initialised while hidden.
      setTimeout(function () { map.invalidateSize(); }, 0);
      drawStopContext();
      onData(latest.vehicles, Date.now());
      return;
    }
    // Tapping away from and back to this tab while Leaflet is still loading
    // used to attach a second .then to the same loadLeaflet() promise, so both
    // ran: two L.map(host, ...) calls on the same container. Leaflet keys
    // initialisation off an expando on the container that host.textContent =
    // '' does not clear, so the second call throws after already wiping the
    // first map's DOM, leaving `map` pointing at a detached instance and every
    // later mount() stuck on the early return above.
    if (mounting) return;
    mounting = true;

    host.textContent = 'Се вчитува мапата.';
    loadLeaflet().then(function (L) {
      host.textContent = '';
      const id = SB.uiStop.currentStopId();
      const stop = id != null ? SB.net.stopById.get(id) : null;

      map = L.map(host, {
        center: stop ? [stop.lat, stop.lon] : SKOPJE,
        zoom: stop ? 15 : 13,
        zoomControl: true,
        preferCanvas: true,
        attributionControl: true
      });

      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(map);

      busLayer = L.layerGroup().addTo(map);

      drawStopContext();
      onData(latest.vehicles, Date.now());
      watchSize(host);
      setTimeout(function () { map.invalidateSize(); }, 0);
      mounting = false;
    }).catch(function () {
      host.textContent = '';
      host.appendChild(el('p', {
        class: 'empty',
        text: 'Мапата не може да се вчита. Проверете ја врската и обидете се повторно.'
      }));
      mounting = false;
    });
  }

  function unmount() {
    mounted = false;
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  /** Called by app.js after every poll, whether or not this tab is open. */
  function onData(vehicles, now) {
    latest = { vehicles: vehicles || [], now: now || Date.now() };
    if (!mounted || !map) return;

    const stopId = SB.uiStop.currentStopId();
    const serving = new Set();
    if (stopId != null && SB.net.isLoaded()) {
      (SB.net.patternsByStop.get(stopId) || []).forEach(function (p) {
        serving.add(p.routeId + ':' + p.patternIndex);
      });
    }

    const decorated = latest.vehicles.map(function (v) {
      return Object.assign({}, v, {
        routeName: SB.net.routeName(v.routeId),
        servesCurrentStop: serving.has(v.routeId + ':' + v.patternIndex)
      });
    });

    syncMarkers(decorated, latest.now);
    kick();
    renderHead(latest.now);
  }

  SB.uiMap = {
    mount: mount,
    unmount: unmount,
    onData: onData,
    render: function () { if (mounted) { drawStopContext(); renderHead(Date.now()); } },
    isMounted: function () { return mounted; }
  };
})();
