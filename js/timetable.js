/* timetable.js — today's departures, and honest predictions built from them.
 *
 * Replaces the older untracked.js: both features need the same 12 MB TripUpdates
 * feed, so it is fetched once, reduced, and reused.
 *
 * WHAT UPSTREAM ACTUALLY GIVES US (measured at scale on 2026-09-07, 79,666 stop
 * time updates across 3,032 trips — these are constraints, not guesses):
 *   - `arrival.time` is 0 in EVERY entry. There is no absolute scheduled arrival
 *     time per stop, anywhere. The only schedule anchor that exists is the trip's
 *     departure time from its first stop (`trip.startTime`).
 *   - `arrival.delay` is mostly the sentinel -9999, which taken literally reads as
 *     "166 minutes early". It means unknown and is never displayed.
 *   - `stopTimeUpdate` IS an ordered stop list (stopSequence 1..N ascending).
 *   - 3023 of 3032 trips (99.7%) match a known route pattern exactly on
 *     routeId + ordered stop list, so a trip can reuse the learned segment times
 *     in js/history.js. The 9 that do not carry their own stop list instead.
 *   - tripId joins perfectly to the live vehicles feed (102/102), so "has this
 *     trip actually started" is answerable exactly rather than inferred.
 *
 * So an arrival estimate here can only ever be: departure time, plus the time to
 * travel from the first stop to yours. That is a genuine prediction and is
 * labelled as one. How wrong it is was measured, not assumed — see ERROR_CURVE.
 *
 * CONFIRMED SEPARATELY: JSP does not publish an advance timetable
 * anywhere reachable. No GTFS static feed exists at any plausible URL on
 * jsp.com.mk or skopjebus.mk (all checked, all 404), and neither transit.land
 * nor mobilitydatabase.org lists a Skopje/JSP operator. A decade-old academic
 * GTFS conversion of JSP's data exists in research papers but was never
 * publicly hosted and is not maintained. So `upcomingForStop()` below can only
 * ever surface the trips that already happen to appear in this rolling feed
 * with a future startTime - which measured consistently under 1% of a day's
 * trips at any given moment. It is the best available answer, not a full one,
 * and the list being short or empty most of the time is that limit showing,
 * not a bug.
 */
