/* push.js — "notify me" for one stop, backed by real Web Push.
 *
 * Deliberately single-stop: a browser holds at most one PushSubscription at
 * a time, so this app does not pretend to watch several stops per device.
 * Switching which stop is watched replaces the old subscription, both in the
 * browser and on the server (js/store.js's `notifyStopId` mirrors whichever
 * stop the server actually has on file, so the bell button's state survives
 * a reload without an extra round trip on every render).
 *
 * The server side (api/subscribe.js, api/check.js) is the only place this
 * app has ever needed a backend: the countdown/label work in eta.js and
 * timetable.js only matters while the app is open and the screen is on -
 * mobile browsers suspend a backgrounded tab's JS almost immediately, so a
 * notification computed client-side could never fire with the phone locked.
 * A cron-triggered server check is the only way to notify "for real."
 */
(function () {
  const SB = (window.SB = window.SB || {});

  // Public by design - the counterpart to VAPID_PRIVATE_KEY, which never
  // leaves the server. Baking the public half into the client is normal for
  // Web Push, the same way a Stripe publishable key is meant to be public.
  const VAPID_PUBLIC_KEY = 'BFgj9NCXweDUatelfgelb9yg6939jhR20uy72LiEMy3u8OxF5p7iSOsfDAHlVcNzdfKOpQ67JmTwCw-1O86tmS4';

  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function urlBase64ToUint8Array(base64url) {
    const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function postSubscription(method, subscription, stopId) {
    return fetch('/api/subscribe', {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON(), stopId: stopId })
    }).then(function (res) {
      if (!res.ok) throw new Error('server rejected subscription: HTTP ' + res.status);
      return res.json();
    });
  }

  /** Subscribe this device to notifications for `stopId`, replacing any
   * earlier stop this device was watching. */
  function subscribeToStop(stopId) {
    if (!supported()) return Promise.reject(new Error('Известувањата не се поддржани во овој прелистувач.'));

    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('Дозволата за известувања е одбиена.');
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      });
    }).then(function (subscription) {
      return postSubscription('POST', subscription, stopId).then(function () {
        SB.store.setNotifyStopId(stopId);
        return subscription;
      });
    });
  }

  /** Fully unsubscribe this device - both the server record and the
   * browser-level PushSubscription, so a stale one is never left behind. */
  function unsubscribe() {
    if (!supported()) return Promise.resolve();
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (subscription) {
      if (!subscription) { SB.store.setNotifyStopId(null); return; }
      return postSubscription('DELETE', subscription, null)
        .catch(function () { /* still unsubscribe locally even if the server call failed */ })
        .then(function () { return subscription.unsubscribe(); })
        .then(function () { SB.store.setNotifyStopId(null); });
    });
  }

  SB.push = {
    supported: supported,
    subscribeToStop: subscribeToStop,
    unsubscribe: unsubscribe,
    /** The stop this device is currently believed to be subscribed for, or
     * null. Read from local storage, not the server - good enough for
     * painting a button's state without a network round trip on every
     * render; api calls are the source of truth for whether it actually
     * worked. */
    currentStopId: function () { return SB.store.notifyStopId(); }
  };
})();
