/* ui-pick.js — choosing a stop: nearest, saved, or by name.
 * Accepts Latin typing ("centar") as well as Cyrillic, because the phone
 * keyboard is usually in the wrong alphabet at exactly the wrong moment. */
(function () {
  const SB = (window.SB = window.SB || {});
  const el = SB.dom.el;

  const MAX_RESULTS = 40;

  // Multi-letter sequences first so "sh" beats "s" + "h".
  const LATIN = [
    ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['dz', 'ѕ'], ['dj', 'ѓ'], ['gj', 'ѓ'],
    ['kj', 'ќ'], ['lj', 'љ'], ['nj', 'њ'], ['ts', 'ц'], ['c', 'ц'], ['a', 'а'],
    ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['z', 'з'],
    ['i', 'и'], ['j', 'ј'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'],
    ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
    ['f', 'ф'], ['h', 'х'], ['x', 'х'], ['w', 'в'], ['y', 'и'], ['q', 'к']
  ];

  function toCyrillic(s) {
    let out = '';
    let i = 0;
    while (i < s.length) {
      let matched = false;
      for (let k = 0; k < LATIN.length; k++) {
        const pair = LATIN[k];
        if (s.startsWith(pair[0], i)) {
          out += pair[1];
          i += pair[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) { out += s[i]; i += 1; }
    }
    return out;
  }

  function resultRow(stop, metaText) {
    return el('button', {
      class: 'result', type: 'button',
      onclick: function () {
        SB.uiStop.setStop(stop.id);
        SB.app.showTab('stop');
      }
    }, [
      el('span', { class: 'result-name', text: stop.name }),
      el('span', { class: 'result-meta', text: metaText })
    ]);
  }

  function linesAt(stop) {
    const names = [];
    stop.patterns.forEach(function (p) {
      const n = SB.net.routeName(p.routeId);
      if (names.indexOf(n) === -1) names.push(n);
    });
    names.sort(function (a, b) {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return String(a).localeCompare(String(b));
    });
    return names.join(', ');
  }

  function metaFor(stop) {
    const bits = [];
    if (stop.code) bits.push('бр. ' + stop.code);
    const pos = SB.app.lastPosition();
    if (pos) bits.push(SB.dom.fmtDistance(SB.dom.haversine(pos.lat, pos.lon, stop.lat, stop.lon)));
    const lines = linesAt(stop);
    if (lines) bits.push(lines);
    return bits.join(' · ');
  }

  function render() {
    const host = SB.dom.qs('#pick-results');
    if (!host) return;
    SB.dom.clear(host);

    if (!SB.net.isLoaded()) {
      host.appendChild(el('p', { class: 'empty', text: 'Се вчитуваат постојките.' }));
      return;
    }

    const input = SB.dom.qs('#pick-search');
    const raw = (input ? input.value : '').trim().toLowerCase();

    if (!raw) {
      const favs = SB.store.favourites()
        .map(function (id) { return SB.net.stopById.get(id); })
        .filter(Boolean);
      if (favs.length) {
        host.appendChild(el('p', { class: 'empty', text: 'Зачувани постојки' }));
        favs.forEach(function (s) { host.appendChild(resultRow(s, metaFor(s))); });
      } else {
        host.appendChild(el('p', {
          class: 'empty',
          text: 'Напишете име или број на постојка, или користете „Најблиска до мене“.'
        }));
      }
      return;
    }

    const needle = toCyrillic(raw);
    const matches = [];
    for (let i = 0; i < SB.net.stops.length; i++) {
      const s = SB.net.stops[i];
      const name = s.name.toLowerCase();
      if (name.indexOf(needle) !== -1 || name.indexOf(raw) !== -1 || String(s.code) === raw) {
        matches.push(s);
      }
    }

    // Typing "22" almost always means the line, not a stop whose code happens
    // to be 22, so stops on a line of that name are offered as a second group.
    const lineIds = SB.net.routes.filter(function (r) {
      const n = String(r.shortName || '').toLowerCase();
      return n === raw || n === needle;
    }).map(function (r) { return r.id; });

    const seen = new Set(matches.map(function (s) { return s.id; }));
    const onLine = [];
    if (lineIds.length) {
      SB.net.stops.forEach(function (s) {
        if (seen.has(s.id)) return;
        if (s.patterns.some(function (p) { return lineIds.indexOf(p.routeId) !== -1; })) onLine.push(s);
      });
    }

    const pos = SB.app.lastPosition();
    const byDistance = function (a, b) {
      return SB.dom.haversine(pos.lat, pos.lon, a.lat, a.lon) -
             SB.dom.haversine(pos.lat, pos.lon, b.lat, b.lon);
    };
    if (pos) { matches.sort(byDistance); onLine.sort(byDistance); }

    if (!matches.length && !onLine.length) {
      host.appendChild(el('p', { class: 'empty', text: 'Нема постојка со тоа име.' }));
      return;
    }

    matches.slice(0, MAX_RESULTS).forEach(function (s) {
      host.appendChild(resultRow(s, metaFor(s)));
    });

    if (onLine.length) {
      host.appendChild(el('p', { class: 'empty', text: 'Постојки на линија ' + raw }));
      onLine.slice(0, MAX_RESULTS).forEach(function (s) {
        host.appendChild(resultRow(s, metaFor(s)));
      });
    }
  }

  function mount() {
    const input = SB.dom.qs('#pick-search');
    if (input && !input.dataset.bound) {
      input.dataset.bound = '1';
      input.addEventListener('input', render);
    }
    const near = SB.dom.qs('#pick-nearest');
    if (near && !near.dataset.bound) {
      near.dataset.bound = '1';
      near.addEventListener('click', function () {
        near.disabled = true;
        SB.app.locate(true)
          .then(function (stop) {
            if (!stop) { SB.dom.toast('Нема постојка во близина.', true); return; }
            SB.uiStop.setStop(stop.id);
            SB.app.showTab('stop');
          })
          .catch(function (err) { SB.dom.toast(err.message, true); })
          .then(function () { near.disabled = false; });
      });
    }
    render();
  }

  SB.uiPick = { mount: mount, render: render, toCyrillic: toCyrillic };
})();