(function () {
  const SB = (window.SB = window.SB || {});

  /* 40, not 60: past the first cut the user asked for buses within an hour,
   * then asked specifically for 40 minutes instead once they saw what an
   * hour's worth of this feed actually looks like. */
  const HORIZON_MIN = 40;
  /* TripUpdates is a rolling record of DISPATCHED trips, not a published
   * timetable (measured: 5 of 1472 today-trips had a future start time). A
   * snapshot therefore cannot know about buses dispatched after it was taken,
   * so it goes out of date within the hour rather than lasting the service day.
   * Rows are only drawn from a snapshot younger than this. */
  const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
  const MIN_PER_STOP = 2;          // rough trip length, for "has it finished yet"
  const FALLBACK_SPEED_MPS = 4.7;
  const DWELL_SEC = 12;

  /* Measured p90 absolute error of a schedule-only prediction, against the live
   * feed's own arrival estimate, bucketed by how far into the trip the stop is.
   * [minutesIntoTrip, p90ErrorMinutes]. Error grows sharply once a bus is deep
   * into its route, which is exactly why a single fixed margin would be a lie.
   *   0-10 min in : median 2.1, p90 5.0
   *  10-20 min in : median 3.4, p90 7.1
   *  20-35 min in : median 4.7, p90 9.2
   *  35-60 min in : median 8.6, p90 35.2
   *    60+ min in : median 24.0, p90 54.4
   */
  const ERROR_CURVE = [
    [10, 5],
    [20, 7],
    [35, 10]
  ];
  /* Past this point into a trip the p90 error exceeds half an hour. A minute
   * figure there would be fiction, so none is shown at all. */
  const NO_ESTIMATE_AFTER_MIN = 35;

  let dayStamp = null;   // 'YYYYMMDD' the cached timetable belongs to
  let trips = [];        // {tripId, routeId, patternIndex, startMin, stops?}
  let byStop = null;     // stopId -> [{trip, position}]
  let loadedAt = 0;
  let inFlight = null;

  function saveDataOn() {
    const c = navigator.connection;
    return !!(c && (c.saveData || /^(slow-)?2g$/.test(c.effectiveType || '')));
  }

  function stampOf(nowMs) {
    const d = new Date(nowMs);
    return String(d.getFullYear()) +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
  }

  /* Minutes since local midnight, read from the wall clock rather than from
   * elapsed real time since a computed midnight instant. Those two diverge by
   * a full hour on the two DST changeover days a year, because elapsed time
   * is not wall-clock time while startMin (parsed from "HH:MM:SS") is. Reading
   * the wall clock directly keeps both quantities in the same frame. */
  function wallClockMinutes(nowMs) {
    const d = new Date(nowMs);
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  /* The anchor instant for a trip's departure, built the same wall-clock way -
   * new Date(y, m, date, h, m) resolves the local offset for that exact
   * instant, so it stays correct across the DST boundary instead of drifting
   * with elapsed-time-since-midnight arithmetic. */
  function wallClockInstant(nowMs, minutesSinceMidnight) {
    const d = new Date(nowMs);
    return new Date(
      d.getFullYear(), d.getMonth(), d.getDate(),
      Math.floor(minutesSinceMidnight / 60), minutesSinceMidnight % 60
    ).getTime();
  }

  /* ---------------- building the compact timetable ---------------- */

  function patternLookup() {
    const map = new Map();
    SB.net.routes.forEach(function (r) {
      r.patterns.forEach(function (p) {
        map.set(r.id + '|' + p.stops.join(','), p.index);
      });
    });
    return map;
  }

  /**
   * Reduce the 12 MB feed to ~73 KB: a trip needs only its id, route, matched
   * pattern and departure minute. The full stop list is kept only for the
   * handful of trips that match no known pattern. Everything else is discarded
   * immediately so the 12 MB never becomes 12 MB of retained state.
   */
  function reduce(feed, nowMs) {
    const today = stampOf(nowMs);
    const patterns = patternLookup();
    const out = [];

    (feed.entity || []).forEach(function (e) {
      const u = e.tripUpdate;
      if (!u || !u.trip || u.trip.startDate !== today) return;

      const parts = String(u.trip.startTime || '').split(':');
      if (parts.length < 2) return;
      const startMin = Number(parts[0]) * 60 + Number(parts[1]);
      if (!isFinite(startMin)) return;

      const stopIds = [];
      (u.stopTimeUpdate || []).forEach(function (s) {
        if (s.stopId != null) stopIds.push(Number(s.stopId));
      });
      if (!stopIds.length) return;

      const routeId = Number(u.trip.routeId);
      const patternIndex = patterns.get(routeId + '|' + stopIds.join(','));

      const rec = {
        tripId: u.trip.tripId,
        routeId: routeId,
        startMin: startMin,
        patternIndex: patternIndex === undefined ? -1 : patternIndex
      };
      if (patternIndex === undefined) rec.stops = stopIds;
      out.push(rec);
    });

    return out;
  }

  function index() {
    byStop = new Map();
    trips.forEach(function (t) {
      const stops = stopsOf(t);
      if (!stops) return;
      for (let i = 0; i < stops.length; i++) {
        const id = stops[i];
        let arr = byStop.get(id);
        if (!arr) { arr = []; byStop.set(id, arr); }
        // A loop route can list a stop twice; keep the first pass, matching the
        // convention in cache.js so a bus is never told it already went past.
        if (!arr.some(function (x) { return x.trip === t; })) {
          arr.push({ trip: t, position: i });
        }
      }
    });
  }

  function stopsOf(t) {
    if (t.stops) return t.stops;
    const p = SB.net.pattern(t.routeId, t.patternIndex);
    return p ? p.stops : null;
  }

  /* ---------------- loading ---------------- */

  function fromCache(nowMs) {
    return SB.cache.get('timetable').then(function (saved) {
      if (!saved || saved.day !== stampOf(nowMs) || !Array.isArray(saved.trips)) return false;
      /* An empty snapshot must never be cached as authoritative for the day.
       * Taken just after midnight the feed legitimately returns nothing, and
       * accepting that would leave the app showing no scheduled buses until
       * tomorrow - the "buses go missing" failure this project exists to fix. */
      if (!saved.trips.length) return false;
      trips = saved.trips;
      loadedAt = saved.savedAt || 0;
      dayStamp = saved.day;
      index();
      return true;
    }).catch(function () { return false; });
  }

  /** Fetch and rebuild. Expensive (12 MB, ~1.2s) — call at most once a day. */
  function refresh(nowMs) {
    if (inFlight) return inFlight;
    const now = nowMs || Date.now();

    inFlight = SB.api.tripUpdatesExpensive().then(function (feed) {
      trips = reduce(feed, now);
      dayStamp = stampOf(now);
      loadedAt = now;
      index();
      return SB.cache.set('timetable', { day: dayStamp, savedAt: now, trips: trips })
        .catch(function () { /* a full disk must not break a working session */ })
        .then(function () { return trips; });
    }).then(function (r) { inFlight = null; return r; },
            function (e) { inFlight = null; throw e; });

    return inFlight;
  }

  /**
   * Cache-first. Resolves false if today's timetable is not available and was
   * not fetched — callers must degrade rather than assume.
   */
  function ensure(nowMs, opts) {
    const now = nowMs || Date.now();
    const allowFetch = !(opts && opts.cachedOnly);
    return fromCache(now).then(function (hit) {
      if (hit) return true;
      if (!allowFetch) return false;
      if (saveDataOn()) return false;
      return refresh(now).then(function () { return true; })
        .catch(function () { return false; });
    });
  }

  /* ---------------- prediction ---------------- */

  /** Seconds to travel stops[from] -> stops[to], learned where possible. */
  function traversalSeconds(t, from, to, hour) {
    const stops = stopsOf(t);
    if (!stops || to <= from) return { seconds: 0, learned: 0, total: 0 };

    const patternKey = t.patternIndex >= 0 ? t.routeId + ':' + t.patternIndex : null;
    let seconds = 0;
    let learned = 0;

    for (let k = from; k < to; k++) {
      let seg = null;
      if (patternKey) seg = SB.history.segmentSeconds(patternKey, k, hour);
      if (seg != null) {
        seconds += seg;
        learned++;
      } else {
        const a = SB.net.stopById.get(stops[k]);
        const b = SB.net.stopById.get(stops[k + 1]);
        if (!a || !b) return null;   // cannot estimate honestly; caller suppresses
        seconds += SB.dom.haversine(a.lat, a.lon, b.lat, b.lon) / FALLBACK_SPEED_MPS + DWELL_SEC;
      }
    }
    return { seconds: seconds, learned: learned, total: to - from };
  }

  /** Measured p90 error, in minutes, for a prediction this far into a trip. */
  function marginMinutes(elapsedMin, learnedRatio) {
    let base = ERROR_CURVE[ERROR_CURVE.length - 1][1];
    for (let i = 0; i < ERROR_CURVE.length; i++) {
      if (elapsedMin <= ERROR_CURVE[i][0]) { base = ERROR_CURVE[i][1]; break; }
    }
    // Learned segments beat the distance fallback the curve was measured with,
    // so the band narrows as the app learns — but never below two minutes,
    // because the departure time itself is only given to the minute. The 0.15
    // factor is a conservative allowance, not a measured figure: ERROR_CURVE
    // above was measured directly, this shrink has not been, so it is kept
    // small until js/debug.js's scheduled-prediction track can check it.
    const shrink = 1 - 0.15 * (learnedRatio || 0);
    return Math.max(2, Math.round(base * shrink));
  }

  /**
   * Trips not yet dispatched that will reach `stopId` within the horizon.
   *
   * Deliberately NOT every trip the timetable knows about heading this way:
   * this function used to also include trips that had already started but had
   * no live vehicle ("no_signal"). That was a real complaint, not a taste
   * preference - opening the app kept showing a list dominated by buses that
   * had already left, when what was asked for was buses still to come. Those
   * already-departed, no-GPS trips are real and still worth knowing about, but
   * they belong to a different question ("is my bus running dark") than this
   * one ("what's still coming") - js/ui-info.js's `runningWithoutGps()` answers
   * that one separately, on the Information tab, not mixed into this list.
   *
   * Deduped against the arrivals js/eta.js ALREADY RENDERED, not against every
   * bus with a live position. Those are different sets: eta.js stops at
   * MAX_STOPS_AWAY, so on a long route a bus can be live and still absent from
   * the list, and excluding it here would hide it from both views. Anything
   * eta.js did show is dropped, because a live GPS anchor beats a schedule
   * estimate every time and the same bus must never appear twice.
   */
  function upcomingForStop(stopId, renderedArrivals, liveVehicles, nowMs) {
    const now = nowMs || Date.now();
    if (!byStop || !SB.net.isLoaded()) return [];

    const entries = byStop.get(Number(stopId));
    if (!entries) return [];

    const renderedTripIds = new Set((renderedArrivals || [])
      .map(function (a) { return a.tripId; })
      .filter(Boolean));

    /* Rendered and live are NOT the same set, and conflating them was a real
     * bug: eta.js stops at MAX_STOPS_AWAY, so a bus can be tracked perfectly
     * well and still be absent from the list. Treating those as "no signal"
     * told the user a bus was untracked when it was not. */
    const liveByTrip = new Map();
    (liveVehicles || []).forEach(function (v) {
      if (v.tripId) liveByTrip.set(v.tripId, v);
    });

    const hour = new Date(now).getHours();
    const nowMin = wallClockMinutes(now);
    const out = [];

    entries.forEach(function (entry) {
      const t = entry.trip;
      if (renderedTripIds.has(t.tripId)) return;      // already on screen from eta.js

      // Not yet dispatched, full stop - see the doc comment above for why an
      // already-departed trip with no GPS does not belong in this list even
      // though the timetable also knows about it.
      if (nowMin >= t.startMin) return;

      const stops = stopsOf(t);
      if (!stops) return;

      /* Anything with a live position is now handled entirely by eta.js, which
       * the caller runs at a widened range. This module only supplies what the
       * live feed genuinely cannot know. */
      if (liveByTrip.has(t.tripId)) return;

      const anchorMs = wallClockInstant(now, t.startMin);
      const fromPos = 0;

      const trav = traversalSeconds(t, fromPos, entry.position, hour);
      if (!trav) return;                               // missing coordinates

      const elapsedMin = trav.seconds / 60;
      const predictedAt = anchorMs + trav.seconds * 1000;
      const minsAway = (predictedAt - now) / 60000;

      if (minsAway > HORIZON_MIN) return;              // beyond the hour asked for
      if (minsAway < -10) return;                      // long gone

      const learnedRatio = trav.total ? trav.learned / trav.total : 1;

      out.push({
        scheduled: true,
        tripId: t.tripId,
        vehicleId: 's' + t.tripId,
        routeId: t.routeId,
        routeName: SB.net.routeName(t.routeId),
        headsign: destinationName(t),
        departureMin: t.startMin,
        stopsFromOrigin: entry.position,
        predictedAt: predictedAt,
        // Suppressed deliberately when the measured error makes a number
        // meaningless. The row still appears; it just does not claim a minute.
        estimateUsable: elapsedMin <= NO_ESTIMATE_AFTER_MIN,
        marginMin: marginMinutes(elapsedMin, learnedRatio),
        elapsedMin: elapsedMin,
        learnedRatio: learnedRatio
      });
    });

    out.sort(function (a, b) { return a.predictedAt - b.predictedAt; });
    return out;
  }

  function destinationName(t) {
    const stops = stopsOf(t);
    const last = stops && stops.length ? stops[stops.length - 1] : null;
    const stop = last != null ? SB.net.stopById.get(last) : null;
    return stop ? stop.name : SB.net.routeName(t.routeId);
  }

  /** Trips that should be running now but have no live vehicle. */
  function runningWithoutGps(liveVehicles, nowMs) {
    const now = nowMs || Date.now();
    // A snapshot that has outlived its service day (left the app open
    // overnight) must not be filtered against a fresh nowMin - that reads
    // yesterday's trips as still running today and inflates this count.
    if (dayStamp !== stampOf(now)) return [];
    const nowMin = wallClockMinutes(now);
    const liveTripIds = new Set((liveVehicles || [])
      .map(function (v) { return v.tripId; }).filter(Boolean));

    return trips.filter(function (t) {
      if (liveTripIds.has(t.tripId)) return false;
      if (t.startMin > nowMin) return false;
      const stops = stopsOf(t);
      if (!stops) return false;
      return t.startMin + stops.length * MIN_PER_STOP >= nowMin;
    });
  }

  function clockOf(minutes) {
    const h = Math.floor(minutes / 60) % 24;
    return String(h).padStart(2, '0') + ':' + String(Math.round(minutes % 60)).padStart(2, '0');
  }

  /**
   * How a scheduled row reads, in Macedonian.
   *
   * The word the user asked for is "предвидување", and it is used for every row
   * here without exception, because every row here IS one: none of these buses
   * has reported a position. Where the measured error makes a minute figure
   * meaningless, no minute figure is printed at all - only the departure time,
   * which is the one thing upstream actually states.
   */
  function label(row, nowMs) {
    const now = nowMs || Date.now();
    // Every row here has not departed yet (upcomingForStop filters strictly
    // on nowMin >= t.startMin), so "тргнува" (departs, not yet past tense) is
    // accurate rather than just cautious.
    const depart = 'тргнува ' + clockOf(row.departureMin);

    // Every row this module emits has no live vehicle - anything tracked is
    // shown by eta.js instead, which uses its own "приближно"/exact wording.
    // So "предвидување" applies unconditionally here, exactly as asked for.
    const sub = 'предвидување';

    if (!row.estimateUsable) return { text: depart, sub: sub };

    const mins = (row.predictedAt - now) / 60000;
    const lo = Math.round(mins - row.marginMin);
    const hi = Math.round(mins + row.marginMin);

    // Past its window entirely: say when it left, do not invent a countdown.
    if (hi <= 0) return { text: depart, sub: sub };

    // Due already, but still inside the margin. Clamping the low end up to 1
    // would claim the bus is at least a minute away when it may have gone.
    if (lo <= 0) return { text: 'до ' + hi + ' мин', sub: sub };

    return { text: lo + '-' + hi + ' мин', sub: sub };
  }

  /** The secondary line under a scheduled row. */
  function detail(row) {
    const bits = ['тргнува ' + clockOf(row.departureMin)];
    if (row.stopsFromOrigin > 0) bits.push(row.stopsFromOrigin + ' постојки од почетна');
    return bits.join(' · ');
  }

  SB.timetable = {
    ensure: ensure,
    label: label,
    detail: detail,
    refresh: refresh,
    upcomingForStop: upcomingForStop,
    runningWithoutGps: runningWithoutGps,
    saveDataOn: saveDataOn,
    isLoaded: function () { return !!byStop && trips.length > 0; },
    /** Young enough for its rows to be drawn. See SNAPSHOT_TTL_MS. */
    isFresh: function () {
      return !!byStop && trips.length > 0 && (Date.now() - loadedAt) < SNAPSHOT_TTL_MS;
    },
    ttlMs: SNAPSHOT_TTL_MS,
    day: function () { return dayStamp; },
    loadedAt: function () { return loadedAt; },
    tripCount: function () { return trips.length; },
    constants: {
      HORIZON_MIN: HORIZON_MIN,
      NO_ESTIMATE_AFTER_MIN: NO_ESTIMATE_AFTER_MIN,
      ERROR_CURVE: ERROR_CURVE
    }
  };
})();
