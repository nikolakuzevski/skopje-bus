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
    // A non-finite rawAt (e.g. from a malformed lat/lon upstream) must never be
    // stored: Math.abs(NaN - x) > SNAP_MS is false, so a NaN would fall into the
    // EMA branch below and poison this key's held value forever - every later
    // comparison against a stored NaN is also false, so it could never recover
    // even once good data arrives again. Falling back to the previous good
    // value (or dropping the key) keeps the failure local and temporary.
    if (!Number.isFinite(rawAt)) {
      const existing = held.get(key);
      return existing ? existing.shownAt : null;
    }
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
  function arrivalsForStop(stopId, vehicles, nowMs, opts) {
    const now = nowMs || Date.now();
    if (!SB.net.isLoaded()) return [];
    // Callers can widen the range to pick up buses that are tracked but still
    // far up the line. Those need no schedule data at all - just this feed and
    // the route's stop order - so they cost nothing extra.
    const maxStopsAway = (opts && opts.maxStopsAway) || MAX_STOPS_AWAY;

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
      if (stopsAway > maxStopsAway) return;

      // Anchor: the upstream estimate for the bus's own next stop. If it is
      // missing, fall back to the bus's straight-line distance to that stop.
      let base = v.nextStopArrival;
      if (!base) {
        const nextStop = SB.net.stopById.get(v.nextStopId);
        // Only compute a real distance when every coordinate involved is an
        // actual number - api.js normalises a missing lat/lon to null, and
        // null coerces to 0 in arithmetic, which would silently measure from
        // the equator instead of honestly falling back to the flat default.
        const haveCoords = nextStop && typeof v.lat === 'number' && typeof v.lon === 'number';
        const metres = haveCoords
          ? SB.dom.haversine(v.lat, v.lon, nextStop.lat, nextStop.lon)
          : 300;
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
      // A missing fix timestamp is unknown age, not zero age - treat it the
      // same as stale rather than as fresh, or a bus that has never reported
      // lastUpdated would get a live countdown built on nothing.
      const ageSec = v.lastUpdated ? (now - v.lastUpdated) / 1000 : null;
      const stale = ageSec == null || ageSec * 1000 > STALE_MS;

      // A stale vehicle keeps whatever instant it last had, but is never
      // smoothed further and is flagged so the UI can stop the countdown.
      const key = heldKey(v.vehicleId, stopId);
      const predictedAt = stale
        ? (held.get(key) ? held.get(key).shownAt : (Number.isFinite(rawAt) ? rawAt : null))
        : smooth(key, rawAt, now);
      if (predictedAt == null) return; // no honest number to show for this bus yet

      const ratio = stopsAway === 0 ? 1 : learned / stopsAway;
      let confidence;
      if (stopsAway <= 1) confidence = 'high';
      else if (stopsAway <= 5 || ratio >= 0.6) confidence = 'medium';
      else confidence = 'low';

      let state;
      if (stale) state = 'stale';
      else if (stopsAway === 0 && v.stopStatus === 'STOPPED_AT') state = 'at_stop';
      else if (stopsAway === 0 && v.stopStatus === 'INCOMING_AT') state = 'arriving';
      // A low-confidence row is a wide guess; the smoothed instant can drift
      // behind the wall clock as the EMA only closes part of each poll's gap,
      // which can push predictedAt within 30s of now while the underlying raw
      // estimate is still minutes out. Gating 'due' on confidence stops a wide
      // guess claiming the bus is imminent.
      else if (confidence !== 'low' && predictedAt - now <= 30000) state = 'due';
      else state = 'enroute';

      out.push({
        vehicleId: v.vehicleId,
        // Carried through so js/timetable.js can dedupe exactly rather than by
        // guesswork: a trip already shown live must not reappear as a schedule row.
        tripId: v.tripId,
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
        lon: v.lon,
        // Carried through only for js/ui-detail.js's marker popup (current
        // speed/heading/stop status) - nothing in this file reads them back.
        // Their absence here used to leave the popup permanently reading
        // "непозната брзина" for every live bus, never just when speed was
        // genuinely unreported.
        speed: v.speed,
        heading: v.heading,
        stopStatus: v.stopStatus
      });
    });

    pruneHeld(now);
    out.sort(function (a, b) { return a.predictedAt - b.predictedAt; });
    return out;
  }

  /**
   * How to render one arrival's time. Returns {text, sub} in Macedonian.
   * Low-confidence predictions show the EARLIEST plausible minute, not a
   * centred range - a direct user request: a range like "6-10 мин" got read
   * as "I have 10 minutes" and the bus arrived at 6. This bus already has a
   * live GPS fix, however far off it is, so undershooting is the safer wrong
   * answer - the worst case is checking a bit early, never missing it because
   * the number shown was the late end of a spread.
   */
  function label(arrival, nowMs) {
    const now = nowMs || Date.now();
    const sec = (arrival.predictedAt - now) / 1000;

    if (arrival.state === 'stale') {
      return {
        text: 'нема сигнал',
        sub: arrival.ageSec == null ? 'непозната старост' : 'последно пред ' + SB.dom.fmtAge(arrival.ageSec)
      };
    }
    // These report a live status straight from upstream, but that status can
    // itself be up to STALE_MS old - "на постојка" with no age reads as "right
    // now" when it might not be.
    if (arrival.state === 'at_stop' || arrival.state === 'arriving') {
      return {
        text: arrival.state === 'at_stop' ? 'на постојка' : 'пристигнува',
        sub: arrival.ageSec != null ? 'од пред ' + SB.dom.fmtAge(arrival.ageSec) : ''
      };
    }
    // Only a confident row may claim "сега" - see the 'due' gate above for why.
    if (arrival.confidence !== 'low' && sec <= 45) return { text: 'сега', sub: '' };

    const mins = Math.round(sec / 60);
    if (arrival.confidence === 'low') {
      const spread = Math.max(1, Math.round(Math.abs(mins) * 0.25));
      const early = mins - spread;
      return {
        text: early <= 0 ? 'сега' : early + ' мин',
        sub: 'приближно'
      };
    }
    if (mins <= 0) return { text: 'сега', sub: '' };
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
