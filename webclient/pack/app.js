/*
 * Pick & Pack phone page (`/pack`) — the packing bench screens
 * (docs/PICK_AND_PACK_PLAN.md §3.2–3.3).
 *
 * Talks only to the server that served it (`location.origin`) with the account
 * token in localStorage. Pairing: a link ending `#t=<token>`; the token rides
 * in the fragment (never sent to the server) and is removed from the address
 * bar at once.
 *
 * No price is ever requested or rendered here: `pack:get` does not include the
 * order value, and the queue rows do not either.
 */
(function () {
  'use strict';
  var L = window.PackLogic;

  var READ_TIMEOUT_MS = 20000;
  var WRITE_TIMEOUT_MS = 120000;
  var PHOTO_MAX_PX = 1600;
  var PHOTO_QUALITY = 0.8;

  var baseUrl = window.location.origin;
  var token = '';
  try { token = window.localStorage.getItem(L.LS_TOKEN) || ''; } catch (_) { token = ''; }

  var S = {
    access: L.pageAccess([]),
    counters: { toPack: 0, packedToday: 0, withoutPhotos: 0 },
    tab: 'pack',
    orders: [],
    order: null,
    photoUrl: null,
    scanError: '',
    scanFlash: '',
  };
  var screen = { name: 'loading' };
  var view = document.getElementById('view');
  var titleEl = document.getElementById('barTitle');
  var backBtn = document.getElementById('backBtn');
  var toastEl = document.getElementById('toast');

  /* ── pairing token from the fragment ─────────────────────────── */
  (function readPairingToken() {
    var hash = window.location.hash || '';
    if (!/(?:^#|&)t=/.test(hash)) return;
    try {
      var t = L.tokenFromHash(hash);
      if (t) { token = t; window.localStorage.setItem(L.LS_TOKEN, t); }
    } finally {
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) { /* nothing else to try */ }
    }
  })();

  /* ── DOM + network ───────────────────────────────────────────── */
  function h(tag, props, children) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'text') el.textContent = props[k];
        else if (k === 'class') el.className = props[k];
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]);
        else if (props[k] != null) el.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  function request(path, opts, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    var o = Object.assign({}, opts || {});
    o.headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {});
    if (ctrl) o.signal = ctrl.signal;
    return fetch(baseUrl + path, o).then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        var body;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
        if (!res.ok) {
          var err = new Error((body && body.error) || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return body;
      });
    }).then(function (body) {
      return body;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    }).then(function (body) {
      if (body && body.status === 401) onTokenRejected();
      return body;
    }, function (err) {
      if (err && err.status === 401) onTokenRejected();
      throw err;
    });
  }

  function rpc(channel, args) {
    return request('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel, args: args === undefined ? null : args }),
    }, /^pack:(list|get)|^pack:getPhoto/.test(channel) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS)
      .then(function (b) { return b ? b.result : null; });
  }

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBlob(b64, mime) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'image/jpeg' });
  }

  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.className = 'toast is-on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 2600);
  }

  function onTokenRejected() {
    token = '';
    try { window.localStorage.removeItem(L.LS_TOKEN); } catch (_) { /* private mode */ }
    screen = { name: 'connect', message: 'This account cannot open the pack page. Ask an admin.' };
    render();
  }

  /* ── product photos (authenticated fetch → blob URL) ─────────── */
  var assetCache = {};
  function assetUrl(rel) {
    if (!rel) return Promise.resolve(null);
    if (assetCache[rel]) return assetCache[rel];
    var enc = String(rel).split('/').map(encodeURIComponent).join('/');
    var p = fetch(baseUrl + '/assets/' + enc + '?w=640', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        assetCache[rel] = Promise.resolve(url);
        return url;
      })
      .catch(function () { assetCache[rel] = Promise.resolve(null); return null; });
    assetCache[rel] = p;
    return p;
  }

  /* ── photos from the camera, shrunk on the phone ─────────────── */
  function shrinkPhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('Could not read that photo')); return; }
          blob.arrayBuffer().then(function (buf) { resolve({ blob: blob, buf: buf }); }, reject);
        }, 'image/jpeg', PHOTO_QUALITY);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not a photo')); };
      img.src = url;
    });
  }

  /* ── boot ────────────────────────────────────────────────────── */
  function boot() {
    if (!token) { screen = { name: 'connect' }; render(); return; }
    screen = { name: 'loading' };
    render();
    request('/api/whoami', {}, READ_TIMEOUT_MS).then(function (who) {
      var user = who && who.user;
      var access = L.pageAccess(user && user.caps);
      if (!user || !access.any) {
        screen = { name: 'connect', message: 'This account cannot open the pack page. Ask an admin.' };
        render();
        return null;
      }
      S.access = access;
      document.title = 'Pack · Media Studio KH';
      return loadQueue(S.tab).then(function () { screen = { name: 'queue' }; render(); });
    }).catch(function (err) {
      if (err && err.status === 401) return;
      screen = { name: 'error', message: err.message || 'Cannot reach the server' };
      render();
    });
  }

  function loadQueue(tab) {
    S.tab = tab || S.tab;
    return rpc('pack:list', { tab: S.tab }).then(function (res) {
      S.counters = res.counters || S.counters;
      S.orders = res.orders || [];
      return res;
    });
  }

  function openOrder(id) {
    return rpc('pack:get', id).then(function (res) {
      S.order = res;
      S.photoUrl = null;
      S.scanError = '';
      S.scanFlash = '';
      screen = { name: 'packing' };
      render();
    }).catch(function (err) { toast(err.message); });
  }

  /* ── packing actions ─────────────────────────────────────────── */
  function applyLine(line) {
    if (!S.order || !line) return;
    S.order.lines = S.order.lines.map(function (l) { return l.id === line.id ? line : l; });
  }

  function scan(code) {
    if (!S.order) return;
    var value = String(code || '').trim();
    if (!value) return;
    rpc('pack:scan', { orderId: S.order.order.id, code: value }).then(function (res) {
      if (!res || !res.matched) {
        S.scanError = 'Not in this order';
        S.scanFlash = '';
        render();
        return;
      }
      S.scanError = '';
      applyLine(res.line);
      S.scanFlash = res.already ? 'Already confirmed' : 'Confirmed ' + res.line.sku;
      render();
    }).catch(function (err) { toast(err.message); render(); });
  }

  function tapLine(line) {
    if (!S.order) return;
    rpc('pack:confirmLine', { orderId: S.order.order.id, lineId: line.id, delta: 1 }).then(function (res) {
      applyLine(res.line);
      S.scanError = '';
      S.scanFlash = '';
      render();
    }).catch(function (err) { toast(err.message); });
  }

  function addPhoto(file) {
    if (!S.order || !file) return;
    shrinkPhoto(file).then(function (p) {
      S.photoUrl = URL.createObjectURL(p.blob);
      return rpc('pack:addPhoto', {
        orderId: S.order.order.id,
        kind: 'sealed',
        bytes: { __bin: true, b64: bufToB64(p.buf) },
      });
    }).then(function (row) {
      S.order.photos = (S.order.photos || []).concat(row ? [row] : []);
      S.order.hasPhoto = true;
      toast('Photo saved');
      render();
    }).catch(function (err) { toast(err.message); render(); });
  }

  function seal() {
    if (!S.order) return;
    rpc('pack:seal', S.order.order.id).then(function () {
      S.order = null;
      S.photoUrl = null;
      toast('Parcel sealed');
      return loadQueue('pack');
    }).then(function () {
      var next = L.nextOrder(S.orders);
      if (next) return openOrder(next.id);
      screen = { name: 'queue' };
      render();
    }).catch(function (err) { toast(err.message); render(); });
  }

  /* ── rendering ───────────────────────────────────────────────── */
  function setTitle(text, back) {
    titleEl.textContent = text;
    backBtn.hidden = !back;
  }

  function mount(nodes) {
    view.textContent = '';
    nodes.forEach(function (n) { if (n) view.appendChild(n); });
    window.scrollTo(0, 0);
  }

  function render() {
    if (screen.name === 'connect') return renderConnect();
    if (screen.name === 'loading') { setTitle('Pack', false); mount([h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Loading' })]); return; }
    if (screen.name === 'error') return renderError();
    if (screen.name === 'packing') return renderPacking();
    return renderQueue();
  }

  function renderConnect() {
    setTitle('Pack', false);
    var input = h('input', { class: 'textin', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Account token' });
    mount([
      screen.message ? h('div', { class: 'notice notice--bad', text: screen.message }) : null,
      h('p', { text: 'Paste the account token from the Mac, or open the pairing link it shows.' }),
      input,
      h('button', {
        type: 'button', class: 'big', text: 'Open', onclick: function () {
          var t = input.value.trim();
          if (!t) return;
          token = t;
          try { window.localStorage.setItem(L.LS_TOKEN, t); } catch (_) { /* private mode */ }
          boot();
        },
      }),
    ]);
  }

  function renderError() {
    setTitle('Pack', false);
    mount([
      h('div', { class: 'notice notice--bad', text: screen.message || 'Cannot reach the server' }),
      h('button', { type: 'button', class: 'big', text: 'Try again', onclick: boot }),
    ]);
  }

  function tabButton(tab, label) {
    return h('button', {
      type: 'button', class: S.tab === tab ? 'is-on' : '', text: label,
      onclick: function () { loadQueue(tab).then(render).catch(function (err) { toast(err.message); }); },
    });
  }

  function renderQueue() {
    setTitle('Pack', false);
    var c = S.counters;
    var nodes = [
      h('div', { class: 'counters', text: c.toPack + ' to pack · ' + c.packedToday + ' packed today · ' + c.withoutPhotos + ' without photos' }),
      h('div', { class: 'tabs' }, [tabButton('pack', 'To pack'), tabButton('packed', 'Packed today'), tabButton('problems', 'Problems')]),
    ];
    if (!S.orders.length) {
      nodes.push(h('p', { class: 'muted', text: S.tab === 'pack' ? 'Nothing waiting. Good.' : 'Nothing here.' }));
    } else {
      nodes.push(h('div', { class: 'list' }, S.orders.map(function (o) {
        var sub = [o.itemCount + (o.itemCount === 1 ? ' item' : ' items'), o.source, o.externalRef || ''].filter(Boolean).join(' · ');
        return h('button', {
          type: 'button', class: 'card',
          onclick: S.tab === 'pack' ? function () { openOrder(o.id); } : null,
        }, [
          h('div', { class: 'card__t', text: o.customerName || o.externalRef || 'Order' }),
          h('div', { class: 'card__s', text: sub }),
          S.tab !== 'pack' && !o.photoCount ? h('span', { class: 'badge badge--bad', text: 'No photo' }) : null,
        ]);
      })));
    }
    nodes.push(h('button', {
      type: 'button', class: 'big big--soft', style: 'margin-top:16px', text: 'Refresh',
      onclick: function () { loadQueue(S.tab).then(render).catch(function (err) { toast(err.message); }); },
    }));
    mount(nodes);
  }

  function lineNode(line) {
    var done = L.lineDone(line);
    var node = h('div', {
      class: 'line' + (done ? ' is-done' : ''),
      role: 'button', tabindex: '0',
      onclick: function () { tapLine(line); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapLine(line); } },
    }, [
      h('div', {}, [line.imagePath
        ? h('img', { class: 'line__img', alt: '' })
        : h('div', { class: 'line__img line__img--empty', text: (line.sku || '?').slice(0, 2).toUpperCase() })]),
      h('div', {}, [
        h('div', { class: 'line__t', text: line.name || line.sku }),
        h('div', { class: 'line__s', text: line.sku }),
        h('div', { class: 'line__n', text: L.lineProgress(line) }),
      ]),
    ]);
    if (line.imagePath) {
      assetUrl(line.imagePath).then(function (url) {
        var img = node.querySelector('img');
        if (url && img) img.src = url;
      });
    }
    return node;
  }

  function renderPacking() {
    var o = S.order;
    if (!o || !o.order) { screen = { name: 'queue' }; return renderQueue(); }
    var order = o.order;
    setTitle(order.externalRef || 'Parcel', true);
    var allDone = o.lines.every(L.lineDone);
    var needsPhoto = o.photoRequired && !o.hasPhoto;
    var nodes = [
      h('h1', { text: order.customerName || 'Order ' + (order.externalRef || '') }),
      h('div', { class: 'muted', text: L.shortAddress(order.customerAddress) || order.customerPhone || '' }),
      h('div', { class: 'small muted', text: (order.externalRef || '') + (order.source ? ' · ' + order.source : '') }),
      h('div', { class: 'list', style: 'margin-top:12px' }, o.lines.map(lineNode)),
      h('input', {
        class: 'scan', id: 'scanInput', type: 'text', inputmode: 'numeric', autocomplete: 'off',
        autocapitalize: 'off', spellcheck: 'false', placeholder: 'Scan barcode or type SKU',
        onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); scan(e.target.value); } },
      }),
      S.scanError ? h('div', { class: 'notice notice--bad', text: S.scanError }) : null,
      !S.scanError && S.scanFlash ? h('div', { class: 'notice notice--ok', text: S.scanFlash }) : null,
      S.photoUrl ? h('img', { class: 'photo-preview', src: S.photoUrl, alt: 'Parcel photo' }) : null,
      h('div', { class: 'notice ' + (needsPhoto ? 'notice--warn' : 'notice--ok') }, [
        h('b', { text: needsPhoto ? 'Photo required' : 'Photo saved' }),
        h('span', { text: needsPhoto ? 'Take one photo of the sealed parcel with the label readable.' : (o.photoRequired ? 'You can retake it before sealing.' : 'This order is below the photo threshold, so a photo is optional.') }),
      ]),
      h('div', { class: 'photo-slot' }, [
        h('button', { type: 'button', class: 'big big--soft', text: o.hasPhoto ? 'Retake photo' : 'Take parcel photo' }),
        h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Parcel photo', onchange: function (e) { var f = e.target.files && e.target.files[0]; if (f) addPhoto(f); } }),
      ]),
      h('button', {
        type: 'button', class: 'big', style: 'margin-top:12px', text: 'Seal & finish',
        disabled: needsPhoto || !allDone ? 'disabled' : null,
        onclick: seal,
      }),
      !allDone ? h('p', { class: 'small muted', text: 'Confirm every item first — scan it or tap the line.' }) : null,
    ];
    mount(nodes);
    var input = document.getElementById('scanInput');
    if (input) input.focus();
  }

  backBtn.addEventListener('click', function () {
    if (screen.name === 'packing') {
      S.order = null;
      S.photoUrl = null;
      loadQueue('pack').then(function () { screen = { name: 'queue' }; render(); }).catch(function () { screen = { name: 'queue' }; render(); });
      return;
    }
    boot();
  });

  boot();
})();
