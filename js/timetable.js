/* timetable.js — per-stop scheduled departures, GPS-corrected where tracked.
 *
 * SUPERSEDES an earlier design that no longer exists in git history's working
 * tree by the time you read this comment, only in git log: this used to build
 * an in-memory index out of the 12 MB `transport/gtfsrt/tripupdates` feed,
 * because that was the only source found at the time and it genuinely does
 * NOT carry absolute per-stop times (`arrival.time` is 0 in every entry - see
 * the old code in git history, or CLAUDE.md's account of it). That shaped a
 * documented, and wrong, conclusion: "JSP does not publish an advance
 * timetable anywhere reachable."
 *
 * It does. `transport/planner/stops/{id}/times` was found 2026-09-11 while
 * chasing a user report of too few buses at a stop, by inspecting
 * skopjebus.mk's own network traffic rather than guessing at URLs again. It
 * returns, per route serving the stop, every remaining scheduled departure
 * for the rest of the service day - not just trips already dispatched - each
 * with a `realtime` flag and, when true, a GPS-measured `arrivalDelay` in
 * seconds. For stop 1820 (the report that started this) it returned 19
 * departures where the old live-position-only view could show at most the
 * handful of buses currently dispatched (2, at the time it was checked - see
 * CLAUDE.md for the full account of why that number was not a bug).
 *
 * Cross-checked before trusting it: for 39 (stop, realtime trip) pairs across
 * four busy stops, `scheduledArrival + arrivalDelay` was compared against this
 * app's own live-position estimate (js/eta.js) for the SAME trip and stop.
 * Close in: agreement was within a couple of minutes, the same ballpark as
 * js/eta.js's own measured accuracy for a bus a few stops out. Far in (a trip
 * still 15-20+ stops from the target): the two diverged by 5-20 minutes, which
 * is not upstream being wrong so much as both sources doing the same kind of
 * long-range extrapolation and disagreeing on it - exactly where this app's
 * OLD error curve also said not to trust a specific minute. See MARGIN below.
 *
 * Per-stop, not per-day: at ~5 KB and ~500 ms for a busy stop, fetching it
 * fresh for whichever one stop is actually on screen is simpler and more
 * current than caching a whole day up front, and small enough that it needs
 * none of the "explicit, user-triggered, 12 MB" ceremony the old tripUpdates
 * path required.
 */
