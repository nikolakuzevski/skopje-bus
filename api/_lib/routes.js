/* _lib/routes.js — routeId -> short line name ("12", "11 П", ...), so a push
 * notification can say "Автобус 12" instead of a bare numeric routeId.
 *
 * Cached at module scope, which on Vercel persists across invocations on a
 * warm serverless instance (not guaranteed, but free when it happens) - the
 * route list changes rarely enough that even a full refetch every cold start
 * is cheap (92 KB) next to the per-stop /times calls this runs alongside.
 */

const MODESHIFT = 'https://www.modeshift.app/api/v1/9814b106-2afe-47c8-919b-bdec6a5e521e/';

let cache = null; // Map<routeId, shortName>
let cachedAt = 0;
const TTL_MS = 60 * 60 * 1000;

async function routeNameMap() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const res = await fetch(MODESHIFT + 'transport/planner/routes');
  if (!res.ok) return cache || new Map();
  const routes = await res.json();
  const map = new Map();
  (routes || []).forEach(function (r) {
    map.set(r.id, r.shortName || r.longName || String(r.id));
  });
  cache = map;
  cachedAt = Date.now();
  return map;
}

module.exports = { routeNameMap: routeNameMap };
