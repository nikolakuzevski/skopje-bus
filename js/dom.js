/* dom.js — tiny DOM, geo and formatting helpers. Loaded first. */
(function () {
  const SB = (window.SB = window.SB || {});

  /** el('div', {class:'x', onclick:fn}, ['text', childNode]) */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key in props) {
        const val = props[key];
        if (val === null || val === undefined || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        // For small trusted markup only (e.g. an inline icon's own <svg>),
        // never for any string built from upstream API data.
        else if (key === 'html') node.innerHTML = val;
        else if (key === 'dataset') Object.assign(node.dataset, val);
        else if (key === 'style') Object.assign(node.style, val);
        else if (key.startsWith('on') && typeof val === 'function') {
          node.addEventListener(key.slice(2), val);
        } else if (key in node && key !== 'list') {
          node[key] = val;
        } else {
          node.setAttribute(key, val);
        }
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child === null || child === undefined || child === false) return;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      });
    }
    return node;
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  let toastTimer = null;
  function toast(message, isError) {
    const box = qs('#toast');
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('err', !!isError);
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('show'); }, isError ? 5200 : 2600);
  }

  /* Native confirm() is a silent no-op inside an installed PWA on Android —
   * this bit the daily-planner app in production. Never use it here. */
  function confirmBox(message, opts) {
    const o = opts || {};
    return new Promise(function (resolve) {
      const done = function (v) { overlay.remove(); resolve(v); };
      const overlay = el('div', { class: 'modal-overlay', onclick: function (e) {
        if (e.target === overlay) done(false);
      } }, [
        el('div', { class: 'modal' }, [
          el('p', { class: 'modal-msg', text: message }),
          el('div', { class: 'modal-actions' }, [
            el('button', { class: 'btn', type: 'button', onclick: function () { done(false); } },
              o.cancelText || 'Откажи'),
            el('button', { class: 'btn btn-danger', type: 'button', onclick: function () { done(true); } },
              o.okText || 'Потврди')
          ])
        ])
      ]);
      document.body.appendChild(overlay);
    });
  }

  /* ---------------- geo ---------------- */

  const R = 6371000;
  function toRad(d) { return d * Math.PI / 180; }

  /** Great-circle distance in metres. */
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ---------------- formatting (Macedonian) ---------------- */

  function fmtMinutes(seconds) {
    const m = Math.round(seconds / 60);
    if (m <= 0) return 'сега';
    return m + ' мин';
  }

  function fmtClock(msEpoch) {
    if (!msEpoch) return '';
    const d = new Date(msEpoch);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtAge(seconds) {
    if (seconds < 60) return Math.round(seconds) + ' сек';
    const m = Math.round(seconds / 60);
    if (m < 60) return m + ' мин';
    return Math.round(m / 60) + ' ч';
  }

  function fmtDistance(metres) {
    if (metres < 1000) return Math.round(metres) + ' м';
    return (metres / 1000).toFixed(1) + ' км';
  }

  SB.dom = {
    el: el, qs: qs, clear: clear, toast: toast, confirm: confirmBox,
    haversine: haversine,
    fmtMinutes: fmtMinutes, fmtClock: fmtClock, fmtAge: fmtAge, fmtDistance: fmtDistance
  };
})();
