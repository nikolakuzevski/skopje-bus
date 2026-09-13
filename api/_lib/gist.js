/* _lib/gist.js — the subscription store.
 *
 * A single private GitHub Gist holds every push subscription and the recent
 * notification dedupe log. This is a personal app with a handful of
 * subscribed devices, not a product with many users, so a real database
 * would be more infrastructure than the data justifies - the gist is read
 * and rewritten whole on every call, which is fine at this scale and would
 * not be at a larger one.
 *
 * Prefixed with `_` (and nested under `_lib/`) so Vercel does not turn this
 * file into its own HTTP route the way it does every other file in `api/`.
 */

const GITHUB_API = 'https://api.github.com';

function authHeaders() {
  return {
    Authorization: 'Bearer ' + process.env.GIST_TOKEN,
    'User-Agent': 'skopje-bus',
    Accept: 'application/vnd.github+json'
  };
}

/** Reads the gist and parses its one JSON file. Returns {store, filename}. */
async function readStore() {
  const res = await fetch(GITHUB_API + '/gists/' + process.env.GIST_ID, {
    headers: authHeaders()
  });
  if (!res.ok) throw new Error('gist read failed: HTTP ' + res.status);
  const gist = await res.json();
  const filename = Object.keys(gist.files)[0];
  if (!filename) throw new Error('gist has no files');
  const file = gist.files[filename];
  // A gist file over ~1MB comes back truncated with `truncated: true` and a
  // separate raw_url - this store should never get anywhere near that size
  // for a personal app, but failing loudly here beats silently parsing a
  // half-written JSON blob if it ever did.
  if (file.truncated) throw new Error('gist file truncated - store has grown too large');
  let store;
  try {
    store = JSON.parse(file.content || '{}');
  } catch (err) {
    throw new Error('gist file is not valid JSON: ' + err.message);
  }
  store.subscriptions = Array.isArray(store.subscriptions) ? store.subscriptions : [];
  store.notified = Array.isArray(store.notified) ? store.notified : [];
  return { store: store, filename: filename };
}

/** Overwrites the gist's one file with `store`, serialised. */
async function writeStore(store, filename) {
  const res = await fetch(GITHUB_API + '/gists/' + process.env.GIST_ID, {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(store) } } })
  });
  if (!res.ok) throw new Error('gist write failed: HTTP ' + res.status);
}

module.exports = { readStore: readStore, writeStore: writeStore };
