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
 * OLD error curve also said not to trust a specific minute. This is also why
 * a not-yet-dispatched row states the scheduled clock time rather than
 * guessing a countdown from it - see label() below.
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
  /* Below this, a delay is not worth naming - GPS/clock jitter on an
   * otherwise on-time bus, not a real early/late signal. */
  const ON_TIME_SEC = 60;

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
        realtime: t.realtime,
        delaySec: t.arrivalDelaySec
      });
    });

    out.sort(function (a, b) { return a.predictedAt - b.predictedAt; });
    return out;
  }

  /**
   * "на време" / "доцни N мин" / "порано N мин" - a direct user request, to
   * replace a generic "предвидување" label once a trip is actually being
   * tracked: they want to know not just how long until it arrives but
   * whether it is running to the schedule that number is based on. Read
   * straight off `arrivalDelay`, upstream's own GPS-measured figure, not
   * anything this app computed itself. An implausible value falls back to
   * the old generic label rather than printing a nonsense minute count.
   */
  function delayLabel(delaySec) {
    if (typeof delaySec !== 'number' || Math.abs(delaySec) > 7200) return 'предвидување';
    if (Math.abs(delaySec) < ON_TIME_SEC) return 'на време';
    const mins = Math.round(Math.abs(delaySec) / 60);
    return delaySec > 0 ? 'доцни ' + mins + ' мин' : 'порано ' + mins + ' мин';
  }

  /**
   * How a scheduled row reads, in Macedonian.
   *
   * Not yet dispatched (`realtime: false`): no live signal exists to base a
   * minute countdown on, so - per direct user request - this states the
   * scheduled time plainly ("во 11:00" / "се очекува") instead of guessing a
   * range. A guessed range for a trip that has not even started was the
   * thing being complained about, not just its width.
   *
   * Dispatched and GPS-tracked (`realtime: true`): a single number, rounded
   * DOWN, never a range - an earlier user request, after a centred range
   * ("5-11 мин") led to the bus arriving at the near end while they were
   * still going by the far one. The small text underneath used to repeat
   * "предвидување" unconditionally; now it says whether the bus is running
   * on schedule, the more useful fact once it is actually moving.
   */
  function label(row, nowMs) {
    const now = nowMs || Date.now();
    const mins = (row.predictedAt - now) / 60000;
    const clockText = 'во ' + SB.dom.fmtClock(row.predictedAt);

    if (!row.realtime) return { text: clockText, sub: 'се очекува' };

    const sub = delayLabel(row.delaySec);
    if (mins <= 0) return { text: clockText, sub: sub };
    const early = Math.floor(mins);
    return { text: early <= 0 ? 'сега' : early + ' мин', sub: sub };
  }

  /** The secondary line under a scheduled row's headsign. Blank for a
   * not-yet-departed trip - its one useful fact, the scheduled time, is
   * already label()'s primary text above, and repeating it here would just
   * be the same clock time twice. For a tracked trip, label()'s primary text
   * is now a countdown, so this is the only place the original scheduled
   * time the delay is measured against still appears. */
  function detail(row) {
    if (!row.realtime) return '';
    return 'во ' + SB.dom.fmtClock(row.predictedAt);
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
      ON_TIME_SEC: ON_TIME_SEC
    }
  };
})();
