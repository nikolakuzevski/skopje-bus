/* untracked.js — finds buses that are running but have no live GPS.
 *
 * Measured on 2026-09-07 at 20:49: of ~188 trips that should have been under
 * way, 32 had a vehicle assigned in GTFS-RT TripUpdates but no entry at all in
 * the lightweight vehicles feed. Those are the buses that turn up at the stop
 * having never appeared in the app. This module surfaces them.
 *
 * The catch is cost. TripUpdates is ~12 MB decoded and is not filterable
 * server-side. It is also thin on content: upstream leaves `arrival.time` at 0
 * and reports `delay` against a schedule this app cannot see, so neither yields
 * a usable arrival time. What it does give reliably is which trips exist right
 * now and which vehicle is on each, which is exactly the gap being closed here.
 * The size makes it far too heavy to poll, so this is an explicit user action,
 * cached for a few minutes, and skipped outright on a metered connection.
 * If it ever proves too heavy on real mobile data, the fallback is a small
 * server-side proxy that does this filtering remotely. */
(function () {
  const SB = (window.SB = window.SB || {});

  const FRESH_MS = 3 * 60 * 1000;
  const WINDOW_BEFORE_MIN = 90;   // a trip started this long ago may still run
  const WINDOW_AFTER_MIN = 3;     // or be about to start
  const MIN_PER_STOP = 2;         // rough trip length, for "has it finished yet"

  let lastCheckedAt = 0;
  let found = [];                 // [{routeId, tripId, vehicleLabel, stopIds:Set, lastStopId, startMin}]
  let inFlight = null;

  function saveData() {
    const c = navigator.connection;
    return !!(c && (c.saveData || /^(slow-)?2g$/.test(c.effectiveType || '')));
  }

  function todayStamp(now) {
    const d = new Date(now);
    return String(d.getFullYear()) +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
  }

  /**
   * Fetch TripUpdates once and keep only trips that look like they are running
   * now and have no live position. Everything else is discarded immediately so
   * the 12 MB never turns into 12 MB of retained state.
   */
  function check(liveVehicles) {
    if (inFlight) return inFlight;
    if (saveData()) {
      return Promise.reject(new Error('Штедење на интернет е вклучено.'));
    }

    const live = new Set((liveVehicles || []).map(function (v) { return String(v.vehicleId); }));

    inFlight = SB.api.tripUpdatesExpensive().then(function (feed) {
      const now = Date.now();
      const d = new Date(now);
      const nowMin = d.getHours() * 60 + d.getMinutes();
      const today = todayStamp(now);
      const out = [];

      (feed.entity || []).forEach(function (e) {
        const u = e.tripUpdate;
        if (!u || !u.trip || !u.vehicle || !u.vehicle.id) return;
        if (u.trip.startDate !== today) return;

        const parts = String(u.trip.startTime || '').split(':');
        if (parts.length < 2) return;
        const startMin = Number(parts[0]) * 60 + Number(parts[1]);
        if (startMin > nowMin + WINDOW_AFTER_MIN) return;
        if (startMin < nowMin - WINDOW_BEFORE_MIN) return;

        if (live.has(String(u.vehicle.id))) return; // it is tracked, nothing to add

        const stopIds = new Set();
        let lastStopId = null;
        (u.stopTimeUpdate || []).forEach(function (s) {
          if (s.stopId != null) {
            stopIds.add(Number(s.stopId));
            lastStopId = Number(s.stopId);
          }
        });
        // `arrival.delay` is deliberately not read here. Upstream reports it
        // against a schedule this app cannot see, and on trips with no live
        // vehicle it comes back as nonsense (values of several hours). A wrong
        // delay is worse than none, and there is no position to sanity-check it.

        // Upstream gives no end time, so estimate the trip's length from its
        // stop count. Without this, a trip that started an hour ago and long
        // since finished still counts as a "missing" bus, which would inflate
        // the number and make the whole feature dishonest.
        if (startMin + stopIds.size * MIN_PER_STOP < nowMin) return;

        out.push({
          routeId: Number(u.trip.routeId),
          tripId: u.trip.tripId,
          vehicleLabel: u.vehicle.label || u.vehicle.id,
          stopIds: stopIds,
          startMin: startMin,
          lastStopId: lastStopId
        });
      });

      found = out;
      lastCheckedAt = now;
      return out;
    }).then(function (r) { inFlight = null; return r; },
            function (e) { inFlight = null; throw e; });

    return inFlight;
  }

  /** Where the trip ends, so the row says something more useful than its own
   * line number. TripUpdates carries no headsign, but its last stop is the
   * destination in all but name. */
  function destinationName(t) {
    const stop = t.lastStopId != null ? SB.net.stopById.get(t.lastStopId) : null;
    return stop ? stop.name : SB.net.routeName(t.routeId);
  }

  /** Untracked trips that serve `stopId`, as arrival-shaped rows for the list. */
  function forStop(stopId, nowMs) {
    const now = nowMs || Date.now();
    if (!found.length || now - lastCheckedAt > FRESH_MS) return [];

    return found.filter(function (t) { return t.stopIds.has(Number(stopId)); })
      .map(function (t) {
        const hh = Math.floor(t.startMin / 60);
        const mm = t.startMin % 60;
        return {
          untracked: true,
          vehicleId: 'u' + t.tripId,
          label: t.vehicleLabel,
          routeId: t.routeId,
          routeName: SB.net.routeName(t.routeId),
          headsign: destinationName(t),
          stopsAway: null,
          predictedAt: null,
          state: 'untracked',
          confidence: 'low',
          delaySeconds: null,
          scheduledText: 'тргнал ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
        };
      });
  }

  SB.untracked = {
    check: check,
    forStop: forStop,
    lastCheckedAt: function () { return lastCheckedAt; },
    count: function () { return found.length; },
    isFresh: function () { return Date.now() - lastCheckedAt <= FRESH_MS; },
    saveDataOn: saveData
  };
})();
