/* api/subscribe.js — POST to subscribe this device+stop, DELETE to remove it.
 *
 * One subscription = one browser's PushSubscription + the stopId it wants
 * notified about. Keyed on `endpoint` (unique per browser+device by the push
 * service itself), so re-subscribing to a different stop from the same
 * device replaces the old row rather than accumulating duplicates.
 */

const { readStore, writeStore } = require('./_lib/gist');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const body = req.body || {};
  const subscription = body.subscription;
  const stopId = body.stopId;

  if (req.method === 'POST' && (!subscription || !subscription.endpoint || !subscription.keys || stopId == null)) {
    res.status(400).json({ error: 'missing subscription or stopId' });
    return;
  }
  if (req.method === 'DELETE' && (!subscription || !subscription.endpoint)) {
    res.status(400).json({ error: 'missing subscription' });
    return;
  }

  try {
    const { store, filename } = await readStore();
    store.subscriptions = store.subscriptions.filter(function (s) { return s.endpoint !== subscription.endpoint; });

    if (req.method === 'POST') {
      store.subscriptions.push({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        stopId: Number(stopId),
        createdAt: Date.now()
      });
    }

    await writeStore(store, filename);
    res.status(200).json({ ok: true, subscribed: req.method === 'POST' });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
