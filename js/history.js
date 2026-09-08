/* history.js — learns how long each stop-to-stop segment actually takes.
 *
 * Every poll, if a bus's next stop advanced by exactly one position since the
 * previous poll, the elapsed time is the real traversal time of the segment it
 * just finished. Those samples are what let eta.js predict stops beyond the
 * bus's immediate next one with something better than a distance guess.
 *
 * Deliberate limitation: this only records while the app is open, so the model
 * builds slowly and is biased toward the hours the user actually travels. That
 * is the right bias, but it means early predictions fall back to distance.
 */
(function () {
  const SB = (window.SB = window.SB || {});

  const STORE_KEY = 'all';
  const MAX_SAMPLES = 12;       // rolling window per segment per hour
  const MIN_SEC = 5;            // shorter than this is a GPS artefact
  const MAX_SEC = 900;          // longer means the bus stopped behaving like one
  const FLUSH_MS = 30000;
  /* The poll runs every 15s. A longer gap than this means the app was
   * backgrounded, offline, or backing off, so we did not actually witness when
   * the bus changed stops - only that it did, some time inside the gap. Timing
   * anything across such a gap silently poisons the model with inflated
   * samples, which is worse than having no sample at all. */
  const MAX_POLL_GAP_MS = 40000;

  // 'routeId:patternIndex|fromPos|hour' -> [seconds, ...]
  let samples = new Map();
  // vehicleId -> {key, nextStopId, pos, becameAt, confirmed}
  const seen = new Map();
  let dirty = false;
  let flushTimer = null;
  let loaded = false;
  let lastObserveAt = 0;
  let continuousSince = 0;   // start of the current unbroken run of observations

  function bucketKey(patternKey, fromPos, hour) {
    return patternKey + '|' + fromPos + '|' + hour;
  }

  function load() {
    return SB.cache.segGet(STORE_KEY).then(function (obj) {
      if (obj && typeof obj === 'object') {
        samples = new Map(Object.keys(obj).map(function (k) { return [k, obj[k]]; }));
      }
      loaded = true;
    }).catch(function () { loaded = true; });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush();
    }, FLUSH_MS);
  }

  function flush() {
    if (!dirty) return Promise.resolve();
    dirty = false;
    const obj = {};
    samples.forEach(function (v, k) { obj[k] = v; });
    return SB.cache.segSet(STORE_KEY, obj).catch(function () { /* non-fatal */ });
  }

  function record(patternKey, fromPos, hour, seconds) {
    if (seconds < MIN_SEC || seconds > MAX_SEC) return;
    const k = bucketKey(patternKey, fromPos, hour);
    let arr = samples.get(k);
    if (!arr) { arr = []; samples.set(k, arr); }
    arr.push(Math.round(seconds));
    if (arr.length > MAX_SAMPLES) arr.shift();
    dirty = true;
    scheduleFlush();
  }

  /**
   * Feed one poll's worth of vehicles. Detects single-position advances and
   * records the segment that just completed.
   */
  function observe(vehicles, nowMs) {
    if (!SB.net.isLoaded()) return;
    const now = nowMs || Date.now();

    // Any break in observation restarts the clock. Intervals that began before
    // the break are no longer measurements, only guesses, and are discarded.
    const gap = lastObserveAt ? now - lastObserveAt : Infinity;
    if (gap > MAX_POLL_GAP_MS) continuousSince = now;
    lastObserveAt = now;

    const live = new Set();

    vehicles.forEach(function (v) {
      if (v.nextStopId == null) return;
      live.add(v.vehicleId);

      const key = v.routeId + ':' + v.patternIndex;
      const pos = SB.net.positionOf(v.routeId, v.patternIndex, v.nextStopId);
      if (pos < 0) return;

      const prev = seen.get(v.vehicleId);
      if (prev && prev.key === key && prev.nextStopId === v.nextStopId) return; // unchanged

      if (prev && prev.key === key && prev.confirmed && pos === prev.pos + 1 && prev.pos >= 1 &&
          prev.becameAt >= continuousSince) {
        // The target moved from stops[prev.pos] to stops[pos], so the bus just
        // reached stops[prev.pos]. Time since that target was set is how long
        // it took to cover stops[prev.pos - 1] -> stops[prev.pos].
        record(key, prev.pos - 1, new Date(prev.becameAt).getHours(), (now - prev.becameAt) / 1000);
      }

      seen.set(v.vehicleId, {
        key: key,
        nextStopId: v.nextStopId,
        pos: pos,
        becameAt: now,
        // Only intervals whose start we actually witnessed are usable as samples.
        confirmed: !!(prev && prev.key === key)
      });
    });

    // Drop vehicles that left the feed so `seen` cannot grow without bound.
    seen.forEach(function (_, id) { if (!live.has(id)) seen.delete(id); });
  }

  function median(arr) {
    const s = arr.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  }

  /**
   * Learned traversal time for stops[fromPos] -> stops[fromPos + 1], in seconds,
   * or null. Falls back to adjacent hours, then to any hour: 08:00 resembles
   * 09:00 far more closely than it resembles nothing at all.
   */
  function segmentSeconds(patternKey, fromPos, hour) {
    if (!loaded) return null;

    const exact = samples.get(bucketKey(patternKey, fromPos, hour));
    if (exact && exact.length >= 2) return median(exact);

    const pooled = [];
    [hour, (hour + 23) % 24, (hour + 1) % 24].forEach(function (h) {
      const a = samples.get(bucketKey(patternKey, fromPos, h));
      if (a) pooled.push.apply(pooled, a);
    });
    if (pooled.length >= 2) return median(pooled);

    const any = [];
    for (let h = 0; h < 24; h++) {
      const a = samples.get(bucketKey(patternKey, fromPos, h));
      if (a) any.push.apply(any, a);
    }
    return any.length >= 3 ? median(any) : null;
  }

  function stats() {
    let total = 0;
    samples.forEach(function (a) { total += a.length; });
    return { segments: samples.size, samples: total };
  }

  SB.history = {
    load: load,
    observe: observe,
    segmentSeconds: segmentSeconds,
    flush: flush,
    stats: stats
  };
})();
