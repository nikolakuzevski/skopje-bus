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

  /* One place for every small icon used as a button, rather than the same SVG
   * string duplicated across ui-stop.js/ui-detail.js/index.html. currentColor
   * throughout so CSS controls the actual colour per button state. */
  const ICONS = {
    refresh: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
      '<path fill="currentColor" d="M8 2.5a5.5 5.5 0 1 0 5.163 3.6.75.75 0 0 1 1.406-.53A7 7 0 1 1 8 1v-.9a.35.35 0 0 1 .57-.27l2.4 1.9a.35.35 0 0 1 0 .55l-2.4 1.9A.35.35 0 0 1 8 3.9V2.5Z"/></svg>',
    heart: '<svg viewBox="0 0 20 18" width="19" height="17" aria-hidden="true">' +
      '<path fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" ' +
      'd="M10 17.3 2.6 10.2C.6 8.3.6 5.2 2.6 3.4c1.9-1.7 4.8-1.5 6.5.4L10 4.9l.9-1.1c1.7-1.9 4.6-2.1 6.5-.4 2 1.8 2 4.9 0 6.8L10 17.3Z"/></svg>',
    back: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'd="M12.5 4.5 6 10l6.5 5.5"/></svg>',
    settings: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">' +
      '<line x1="3" y1="5" x2="17" y2="5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '<line x1="3" y1="10" x2="17" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '<line x1="3" y1="15" x2="17" y2="15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '<circle cx="8" cy="5" r="2.2" fill="currentColor"/><circle cx="13" cy="10" r="2.2" fill="currentColor"/>' +
      '<circle cx="9" cy="15" r="2.2" fill="currentColor"/></svg>',
    bell: '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" fill-opacity="0" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" ' +
      'd="M10 2.8c-2.3 0-4 1.9-4 4.4v2.3c0 1-.4 2-1.1 2.7l-.6.6h11.4l-.6-.6a3.8 3.8 0 0 1-1.1-2.7V7.2c0-2.5-1.7-4.4-4-4.4Z"/>' +
      '<path fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8.3 15.2a1.9 1.9 0 0 0 3.4 0"/></svg>'
  };
  function icon(name, extraClass) {
    return el('span', { class: 'icon' + (extraClass ? ' ' + extraClass : ''), html: ICONS[name] || '' });
  }

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
    el: el, qs: qs, clear: clear, toast: toast, confirm: confirmBox, icon: icon,
    haversine: haversine,
    fmtMinutes: fmtMinutes, fmtClock: fmtClock, fmtAge: fmtAge, fmtDistance: fmtDistance
  };
})();
