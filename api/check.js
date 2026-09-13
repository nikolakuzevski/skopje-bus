/* api/check.js — the actual notifier, triggered on a schedule from OUTSIDE
 * Vercel (see .github/workflows/notify-check.yml): Vercel's own Hobby-tier
 * cron only runs once a day, useless for "the bus is 3 minutes away," so a
 * GitHub Actions schedule calls this endpoint every few minutes instead.
 * Guarded by CRON_SECRET so this can't be triggered (or discovered, DoS'd,
 * or used to leak whether any given stopId has subscribers) by anyone who
 * finds the URL - this deployment and its source are both public.
 *
 * Deliberately notifies only from `realtime: true` schedule entries (a
 * GPS-tracked, already-dispatched trip) - see CLAUDE.md and js/timetable.js
 * for why a not-yet-dispatched trip's predicted time is not trustworthy
 * enough to wake someone's phone over. The per-stop /times endpoint gives
 * this directly, GPS-corrected, without needing to re-implement js/eta.js's
 * live-position pattern matching server-side.
 */

const webpush = require('web-push');
const { readStore, writeStore } = require('./_lib/gist');
const { routeNameMap } = require('./_lib/routes');

const MODESHIFT = 'https://www.modeshift.app/api/v1/9814b106-2afe-47c8-919b-bdec6a5e521e/';
/* Matches the user's own stated preference from the in-app label work: tight
 * enough to be a genuine "it's coming" alert, never so early it reads as
 * noise. Kept in one place rather than duplicating js/timetable.js's numbers,
 * since this runs server-side against a different (simpler) code path. */
const NOTIFY_THRESHOLD_MIN = 3;
/* A trip already past its predicted time is still worth one notification
 * (upstream's own estimate can undershoot) but not an old, stale one. */
const PAST_GRACE_MIN = 2;
/* How long a (subscription, trip) pair stays in the dedupe log once
 * notified - long enough that this same cron run (or the next few) can't
 * double-send for the same bus, short enough that the log does not grow
 * without bound. */
const NOTIFIED_TTL_MS = 90 * 60 * 1000;

async function fetchRealtimeStopTimes(stopId) {
  const res = await fetch(MODESHIFT + 'transport/planner/stops/' + stopId + '/times');
  if (!res.ok) return [];
  const routes = await res.json();
  const out = [];
  (routes || []).forEach(function (r) {
    const routeId = r.route && r.route.routeId;
    (r.times || []).forEach(function (t) {
      if (!t.realtime || t.tripId == null || !t.scheduledArrival) return;
      const delaySec = typeof t.arrivalDelay === 'number' ? t.arrivalDelay : 0;
      out.push({
        tripId: String(t.tripId),
        routeId: routeId,
        headsign: t.headsign || '',
        predictedAt: Date.parse(t.scheduledArrival) + delaySec * 1000
      });
    });
  });
  return out;
}

module.exports = async function handler(req, res) {
  const provided = req.headers['x-cron-secret'] || (req.query && req.query.secret);
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    res.status(500).json({ error: 'VAPID keys not configured' });
    return;
  }

  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_CONTACT_EMAIL || 'admin@example.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  try {
    const { store, filename } = await readStore();
    const now = Date.now();
    store.notified = store.notified.filter(function (n) { return now - n.at < NOTIFIED_TTL_MS; });

    if (!store.subscriptions.length) {
      res.status(200).json({ ok: true, subscriptions: 0, sent: 0 });
      return;
    }

    const stopIds = Array.from(new Set(store.subscriptions.map(function (s) { return s.stopId; })));
    const timesByStop = {};
    for (const sid of stopIds) timesByStop[sid] = await fetchRealtimeStopTimes(sid);

    const routeNames = await routeNameMap();
    const notifiedKeys = new Set(store.notified.map(function (n) { return n.key; }));
    const stillAlive = [];
    let sent = 0;

    for (const sub of store.subscriptions) {
      const entries = timesByStop[sub.stopId] || [];
      const due = entries.filter(function (e) {
        const minsAway = (e.predictedAt - now) / 60000;
        return minsAway <= NOTIFY_THRESHOLD_MIN && minsAway > -PAST_GRACE_MIN;
      });

      let dropSubscription = false;
      for (const e of due) {
        const key = sub.endpoint + '|' + e.tripId;
        if (notifiedKeys.has(key)) continue;

        const mins = Math.max(0, Math.floor((e.predictedAt - now) / 60000));
        const routeName = routeNames.get(e.routeId) || String(e.routeId || '');
        const payload = JSON.stringify({
          title: 'Автобус ' + routeName + (e.headsign ? ' · ' + e.headsign : ''),
          body: mins <= 0 ? 'Пристигнува сега' : 'Пристигнува за ' + mins + ' мин'
        });

        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
          sent++;
          notifiedKeys.add(key);
          store.notified.push({ key: key, at: now });
        } catch (err) {
          // 404/410: the browser has unsubscribed or the subscription expired
          // upstream - stop trying this device, do not keep retrying forever.
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            dropSubscription = true;
          }
          // Any other failure (rate limit, transient network) leaves the
          // subscription in place - it is retried on the next run rather
          // than silently dropped for what may be a one-off hiccup.
        }
      }

      if (!dropSubscription) stillAlive.push(sub);
    }

    store.subscriptions = stillAlive;
    await writeStore(store, filename);

    res.status(200).json({ ok: true, subscriptions: store.subscriptions.length, sent: sent });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
