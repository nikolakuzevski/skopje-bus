/* debug.js — measures whether this app is actually more accurate than the one
 * it replaces. Without this the whole project is a matter of opinion.
 *
 * Every prediction made for the stop on screen is logged with the moment it was
 * made. When the bus later passes that stop (its next stop advances beyond it),
 * the real arrival time is known and each earlier prediction gets an error.
 * Errors are bucketed by how far ahead the prediction was looking, because
 * being 30s out at 10 minutes' notice is fine and being 30s out at 1 minute is
 * not. Always on and cheap; the Information tab reads it. */
(function () {
  const SB = (window.SB = window.SB || {});

  const STATS_KEY = 'debugStats';
  const MAX_PENDING_MS = 30 * 60 * 1000;
  const MAX_SAMPLES_PER_TRACK = 40;

  // 'vehicleId|stopId' -> {stopId, routeId, patternIndex, samples: [{at, predictedAt}]}
  const pending = new Map();

  const buckets = ['lt2', 'm2to5', 'gt5'];
  let stats = blank();
  let dirty = false;
  let saveTimer = null;

  function blank() {
    const s = { total: 0, byLead: {} };
    buckets.forEach(function (b) { s.byLead[b] = { n: 0, absErrorSec: 0, biasSec: 0 }; });
    return s;
  }

  function load() {
    return SB.cache.get(STATS_KEY).then(function (saved) {
      if (saved && saved.byLead) {
        stats = saved;
        buckets.forEach(function (b) {
          if (!stats.byLead[b]) stats.byLead[b] = { n: 0, absErrorSec: 0, biasSec: 0 };
        });
      }
    }).catch(function () { /* stats are optional */ });
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      SB.cache.set(STATS_KEY, stats).catch(function () { /* non-fatal */ });
    }, 20000);
  }

  function bucketFor(leadSec) {
    if (leadSec < 120) return 'lt2';
    if (leadSec <= 300) return 'm2to5';
    return 'gt5';
  }

  /** Log this poll's predictions for the stop currently on screen. */
  function recordPredictions(stopId, arrivals, nowMs) {
    const now = nowMs || Date.now();
    arrivals.forEach(function (a) {
      if (a.state === 'stale' || a.untracked) return;
      const key = a.vehicleId + '|' + stopId;
      let t = pending.get(key);
      if (!t) {
        t = { stopId: stopId, routeId: a.routeId, patternIndex: a.patternIndex, samples: [] };
        pending.set(key, t);
      }
      if (t.samples.length < MAX_SAMPLES_PER_TRACK) {
        t.samples.push({ at: now, predictedAt: a.predictedAt });
      }
    });
  }

  /**
   * Resolve any pending predictions whose bus has now moved past the stop.
   * Called with the same vehicle list the UI just rendered.
   */
  function resolve(vehicles, nowMs) {
    const now = nowMs || Date.now();
    if (!SB.net.isLoaded() || pending.size === 0) return;

    const byId = new Map();
    vehicles.forEach(function (v) { byId.set(v.vehicleId, v); });

    pending.forEach(function (track, key) {
      const vehicleId = key.split('|')[0];
      const v = byId.get(vehicleId);
      const oldest = track.samples.length ? track.samples[0].at : now;

      if (!v) {
        // Bus left the feed without us seeing it pass. Not a measurement.
        if (now - oldest > MAX_PENDING_MS) pending.delete(key);
        return;
      }

      const j = SB.net.positionOf(v.routeId, v.patternIndex, track.stopId);
      const i = v.nextStopId != null
        ? SB.net.positionOf(v.routeId, v.patternIndex, v.nextStopId)
        : -1;
      if (j < 0 || i < 0) { pending.delete(key); return; }

      if (i > j) {
        // The bus's next stop is now past the target, so it arrived roughly now.
        track.samples.forEach(function (s) {
          const leadSec = (s.predictedAt - s.at) / 1000;
          if (leadSec < 15) return;                    // nothing to predict
          const errorSec = (now - s.predictedAt) / 1000; // positive = arrived later
          const b = stats.byLead[bucketFor(leadSec)];
          b.n += 1;
          b.absErrorSec += Math.abs(errorSec);
          b.biasSec += errorSec;
          stats.total += 1;
        });
        dirty = true;
        scheduleSave();
        pending.delete(key);
        return;
      }

      if (now - oldest > MAX_PENDING_MS) pending.delete(key);
    });
  }

  function summary() {
    const out = { total: stats.total, buckets: {} };
    buckets.forEach(function (b) {
      const d = stats.byLead[b];
      out.buckets[b] = {
        n: d.n,
        meanAbsSec: d.n ? Math.round(d.absErrorSec / d.n) : null,
        biasSec: d.n ? Math.round(d.biasSec / d.n) : null
      };
    });
    return out;
  }

  function reset() {
    stats = blank();
    pending.clear();
    dirty = true;
    return SB.cache.set(STATS_KEY, stats).catch(function () {});
  }

  SB.debug = {
    load: load,
    recordPredictions: recordPredictions,
    resolve: resolve,
    summary: summary,
    reset: reset,
    pendingCount: function () { return pending.size; }
  };
})();