(function () {
  const SB = (window.SB = window.SB || {});

  /* 40, not 60: the user first asked for buses within an hour, then asked
   * specifically for 40 minutes once they saw what an hour's worth looked
   * like. Unchanged by this rewrite. */
  const HORIZON_MIN = 40;
  const REFRESH_MS = 60000;    // how long a stop's fetched entries are reused
  const PAST_GRACE_MIN = 3;    // keep a row this long after its predicted time, then drop it

  /* Margin bands for the minute range shown, in minutes either side of the
   * predicted instant. `REALTIME` is backed by the cross-check above. The
   * other two are NOT independently measured yet - they are a deliberately
   * conservative carry-over of "closer means more trustworthy," the same
   * shape as the old ERROR_CURVE without its specific numbers, because this
   * is a different upstream source and claiming a measured figure for it
   * would be the same kind of overclaim this project exists to avoid. Past
   * MID_HORIZON_MIN, no number is shown at all - only the clock time. */
  const MARGIN_REALTIME_MIN = 2;
  const MARGIN_NEAR_MIN = 3;
  const MARGIN_MID_MIN = 6;
  const NEAR_HORIZON_MIN = 15;
  const MID_HORIZON_MIN = 30;

  const cache = new Map();     // stopId -> {fetchedAt, entries}
  const inFlight = new Map();  // stopId -> Promise

  /**
   * Cache-first per stop, background-refreshed. Resolves the cached entries
   * (possibly stale, possibly empty on a first call) and, once a fetch lands,
   * fires `sb:timetable` so a caller who did not await this specific call
   * (e.g. the poll loop) can repaint. Never rejects — a failed fetch just
   * leaves the previous cache (or nothing) in place, same as the rest of this
   * app's degrade-rather-than-break convention.
   */
  function ensureForStop(stopId, nowMs) {
    const now = nowMs || Date.now();
    const cached = cache.get(stopId);
    if (cached && now - cached.fetchedAt < REFRESH_MS) return Promise.resolve(cached.entries);
    if (inFlight.has(stopId)) return inFlight.get(stopId);

    const p = SB.api.stopTimes(stopId).then(function (entries) {
      inFlight.delete(stopId);
      cache.set(stopId, { fetchedAt: Date.now(), entries: entries });
      window.dispatchEvent(new CustomEvent('sb:timetable', { detail: { stopId: stopId } }));
      return entries;
    }, function () {
      inFlight.delete(stopId);
      return cached ? cached.entries : [];
    });
    inFlight.set(stopId, p);
    return p;
  }

  /** True once *any* fetch for this stop has landed, however old. */
  function hasDataFor(stopId) {
    return cache.has(stopId);
  }

  function ageMsFor(stopId, nowMs) {
    const c = cache.get(stopId);
    return c ? (nowMs || Date.now()) - c.fetchedAt : null;
  }

  /**
   * Trips serving `stopId`, not already present in `renderedArrivals` (the
   * live/far rows js/eta.js already drew for the same tripId - a live GPS
   * anchor beats a schedule estimate every time and the same bus must never
   * appear twice), due within HORIZON_MIN and not more than PAST_GRACE_MIN
   * past their predicted time. Reads only from the cache filled by
   * `ensureForStop` — this function itself never fetches, so it is safe to
   * call on every poll.
   */
  function upcomingForStop(stopId, renderedArrivals, nowMs) {
    const now = nowMs || Date.now();
    const cached = cache.get(stopId);
    if (!cached) return [];

    const renderedTripIds = new Set((renderedArrivals || [])
      .map(function (a) { return a.tripId; })
      .filter(Boolean));

    const out = [];
    cached.entries.forEach(function (t) {
      if (t.tripId == null || renderedTripIds.has(t.tripId)) return;
      if (t.scheduledArrival == null) return;

      const predictedAt = t.scheduledArrival + t.arrivalDelaySec * 1000;
      const minsAway = (predictedAt - now) / 60000;
      if (minsAway > HORIZON_MIN) return;
      if (minsAway < -PAST_GRACE_MIN) return;

      out.push({
        scheduled: true,
        tripId: t.tripId,
        vehicleId: 's' + t.tripId,
        routeId: t.routeId,
        routeName: SB.net.isLoaded() ? SB.net.routeName(t.routeId) : String(t.routeId),
        headsign: t.headsign,
        predictedAt: predictedAt,
        realtime: t.realtime
      });
    });

    out.sort(function (a, b) { return a.predictedAt - b.predictedAt; });
    return out;
  }

  /**
   * How a scheduled row reads, in Macedonian. The word the user asked for,
   * "предвидување", is used unconditionally here - every row this module
   * emits is schedule-derived, even the `realtime` ones (their GPS correction
   * makes the NUMBER more trustworthy, it does not turn them into a live
   * position the way js/eta.js's rows are). Where the margin bands above say
   * a minute figure would not be trustworthy, only the clock time is shown.
   */
  function label(row, nowMs) {
    const now = nowMs || Date.now();
    const mins = (row.predictedAt - now) / 60000;
    const clockText = 'во ' + SB.dom.fmtClock(row.predictedAt);
    const sub = 'предвидување';

    if (mins <= 0) return { text: clockText, sub: sub };

    let margin = null;
    if (row.realtime) margin = MARGIN_REALTIME_MIN;
    else if (mins <= NEAR_HORIZON_MIN) margin = MARGIN_NEAR_MIN;
    else if (mins <= MID_HORIZON_MIN) margin = MARGIN_MID_MIN;
    if (margin == null) return { text: clockText, sub: sub };

    const lo = Math.round(mins - margin);
    const hi = Math.round(mins + margin);
    if (hi <= 0) return { text: clockText, sub: sub };
    // Never clamp the low end up to 1: that would claim the bus is at least a
    // minute away when the margin allows for it having already arrived.
    if (lo <= 0) return { text: 'до ' + hi + ' мин', sub: sub };
    return { text: lo + '-' + hi + ' мин', sub: sub };
  }

  /** The secondary line under a scheduled row. Only adds the clock time when
   * the primary time column (label(), above) is not already showing it - past
   * MID_HORIZON_MIN both would otherwise print the identical "во HH:MM" twice. */
  function detail(row, nowMs) {
    const now = nowMs || Date.now();
    const mins = (row.predictedAt - now) / 60000;
    const primaryIsClockOnly = mins <= 0 ||
      (!row.realtime && mins > MID_HORIZON_MIN);
    if (primaryIsClockOnly) return row.realtime ? 'GPS-коригирано' : '';
    return 'во ' + SB.dom.fmtClock(row.predictedAt) + (row.realtime ? ' · GPS-коригирано' : '');
  }

  SB.timetable = {
    ensureForStop: ensureForStop,
    upcomingForStop: upcomingForStop,
    label: label,
    detail: detail,
    hasDataFor: hasDataFor,
    ageMsFor: ageMsFor,
    entriesFor: function (stopId) {
      const c = cache.get(stopId);
      return c ? c.entries : [];
    },
    refreshMs: REFRESH_MS,
    constants: {
      HORIZON_MIN: HORIZON_MIN,
      NEAR_HORIZON_MIN: NEAR_HORIZON_MIN,
      MID_HORIZON_MIN: MID_HORIZON_MIN
    }
  };
})();
