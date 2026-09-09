/* cache.js — IndexedDB key/value store, plus the cached "network" snapshot
 * (routes + stops) and the lookup indexes every other module builds on.
 *
 * routes (~92 KB) and stops (~1431 entries) change rarely, so they are fetched
 * once and reused for a day. The app must be able to draw a first screen from
 * this cache without waiting for any network call — that is the whole point. */
(function () {
  const SB = (window.SB = window.SB || {});

  const DB_NAME = 'skopje-bus';
  const DB_VERSION = 1;
  const KV = 'kv';
  const SEGMENTS = 'segments'; // used by js/history.js
  const TTL_MS = 24 * 60 * 60 * 1000;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(SEGMENTS)) db.createObjectStore(SEGMENTS);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.onerror = function () { reject(t.error); };
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
      });
    });
  }

  function idbGet(store, key) { return tx(store, 'readonly', function (s) { return s.get(key); }); }
  function idbSet(store, key, val) { return tx(store, 'readwrite', function (s) { return s.put(val, key); }); }

  /* ---------------- the network snapshot ---------------- */

  const net = {
    loadedAt: 0,
    fromCache: false,
    routes: [],
    stops: [],
    stopById: new Map(),
    routeById: new Map(),
    patternByKey: new Map(),      // 'routeId:patternIndex' -> pattern
    orderByKey: new Map(),        // 'routeId:patternIndex' -> Map(stopId -> position)
    patternsByStop: new Map()     // stopId -> [{routeId, patternIndex}]
  };

  function patternKey(routeId, patternIndex) { return routeId + ':' + patternIndex; }

  function buildIndexes(routes, stops) {
    net.routes = routes;
    net.stops = stops;
    net.stopById = new Map();
    net.routeById = new Map();
    net.patternByKey = new Map();
    net.orderByKey = new Map();
    net.patternsByStop = new Map();

    stops.forEach(function (s) { net.stopById.set(s.id, s); });

    routes.forEach(function (r) {
      net.routeById.set(r.id, r);
      r.patterns.forEach(function (p) {
        const key = patternKey(r.id, p.index);
        net.patternByKey.set(key, p);
        // Position of each stop within the pattern. A stop can legitimately
        // appear twice on a loop route; keep the FIRST position so a bus is
        // never told it has already passed a stop it is still approaching.
        const order = new Map();
        p.stops.forEach(function (stopId, i) {
          if (!order.has(stopId)) order.set(stopId, i);
          let arr = net.patternsByStop.get(stopId);
          if (!arr) { arr = []; net.patternsByStop.set(stopId, arr); }
          if (!arr.some(function (x) { return x.routeId === r.id && x.patternIndex === p.index; })) {
            arr.push({ routeId: r.id, patternIndex: p.index });
          }
        });
        net.orderByKey.set(key, order);
      });
    });
  }

  /** Position of `stopId` along a pattern, or -1. */
  net.positionOf = function (routeId, patternIndex, stopId) {
    const order = net.orderByKey.get(patternKey(routeId, patternIndex));
    if (!order) return -1;
    const i = order.get(stopId);
    return i === undefined ? -1 : i;
  };

  net.pattern = function (routeId, patternIndex) {
    return net.patternByKey.get(patternKey(routeId, patternIndex)) || null;
  };

  net.routeName = function (routeId) {
    const r = net.routeById.get(routeId);
    return r ? (r.shortName || r.longName) : String(routeId);
  };

  net.isLoaded = function () { return net.stops.length > 0 && net.routes.length > 0; };
  net.isStale = function () { return Date.now() - net.loadedAt > TTL_MS; };

  /**
   * Fill `net` from IndexedDB if anything is stored, regardless of age, so the
   * UI can render immediately. Resolves true if a snapshot was loaded.
   */
  function loadFromCache() {
    return Promise.all([idbGet(KV, 'routes'), idbGet(KV, 'stops')])
      .then(function (both) {
        const routes = both[0], stops = both[1];
        if (!routes || !stops || !routes.data || !stops.data) return false;
        buildIndexes(routes.data, stops.data);
        net.loadedAt = Math.min(routes.savedAt || 0, stops.savedAt || 0);
        net.fromCache = true;
        return true;
      })
      .catch(function () { return false; });
  }

  /** Fetch a fresh snapshot and persist it. */
  function refresh() {
    return Promise.all([SB.api.routes(), SB.api.stops()]).then(function (both) {
      // An upstream hiccup returning [] must not wipe a good snapshot, in
      // memory or on disk. Callers already treat a rejected refresh() as
      // "keep serving the stale snapshot" (see ensure() below), so refusing
      // here is enough to protect both copies.
      if (!both[0].length || !both[1].length) {
        throw new Error('refresh() got an empty routes/stops snapshot, refusing to overwrite');
      }
      const savedAt = Date.now();
      buildIndexes(both[0], both[1]);
      net.loadedAt = savedAt;
      net.fromCache = false;
      return Promise.all([
        idbSet(KV, 'routes', { savedAt: savedAt, data: both[0] }),
        idbSet(KV, 'stops', { savedAt: savedAt, data: both[1] })
      ]).catch(function () { /* a full disk must not break a working session */ })
        .then(function () { return net; });
    });
  }

  /**
   * Cache-first with background revalidation. Resolves as soon as usable data
   * exists (cached or fresh); a stale-cache refresh continues in the background
   * and fires `sb:network` when it lands.
   */
  function ensure() {
    return loadFromCache().then(function (hit) {
      if (hit && !net.isStale()) return net;
      if (hit) {
        refresh().then(function () {
          window.dispatchEvent(new CustomEvent('sb:network'));
        }).catch(function () { /* keep serving the stale snapshot */ });
        return net;
      }
      return refresh();
    });
  }

  SB.cache = {
    get: idbGet.bind(null, KV),
    set: idbSet.bind(null, KV),
    segGet: idbGet.bind(null, SEGMENTS),
    segSet: idbSet.bind(null, SEGMENTS),
    stores: { KV: KV, SEGMENTS: SEGMENTS },
    raw: { get: idbGet, set: idbSet, tx: tx }
  };
  SB.net = net;
  SB.net.ensure = ensure;
  SB.net.refresh = refresh;
})();
