/* eta.js — the prediction engine. This is the part that has to be better than
 * the official app, so the reasoning is spelled out.
 *
 * For a bus V and a target stop S on V's pattern:
 *   i = position of V's next stop, j = position of S.
 *   j < i   -> already passed, drop it.
 *   j === i -> arrival is V.nextStopArrival verbatim. This is the upstream
 *              system's own estimate for its immediate next stop and is the
 *              single most reliable number available anywhere in the feed.
 *   j > i   -> that same anchor plus the traversal time of each segment in
 *              between, taken from js/history.js when it has been observed and
 *              from stop-to-stop distance when it has not.
 *
 * Three behaviours exist specifically to fix what JSP's own app gets wrong:
 *
 *  1. A predicted arrival INSTANT is held per (vehicle, stop) and the countdown
 *     is ticked from the local clock. Each poll nudges that instant instead of
 *     replacing it, so ordinary feed jitter never reaches the screen, while a
 *     genuinely large correction still snaps through immediately.
 *  2. A GPS fix older than STALE_MS stops the countdown outright and says so.
 *     A countdown that keeps running on dead data is how you get "0 min" at an
 *     empty stop.
 *  3. Predictions far down the line are shown as a range, because they are one.
 */
(function () {
  const SB = (window.SB = window.SB || {});

  const STALE_MS = 90000;        // beyond this a fix is not worth counting down
  const FALLBACK_SPEED_MPS = 4.7; // ~17 km/h, a Skopje bus stop-to-stop average
  const DWELL_SEC = 12;          // door time at each intermediate stop
  const SNAP_MS = 45000;         // bigger than this is a real correction, show it
  const EMA_ALPHA = 0.25;        // otherwise drift gently toward the new estimate
  const MAX_STOPS_AWAY = 12;     // past this the guess is not worth showing
  const HELD_TTL_MS = 10 * 60 * 1000;

  // 'vehicleId|stopId' -> {shownAt, updatedAt}
  const held = new Map();

  function heldKey(vehicleId, stopId) { return vehicleId + '|' + stopId; }

  /** Nudge the held arrival instant toward `rawAt`, snapping on big moves. */
  function smooth(key, rawAt, now) {
    const prev = held.get(key);
    let shownAt;
    if (!prev) {
      shownAt = rawAt;
    } else if (Math.abs(rawAt - prev.shownAt) > SNAP_MS) {
      shownAt = rawAt;
    } else {
      shownAt = Math.round(prev.shownAt + EMA_ALPHA * (rawAt - prev.shownAt));
    }
    held.set(key, { shownAt: shownAt, updatedAt: now });
    return shownAt;
  }

  function pruneHeld(now) {
    held.forEach(function (v, k) {
      if (now - v.updatedAt > HELD_TTL_MS) held.delete(k);
    });
  }

  /** Distance-based fallback for one segment, in seconds. */
  function fallbackSegmentSeconds(fromStopId, toStopId) {
    const a = SB.net.stopById.get(fromStopId);
    const b = SB.net.stopById.get(toStopId);
    if (!a || !b) return 60;
    const metres = SB.dom.haversine(a.lat, a.lon, b.lat, b.lon);
    return metres / FALLBACK_SPEED_MPS + DWELL_SEC;
  }

  /**
   * Arrivals of `vehicles` at `stopId`, soonest first.
   * Pure apart from the smoothing memory, so it is safe to call every poll.
   */
  function arrivalsForStop(stopId, vehicles, nowMs) {
    const now = nowMs || Date.now();
    if (!SB.net.isLoaded()) return [];

    const hour = new Date(now).getHours();
    const out = [];

    vehicles.forEach(function (v) {
      if (v.nextStopId == null) return;

      const pattern = SB.net.pattern(v.routeId, v.patternIndex);
      if (!pattern) return;

      const j = SB.net.positionOf(v.routeId, v.patternIndex, stopId);
      if (j < 0) return;                       // this pattern does not serve the stop
      const i = SB.net.positionOf(v.routeId, v.patternIndex, v.nextStopId);
      if (i < 0) return;
      if (j < i) return;                       // already went past

      const stopsAway = j - i;
      if (stopsAway > MAX_STOPS_AWAY) return;

      // Anchor: the upstream estimate for the bus's own next stop. If it is
      // missing, fall back to the bus's straight-line distance to that stop.
      let base = v.nextStopArrival;
      if (!base) {
        const nextStop = SB.net.stopById.get(v.nextStopId);
        const metres = nextStop ? SB.dom.haversine(v.lat, v.lon, nextStop.lat, nextStop.lon) : 300;
        base = (v.lastUpdated || now) + (metres / FALLBACK_SPEED_MPS) * 1000;
      }

      // Then add every segment between the bus's next stop and the target.
      const patternKey = v.routeId + ':' + v.patternIndex;
      let extraSec = 0;
      let learned = 0;
      for (let p = i; p < j; p++) {
        const seconds = SB.history.segmentSeconds(patternKey, p, hour);
        if (seconds != null) {
          extraSec += seconds;
          learned++;
        } else {
          extraSec += fallbackSegmentSeconds(pattern.stops[p], pattern.stops[p + 1]);
        }
      }

      const rawAt = base + extraSec * 1000;
      const ageSec = v.lastUpdated ? (now - v.lastUpdated) / 1000 : null;
      const stale = ageSec != null && ageSec * 1000 > STALE_MS;

      // A stale vehicle keeps whatever instant it last had, but is never
      // smoothed further and is flagged so the UI can stop the countdown.
      const key = heldKey(v.vehicleId, stopId);
      const predictedAt = stale
        ? (held.get(key) ? held.get(key).shownAt : rawAt)
        : smooth(key, rawAt, now);

      let state;
      if (stale) state = 'stale';
      else if (stopsAway === 0 && v.stopStatus === 'STOPPED_AT') state = 'at_stop';
      else if (stopsAway === 0 && v.stopStatus === 'INCOMING_AT') state = 'arriving';
      else if (predictedAt - now <= 30000) state = 'due';
      else state = 'enroute';

      const ratio = stopsAway === 0 ? 1 : learned / stopsAway;
      let confidence;
      if (stopsAway <= 1) confidence = 'high';
      else if (stopsAway <= 5 || ratio >= 0.6) confidence = 'medium';
      else confidence = 'low';

      out.push({
        vehicleId: v.vehicleId,
        label: v.label,
        routeId: v.routeId,
        routeName: SB.net.routeName(v.routeId),
        headsign: v.headsign,
        patternIndex: v.patternIndex,
        stopsAway: stopsAway,
        predictedAt: predictedAt,
        rawPredictedAt: rawAt,
        state: state,
        confidence: confidence,
        learnedSegments: learned,
        totalSegments: stopsAway,
        ageSec: ageSec,
        delaySeconds: v.delaySeconds,
        lat: v.lat,
        lon: v.lon
      });
    });

    pruneHeld(now);
    out.sort(function (a, b) { return a.predictedAt - b.predictedAt; });
    return out;
  }

  /**
   * How to render one arrival's time. Returns {text, sub} in Macedonian.
   * Low-confidence predictions become a range rather than a false exact minute.
   */
  function label(arrival, nowMs) {
    const now = nowMs || Date.now();
    const sec = (arrival.predictedAt - now) / 1000;

    if (arrival.state === 'stale') {
      return { text: 'нема сигнал', sub: 'последно пред ' + SB.dom.fmtAge(arrival.ageSec) };
    }
    if (arrival.state === 'at_stop') return { text: 'на постојка', sub: '' };
    if (arrival.state === 'arriving') return { text: 'пристигнува', sub: '' };
    if (sec <= 45) return { text: 'сега', sub: '' };

    const mins = Math.round(sec / 60);
    if (arrival.confidence === 'low') {
      const spread = Math.max(1, Math.round(mins * 0.25));
      return {
        text: Math.max(1, mins - spread) + '-' + (mins + spread) + ' мин',
        sub: 'приближно'
      };
    }
    return { text: mins + ' мин', sub: SB.dom.fmtClock(arrival.predictedAt) };
  }

  SB.eta = {
    arrivalsForStop: arrivalsForStop,
    label: label,
    reset: function () { held.clear(); },
    constants: {
      STALE_MS: STALE_MS,
      FALLBACK_SPEED_MPS: FALLBACK_SPEED_MPS,
      MAX_STOPS_AWAY: MAX_STOPS_AWAY
    }
  };
})();
