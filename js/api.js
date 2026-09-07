/* api.js — the ONLY file in this app that knows the Modeshift endpoints.
 *
 * This is an undocumented internal API used by JSP's own site and app. It is
 * public and unauthenticated (Access-Control-Allow-Origin: *, verified from an
 * unrelated origin), which is what lets this app be a plain static page with no
 * backend. It can also change or close without notice — when it does, the fix
 * belongs here and nowhere else. Everything is normalised at this boundary so
 * no other file ever sees a raw upstream field name. */
(function () {
  const SB = (window.SB = window.SB || {});

  const TENANT = '9814b106-2afe-47c8-919b-bdec6a5e521e';
  const ROOT = 'https://www.modeshift.app/api/v1/' + TENANT + '/';

  const PATHS = {
    vehicles: 'transport/planner/vehicles',
    routes: 'transport/planner/routes',
    stops: 'transport/planner/stops',
    alerts: 'transport/gtfsrt/alerts?mediaType=WebPortal',
    tripUpdates: 'transport/gtfsrt/tripupdates'
  };

  /* Upstream failure is a normal, expected state for this app, not a crash.
   * Callers distinguish `kind` so the UI can say something specific. */
  function ApiError(kind, message) {
    const err = new Error(message);
    err.name = 'ApiError';
    err.kind = kind; // 'offline' | 'timeout' | 'http' | 'parse'
    return err;
  }

  function get(path, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000);
    return fetch(ROOT + path, { signal: ctrl.signal, cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw ApiError('http', 'HTTP ' + res.status + ' for ' + path);
        return res.json().catch(function () {
          throw ApiError('parse', 'Malformed JSON from ' + path);
        });
      })
      .catch(function (err) {
        if (err.name === 'ApiError') throw err;
        if (err.name === 'AbortError') throw ApiError('timeout', 'Timed out: ' + path);
        throw ApiError('offline', 'Network unreachable: ' + path);
      })
      .then(function (v) { clearTimeout(timer); return v; },
            function (e) { clearTimeout(timer); throw e; });
  }

  function ms(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
  }

  /* The plain /vehicles list calls the next stop `stopId`; /vehicles/route/N
   * calls the same thing `currentStopId`. Collapse both to `nextStopId`. */
  function normaliseVehicle(v) {
    return {
      vehicleId: String(v.vehicleId),
      label: v.label ? String(v.label) : String(v.vehicleId),
      routeId: v.routeId,
      patternIndex: v.patternIndex,
      tripId: v.tripId ? String(v.tripId) : null,
      headsign: v.headsign || '',
      lat: v.latitude,
      lon: v.longitude,
      heading: typeof v.heading === 'number' ? v.heading : null,
      speed: typeof v.speed === 'number' ? v.speed : null,
      nextStopId: v.stopId != null ? v.stopId : (v.currentStopId != null ? v.currentStopId : null),
      nextStopArrival: ms(v.nextStopArrival),
      delaySeconds: typeof v.delaySeconds === 'number' ? v.delaySeconds : null,
      stopStatus: v.stopStatus || null,
      lastUpdated: ms(v.lastUpdated)
    };
  }

  function normalisePattern(p) {
    return {
      index: p.index,
      routeId: p.routeId,
      fromStopId: p.fromStopId,
      toStopId: p.toStopId,
      direction: p.direction,
      stops: Array.isArray(p.stops) ? p.stops.slice() : []
    };
  }

  function normaliseRoute(r) {
    return {
      id: r.id,
      shortName: r.shortName || '',
      longName: r.longName || '',
      type: r.type,
      patterns: (r.patterns || []).map(normalisePattern)
    };
  }

  function normaliseStop(s) {
    return {
      id: s.id,
      name: s.name || '',
      code: s.code || '',
      lat: s.latitude,
      lon: s.longitude,
      // On a stop, patterns carry no `stops` array — only which route/direction
      // passes through. Keep just the identifying triple.
      patterns: (s.patterns || []).map(function (p) {
        return { index: p.index, routeId: p.routeId, direction: p.direction };
      })
    };
  }

  SB.api = {
    ROOT: ROOT,
    Error: ApiError,

    /** All live vehicles (~36 KB, GPS fixes typically 15-35s old). Hot path. */
    vehicles: function () {
      return get(PATHS.vehicles, 9000).then(function (list) {
        return (list || []).map(normaliseVehicle);
      });
    },

    /** Vehicles on patterns that serve one stop. */
    vehiclesForStop: function (stopId) {
      return get(PATHS.vehicles + '?stopId=' + encodeURIComponent(stopId), 9000)
        .then(function (list) { return (list || []).map(normaliseVehicle); });
    },

    /** Routes with their ordered stop sequences. Static-ish, cache for a day. */
    routes: function () {
      return get(PATHS.routes, 20000).then(function (list) {
        return (list || []).map(normaliseRoute);
      });
    },

    /** All stops with coordinates. Static-ish, cache for a day. */
    stops: function () {
      return get(PATHS.stops, 20000).then(function (list) {
        return (list || []).map(normaliseStop);
      });
    },

    /** Service alerts (GTFS-RT). Small. */
    alerts: function () {
      return get(PATHS.alerts, 9000);
    },

    /* GTFS-RT TripUpdates: ~12 MB decoded and unfilterable server-side, so this
     * is deliberately NOT on any poll loop. It is the only source that knows
     * about running trips whose bus has no live GPS. Callers must treat it as
     * an expensive, explicit, user-triggered action. Note `arrival.time` comes
     * back as 0 upstream — only `delay` is populated. */
    tripUpdatesExpensive: function () {
      return get(PATHS.tripUpdates, 45000);
    }
  };
})();
