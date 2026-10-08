/*
 * Fuel phone page (`/f`) — the screens (docs/PEOPLE_AND_FUEL_PLAN.md §5.3).
 *
 * Talks only to the server that served it (`location.origin`), with the
 * account token kept in localStorage. Pairing: the Mac's QR code opens
 * `/f#t=<token>`; the token rides in the FRAGMENT (never sent to the server)
 * and is removed from the address bar at once.
 *
 * Plain HTTP over Tailscale (AGENTS.md §25.4): no navigator.share, no
 * crypto.randomUUID, no geolocation. Photos come from
 * <input type=file accept=image/* capture=environment>, are shrunk on the
 * phone to 1600 px JPEG, and travel inside the record's own save call.
 * Every save goes through the outbox in logic.js (IndexedDB), so a dropped
 * connection keeps the record and sends it later with the same client_ref.
 */
(function () {
  'use strict';
  var L = window.FuelLogic;
  var LS = {
    tok: 'mskh.fuel.token', lang: 'mskh.fuel.lang', device: 'mskh.fuel.device',
    tank: 'mskh.fuel.lastTank', vehicle: 'mskh.fuel.lastVehicle', currency: 'mskh.fuel.currency',
  };
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) {
    try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, String(v)); } catch (_) { /* private mode: not remembered */ }
  }

  var READ_TIMEOUT_MS = 20000;
  var WRITE_TIMEOUT_MS = 120000;
  var PHOTO_MAX_PX = 1600;
  var PHOTO_QUALITY = 0.8;
  var TZ = 'Asia/Phnom_Penh';

  var baseUrl = window.location.origin;
  var token = lsGet(LS.tok) || '';
  var lang = L.pickLang(lsGet(LS.lang));
  var device = lsGet(LS.device);
  if (!device) { device = L.deviceId(); lsSet(LS.device, device); }

  var S = {
    user: null, companies: [], companyId: null, settings: {}, assets: [], locations: [], staff: [], stations: [], me: null,
    items: [], online: true, storageOk: true, chartCache: {},
  };
  var screen = { name: 'loading' };
  var view = document.getElementById('view');
  var titleEl = document.getElementById('barTitle');
  var backBtn = document.getElementById('backBtn');
  var langBtn = document.getElementById('langBtn');
  var chip = document.getElementById('outboxChip');

  function tr(k, v) { return L.t(lang, k, v); }

  /* ── pairing token from the fragment ─────────────────────────── */
  (function readPairingToken() {
    var hash = window.location.hash || '';
    if (!/(?:^#|&)t=/.test(hash)) return;
    try {
      var t = L.tokenFromHash(hash);
      if (t) { token = t; lsSet(LS.tok, t); }
    } finally {
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) { /* nothing else to try */ }
    }
  })();

  /* ── network ───────────────────────────────────────────────────── */
  function netError(cause, timedOut) {
    var err = new Error(tr('cant_reach'));
    err.network = true;
    if (timedOut) err.timedOut = true;
    err.cause = cause;
    return err;
  }

  function isRead(channel) {
    return /^(get|list|me)([A-Z]|$)/.test(String(channel).split(':')[1] || '');
  }

  function request(path, opts, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false;
    var timer = ctrl ? setTimeout(function () { timedOut = true; ctrl.abort(); }, ms) : null;
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
      }, function (e) { clearTimeout(timer); throw netError(e, timedOut); });
    }, function (e) {
      clearTimeout(timer);
      throw netError(e, timedOut);
    }).then(function (body) {
      setOnline(true);
      return body;
    }, function (err) {
      if (err.network) setOnline(false);
      if (err.status === 401) onTokenRejected();
      throw err;
    });
  }

  function rpc(channel, args) {
    return request('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel, args: args === undefined ? null : args }),
    }, isRead(channel) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS).then(function (b) { return b ? b.result : null; });
  }

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function encodePhoto(buf) { return { __bin: true, b64: bufToB64(buf) }; }
  function b64ToBlob(b64, mime) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'image/jpeg' });
  }

  function setOnline(on) {
    if (S.online === on) return;
    S.online = on;
    renderChip();
  }

  /* ── outbox storage: IndexedDB, or memory with a warning ───────── */
  function openIdbStore() {
    return new Promise(function (resolve) {
      var req;
      try { req = window.indexedDB && window.indexedDB.open('mskh-fuel', 1); } catch (_) { req = null; }
      if (!req) { resolve(null); return; }
      req.onupgradeneeded = function () { req.result.createObjectStore('outbox', { keyPath: 'clientRef' }); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
      req.onsuccess = function () {
        var db = req.result;
        function run(mode, fn) {
          return new Promise(function (res, rej) {
            var tx;
            try { tx = db.transaction('outbox', mode); } catch (e) { rej(e); return; }
            var out;
            var r = fn(tx.objectStore('outbox'));
            if (r) r.onsuccess = function () { out = r.result; };
            tx.oncomplete = function () { res(out); };
            tx.onerror = function () { rej(tx.error); };
            tx.onabort = function () { rej(tx.error || new Error('aborted')); };
          });
        }
        resolve({
          all: function () { return run('readonly', function (st) { return st.getAll(); }).then(function (x) { return x || []; }); },
          put: function (item) { return run('readwrite', function (st) { return st.put(item); }); },
          remove: function (ref) { return run('readwrite', function (st) { return st.delete(ref); }); },
        });
      };
    });
  }

  var outbox = null;
  var wakeTimer = null;
  function outboxCtx() { return { userId: S.user && S.user.id, companyId: S.companyId, now: Date.now() }; }

  function refreshItems() {
    if (!outbox) return Promise.resolve();
    return outbox.list().then(function (items) {
      S.items = items || [];
      renderChip();
      if (screen.name === 'outbox') render();
    });
  }

  function scheduleWake() {
    clearTimeout(wakeTimer);
    if (!outbox) return;
    outbox.nextWake().then(function (ms) {
      if (ms == null) return;
      wakeTimer = setTimeout(kick, Math.max(1000, ms));
    });
  }

  function kick() {
    if (!outbox || !S.user || !S.companyId) return Promise.resolve();
    return outbox.flush().catch(function () { /* each item keeps its own error */ }).then(scheduleWake);
  }

  /* ── tiny DOM helper ───────────────────────────────────────────── */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function svg(path) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    path.split('|').forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }
  var ICON = {
    pump: 'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16|M3 21h12|M7 8h4|M14 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8l-3-3',
    dip: 'M12 2v20|M8 6h4|M8 10h4|M8 14h4|M8 18h4|M16 12l3 3-3 3',
    truck: 'M3 6h11v10H3z|M14 10h4l3 3v3h-7|M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z|M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    send: 'M4 12h13|M13 6l6 6-6 6',
    recv: 'M20 12H7|M11 6l-6 6 6 6',
    cash: 'M3 7h18v10H3z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4z|M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    list: 'M8 6h12|M8 12h12|M8 18h12|M4 6h.01|M4 12h.01|M4 18h.01',
  };

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 3000);
  }

  function fmtTime(ms) {
    if (!ms) return '';
    try {
      return new Intl.DateTimeFormat(lang === 'km' ? 'km-KH' : 'en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    } catch (_) {
      return new Date(ms).toLocaleString();
    }
  }
  function num(n, d) { return L.formatNumber(n, d == null ? 2 : d); }
  function litresText(n) { return n == null ? '—' : num(n, 2) + ' ' + tr('unit_l'); }

  /* ── names ─────────────────────────────────────────────────────── */
  function byId(list, id) { for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i]; return null; }
  function staffName(e) { return e ? (lang === 'km' ? (e.nameKm || e.nameEn) : (e.nameEn || e.nameKm)) || e.staffCode : ''; }
  function assetName(a) { return a ? a.name + (a.plateOrSerial ? ' · ' + a.plateOrSerial : '') : ''; }
  function locName(id) { var l = byId(S.locations, id); return l ? l.name : ''; }
  function initials(text) { return String(text || '?').trim().slice(0, 2).toUpperCase(); }

  /* ── tile photos (thumbnails, cached for the page's life) ───────── */
  var photoCache = {};
  var photoQueue = [];
  var photoActive = 0;
  function tilePhoto(box, ref) {
    if (!ref) return;
    var key = ref.kind + ':' + ref.key;
    var hit = photoCache[key];
    function show(url) { if (url) { box.textContent = ''; box.appendChild(h('img', { src: url, alt: '' })); } }
    if (hit && hit.url) { show(hit.url); return; }
    if (hit && hit.failed) return;
    if (hit && hit.waiters) { hit.waiters.push(show); return; }
    photoCache[key] = { waiters: [show] };
    photoQueue.push({ key: key, ref: ref });
    pumpPhotos();
  }
  function pumpPhotos() {
    while (photoActive < 3 && photoQueue.length) {
      var job = photoQueue.shift();
      photoActive += 1;
      (function (job) {
        var call = job.ref.kind === 'staff'
          ? rpc('staff:getPhoto', { id: job.ref.id, thumb: true })
          : rpc('fuel:getPhoto', { photoId: job.ref.id, thumb: true });
        call.then(function (r) {
          var entry = photoCache[job.key];
          if (!r || !r.bytes || !r.bytes.b64) { photoCache[job.key] = { failed: true }; return; }
          var url = URL.createObjectURL(b64ToBlob(r.bytes.b64, r.mime));
          photoCache[job.key] = { url: url };
          (entry.waiters || []).forEach(function (fn) { fn(url); });
        }, function () { photoCache[job.key] = { failed: true }; }).then(function () {
          photoActive -= 1;
          pumpPhotos();
        });
      })(job);
    }
  }

  /* ── photos from the camera, shrunk on the phone ───────────────── */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  /* An <img> applies the photo's EXIF rotation itself in every current mobile
     browser, so drawing it gives the picture the right way up. */
  function shrinkPhoto(file) {
    return loadImage(file).then(function (o) {
      var size = L.fitWithin(o.img.naturalWidth, o.img.naturalHeight, PHOTO_MAX_PX);
      var canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext('2d').drawImage(o.img, 0, 0, size.width, size.height);
      URL.revokeObjectURL(o.url);
      return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY); });
    }).then(function (blob) {
      var src = blob || file;
      if (!src || !src.size) throw new Error('empty');
      return src.arrayBuffer ? src.arrayBuffer().then(function (buf) { return { blob: src, buf: buf }; })
        : new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res({ blob: src, buf: fr.result }); };
          fr.onerror = function () { rej(fr.error); };
          fr.readAsArrayBuffer(src);
        });
    });
  }

  /* ── the flows ─────────────────────────────────────────────────── */
  function activeStaff(pred) {
    return S.staff.filter(function (e) { return e.status === 'active' && (!pred || pred(e)); });
  }
  function assetTiles(preferId) {
    var list = S.assets.filter(function (a) { return a.status === 'active'; }).slice();
    list.sort(function (a, b) {
      if (a.id === preferId) return -1;
      if (b.id === preferId) return 1;
      return a.name.localeCompare(b.name);
    });
    return list.map(function (a) {
      return { id: a.id, title: a.name, sub: [a.plateOrSerial, a.typeName].filter(Boolean).join(' · '), photo: a.photoId ? { kind: 'asset', id: a.photoId, key: a.photoId } : null };
    });
  }
  function staffTiles(list) {
    return list.map(function (e) {
      return { id: e.id, title: staffName(e), sub: e.position || e.staffCode, photo: e.hasPhoto ? { kind: 'staff', id: e.id, key: e.id + ':' + (e.photoSha256 || '') } : null };
    });
  }
  function locTiles(kinds) {
    return S.locations.filter(function (l) { return l.status !== 'retired' && kinds.indexOf(l.kind) !== -1; }).map(function (l) {
      return { id: l.id, title: l.name, sub: l.capacityL ? num(l.capacityL, 0) + ' ' + tr('unit_l') : '' };
    });
  }
  function assetOf(d) { return byId(S.assets, d.assetId); }
  function meterUnit(d) { var a = assetOf(d); return a ? a.meterUnit : 'none'; }
  function hasMeter(d) { var u = meterUnit(d); return u === 'km' || u === 'hours'; }
  function canSize() { return Number(S.settings.canSizeL) || 20; }
  function flowMeterFrom(id) { var l = byId(S.locations, id); return !!(l && l.hasFlowMeter); }

  /** Litres from what was entered: pump meter, else typed, else cans. */
  function litresOf(d, meterOn) {
    if (meterOn) return L.litresFromMeter(d.pumpMeterBefore, d.pumpMeterAfter).litres;
    if (d.how === 'cans') return L.litresFromCans(d.cansCount, canSize());
    return d.litres == null ? null : d.litres;
  }

  // Shared step groups.
  function pumpMeterSteps(fromKey) {
    function on(d) { return flowMeterFrom(d[fromKey]); }
    return [
      { type: 'photo', kind: 'pump_meter_before', title: 'photo_pump_before', when: on },
      { type: 'number', key: 'pumpMeterBefore', title: 'pump_before', unit: 'unit_l', decimals: 2, when: on },
      { type: 'photo', kind: 'pump_meter_after', title: 'photo_pump_after', when: on },
      {
        type: 'number', key: 'pumpMeterAfter', title: 'pump_after', unit: 'unit_l', decimals: 2, when: on,
        live: function (d, v) {
          var m = L.litresFromMeter(d.pumpMeterBefore, v);
          if (m.backwards) return { text: tr('pump_backwards'), warn: true };
          return m.litres != null ? { text: tr('pump_litres', { litres: num(m.litres) }) } : null;
        },
        valid: function (d, v) { var m = L.litresFromMeter(d.pumpMeterBefore, v); return m.litres > 0; },
      },
      {
        type: 'choice', key: 'how', title: 'how_much', when: function (d) { return !on(d); },
        options: function () { return [{ value: 'litres', label: tr('by_litres') }, { value: 'cans', label: tr('by_cans', { size: num(canSize()) }) }]; },
      },
      { type: 'number', key: 'litres', title: 'litres', unit: 'unit_l', decimals: 2, when: function (d) { return !on(d) && d.how === 'litres'; }, valid: function (d, v) { return v > 0; } },
      { type: 'cans', key: 'cansCount', title: 'cans_count', when: function (d) { return !on(d) && d.how === 'cans'; } },
    ];
  }

  var FLOWS = {
    give: {
      title: 'home_give', icon: 'pump',
      available: function () { return S.assets.length && locTiles(['tank', 'farm_store']).length; },
      steps: [
        { type: 'tiles', key: 'locationId', title: 'pick_tank', autoSingle: true, remember: LS.tank, items: function () { return locTiles(['tank', 'farm_store']); } },
        { type: 'tiles', key: 'assetId', title: 'pick_vehicle', search: true, items: function () { return assetTiles(null); } },
        {
          type: 'tiles', key: 'driverEmployeeId', title: 'pick_driver', search: true, none: 'no_driver',
          when: function () { return activeStaff().length > 0; },
          preset: function (d) { var a = assetOf(d); return a && a.assignedEmployeeId; },
          items: function (d) {
            var a = assetOf(d);
            var drivers = activeStaff(function (e) { return e.isDriver; });
            var list = drivers.length ? drivers : activeStaff();
            list = list.slice().sort(function (x, y) { return (y.id === (a && a.assignedEmployeeId)) - (x.id === (a && a.assignedEmployeeId)); });
            return staffTiles(list);
          },
        },
        { type: 'photo', kind: 'meter', title: function (d) { return meterUnit(d) === 'hours' ? 'photo_meter_hours' : 'photo_meter_km'; }, when: hasMeter },
        { type: 'number', key: 'meterReading', title: function (d) { return meterUnit(d) === 'hours' ? 'reading_hours' : 'reading_km'; }, unit: function (d) { return meterUnit(d) === 'hours' ? 'unit_hours' : 'unit_km'; }, decimals: 1, optional: true, when: hasMeter },
      ].concat(pumpMeterSteps('locationId'), [
        { type: 'photo', kind: 'fill', title: 'photo_fill' },
        { type: 'choice', key: 'fullTank', title: 'full_tank_q', options: yesNo },
        { type: 'review' },
      ]),
      build: function (d) {
        var loc = byId(S.locations, d.locationId);
        var meterOn = flowMeterFrom(d.locationId);
        var args = { kind: loc && loc.kind === 'farm_store' ? 'farm_store' : 'warehouse_tank', locationId: d.locationId, assetId: d.assetId, fullTank: d.fullTank === true };
        if (d.driverEmployeeId) args.driverEmployeeId = d.driverEmployeeId;
        if (d.meterReading != null && hasMeter(d)) args.meterReading = d.meterReading;
        if (meterOn) { args.pumpMeterBefore = d.pumpMeterBefore; args.pumpMeterAfter = d.pumpMeterAfter; }
        else if (d.how === 'cans') { args.cansCount = d.cansCount; args.canSizeL = canSize(); }
        else args.litres = d.litres;
        return { channel: 'fuel:recordFill', args: args, kindLabel: 'kind_fill' };
      },
      facts: function (d) {
        var meterOn = flowMeterFrom(d.locationId);
        return [
          ['field_tank', locName(d.locationId)],
          ['field_vehicle', assetName(assetOf(d))],
          ['field_driver', d.driverEmployeeId ? staffName(byId(S.staff, d.driverEmployeeId)) : tr('no_driver')],
          hasMeter(d) ? ['field_reading', d.meterReading != null ? num(d.meterReading, 1) + ' ' + tr(meterUnit(d) === 'hours' ? 'unit_hours' : 'unit_km') : '—'] : null,
          meterOn ? ['field_pump', num(d.pumpMeterBefore) + ' → ' + num(d.pumpMeterAfter)] : null,
          d.how === 'cans' && !meterOn ? ['field_litres', tr('cans_total', { n: d.cansCount, size: num(canSize()), litres: num(litresOf(d, false)) })] : ['field_litres', litresText(litresOf(d, meterOn))],
          ['field_full', d.fullTank ? tr('yes') : tr('no')],
        ];
      },
    },

    dip: {
      title: 'home_dip', icon: 'dip',
      available: function () { return locTiles(['tank', 'farm_store']).length; },
      steps: [
        { type: 'tiles', key: 'locationId', title: 'pick_tank_dip', autoSingle: true, remember: LS.tank, items: function () { return locTiles(['tank', 'farm_store']); }, after: loadChart },
        { type: 'photo', kind: 'stick', title: 'photo_stick' },
        { type: 'number', key: 'dipCm', title: 'dip_cm', unit: 'unit_cm', decimals: 1, live: dipLive, when: hasChart, valid: function (d, v) { return v != null && v >= 0; } },
        { type: 'number', key: 'litres', title: 'litres', unit: 'unit_l', decimals: 2, intro: 'dip_no_chart', when: function (d) { return !hasChart(d); }, valid: function (d, v) { return v != null && v >= 0; } },
        { type: 'review' },
      ],
      build: function (d) {
        var args = { locationId: d.locationId };
        if (hasChart(d)) args.dipCm = d.dipCm; else args.litres = d.litres;
        return { channel: 'fuel:recordDip', args: args, kindLabel: 'kind_dip' };
      },
      facts: function (d) {
        var live = hasChart(d) ? L.chartLitres(S.chartCache[d.locationId], d.dipCm) : null;
        return [
          ['field_tank', locName(d.locationId)],
          hasChart(d) ? ['field_dip', num(d.dipCm, 1) + ' ' + tr('unit_cm')] : null,
          ['field_litres', live ? '≈ ' + litresText(live.litres) : litresText(d.litres)],
        ];
      },
    },

    send: {
      title: 'home_send', icon: 'send',
      available: function () { return locTiles(['tank']).length && locTiles(['farm_store']).length; },
      steps: [
        { type: 'tiles', key: 'fromLocationId', title: 'pick_tank', autoSingle: true, remember: LS.tank, items: function () { return locTiles(['tank']); } },
        { type: 'tiles', key: 'toLocationId', title: 'pick_to_farm', autoSingle: true, items: function () { return locTiles(['farm_store']); } },
      ].concat(pumpMeterSteps('fromLocationId'), [
        { type: 'number', key: 'containers', title: 'containers_q', decimals: 0, optional: true, when: function (d) { return d.how !== 'cans' || flowMeterFrom(d.fromLocationId); } },
        { type: 'photo', kind: 'containers', title: 'photo_containers' },
        { type: 'review' },
      ]),
      build: function (d) {
        var meterOn = flowMeterFrom(d.fromLocationId);
        var args = { fromLocationId: d.fromLocationId, toLocationId: d.toLocationId };
        if (meterOn) { args.pumpMeterBefore = d.pumpMeterBefore; args.pumpMeterAfter = d.pumpMeterAfter; }
        else args.litresSent = litresOf(d, false);
        if (d.how === 'cans' && !meterOn) args.containers = d.cansCount;
        else if (d.containers != null) args.containers = d.containers;
        return { channel: 'fuel:recordTransfer', args: args, kindLabel: 'kind_transfer' };
      },
      facts: function (d) {
        var meterOn = flowMeterFrom(d.fromLocationId);
        return [
          ['field_tank', locName(d.fromLocationId)],
          ['field_to', locName(d.toLocationId)],
          meterOn ? ['field_pump', num(d.pumpMeterBefore) + ' → ' + num(d.pumpMeterAfter)] : null,
          ['field_litres', litresText(litresOf(d, meterOn))],
          d.how === 'cans' && !meterOn ? ['field_containers', String(d.cansCount)] : d.containers != null ? ['field_containers', String(d.containers)] : null,
        ];
      },
    },

    received: {
      title: 'home_received', icon: 'recv',
      available: function () { return locTiles(['farm_store']).length; },
      start: function (d) {
        // The one who sent fuel may not confirm it arrived (the server refuses), so
        // this phone's own sends are not offered.
        return rpc('fuel:listPendingTransfers', {}).then(function (list) {
          d.pending = (list || []).filter(function (x) { return !x.recordedByUserId || !S.user || x.recordedByUserId !== S.user.id; });
        });
      },
      steps: [
        {
          type: 'tiles', key: 'transferId', title: 'pick_transfer', empty: 'no_pending',
          items: function (d) {
            return (d.pending || []).map(function (x) {
              return { id: x.id, title: locName(x.fromLocationId) + ' → ' + (locName(x.toLocationId) || '—'), sub: tr('sent_line', { litres: num(x.litresSent), when: fmtTime(x.sentAt) }) };
            });
          },
        },
        {
          type: 'number', key: 'litresReceived', title: 'litres_received', unit: 'unit_l', decimals: 2,
          live: function (d) { var x = byId(d.pending || [], d.transferId); return x ? { text: tr('sent_line', { litres: num(x.litresSent), when: fmtTime(x.sentAt) }) } : null; },
          valid: function (d, v) { return v != null && v >= 0; },
        },
        { type: 'photo', kind: 'received', title: 'photo_received' },
        { type: 'review' },
      ],
      build: function (d) {
        return { channel: 'fuel:receiveTransfer', args: { id: d.transferId, litresReceived: d.litresReceived }, kindLabel: 'kind_receive' };
      },
      facts: function (d) {
        var x = byId(d.pending || [], d.transferId);
        return [
          x ? ['field_tank', locName(x.fromLocationId) + ' → ' + locName(x.toLocationId)] : null,
          x ? ['litres_sent', litresText(x.litresSent)] : null,
          ['field_litres', litresText(d.litresReceived)],
        ];
      },
    },

    delivery: {
      title: 'home_delivery', icon: 'truck',
      available: function () { return locTiles(['tank']).length; },
      steps: [
        { type: 'tiles', key: 'locationId', title: 'pick_tank_delivery', autoSingle: true, remember: LS.tank, items: function () { return locTiles(['tank']); }, after: loadChart },
        // Dip before and after, saved as two dips linked to the delivery
        // (rule T2 "short delivery"). Each may be skipped; the office links them later.
        { type: 'photo', kind: 'stick', slot: 'dipBefore', title: 'photo_stick', label: 'dip_before', optional: true, when: hasChart },
        { type: 'number', key: 'dipBeforeCm', title: 'dip_before', unit: 'unit_cm', decimals: 1, optional: true, live: function (d, v) { return dipLive(d, v); }, when: hasChart, stamp: 'dipBeforeAt' },
        { type: 'photo', kind: 'invoice', title: 'photo_invoice' },
        { type: 'number', key: 'litresInvoiced', title: 'litres_invoiced', unit: 'unit_l', decimals: 2, valid: function (d, v) { return v > 0; } },
        { type: 'photo', kind: 'truck', title: 'photo_truck', optional: true },
        { type: 'photo', kind: 'stick', slot: 'dipAfter', title: 'photo_stick', label: 'dip_after', optional: true, when: hasChart },
        { type: 'number', key: 'dipAfterCm', title: 'dip_after', unit: 'unit_cm', decimals: 1, optional: true, live: function (d, v) { return dipLive(d, v); }, when: hasChart, stamp: 'dipAfterAt' },
        { type: 'review' },
      ],
      build: function (d) {
        var pre = [];
        if (hasChart(d) && d.dipBeforeCm != null) pre.push({ as: 'dipBeforeId', key: 'dipBefore', cm: d.dipBeforeCm, at: d.dipBeforeAt });
        if (hasChart(d) && d.dipAfterCm != null) pre.push({ as: 'dipAfterId', key: 'dipAfter', cm: d.dipAfterCm, at: d.dipAfterAt });
        return { channel: 'fuel:recordDelivery', args: { locationId: d.locationId, litresInvoiced: d.litresInvoiced }, kindLabel: 'kind_delivery', pre: pre };
      },
      facts: function (d) {
        return [
          ['field_tank', locName(d.locationId)],
          d.dipBeforeCm != null ? [tr('dip_before'), num(d.dipBeforeCm, 1) + ' ' + tr('unit_cm')] : null,
          ['litres_invoiced', litresText(d.litresInvoiced)],
          d.dipAfterCm != null ? [tr('dip_after'), num(d.dipAfterCm, 1) + ' ' + tr('unit_cm')] : null,
        ];
      },
    },

    bought: {
      title: 'home_bought', icon: 'cash',
      available: function () { return S.assets.length; },
      start: function (d) {
        d.currency = lsGet(LS.currency) || S.settings.defaultCurrency || 'KHR';
        var mine = S.me ? S.assets.filter(function (a) { return a.assignedEmployeeId === S.me.id && a.status === 'active'; }) : [];
        var last = lsGet(LS.vehicle);
        if (mine.length === 1) d.assetId = mine[0].id;
        else if (last && byId(S.assets, last)) d.assetId = last;
      },
      steps: [
        { type: 'tiles', key: 'assetId', title: 'pick_my_vehicle', search: true, keepPick: true, remember: LS.vehicle, items: function (d) { return assetTiles(d.assetId); } },
        { type: 'photo', kind: 'pump_display', title: 'photo_pump_display' },
        { type: 'photo', kind: 'meter', title: function (d) { return meterUnit(d) === 'hours' ? 'photo_meter_hours' : 'photo_meter_km'; }, when: hasMeter },
        { type: 'number', key: 'meterReading', title: function (d) { return meterUnit(d) === 'hours' ? 'reading_hours' : 'reading_km'; }, unit: function (d) { return meterUnit(d) === 'hours' ? 'unit_hours' : 'unit_km'; }, decimals: 1, optional: true, when: hasMeter },
        { type: 'number', key: 'amount', title: 'amount_paid', money: true, decimals: function (d) { return d.currency === 'USD' ? 2 : 0; }, valid: function (d, v) { return v > 0; } },
        { type: 'number', key: 'litresShownOnPump', title: 'litres_shown', unit: 'unit_l', decimals: 2, optional: true },
        {
          type: 'tiles', key: 'stationId', title: 'pick_station', other: 'other_station',
          items: function () { return S.stations.filter(function (s) { return !s.archived; }).map(function (s) { return { id: s.id, title: s.name, sub: s.area || '' }; }); },
        },
        { type: 'text', key: 'stationName', title: 'station_name', when: function (d) { return d.stationId === '__other'; } },
        { type: 'choice', key: 'fullTank', title: 'full_tank_q', options: yesNo },
        { type: 'review' },
      ],
      build: function (d) {
        var args = {
          kind: 'cash_station', assetId: d.assetId, fullTank: d.fullTank === true,
          amountPaidMinor: L.toMinor(d.amount, d.currency), currency: d.currency,
        };
        if (d.stationId && d.stationId !== '__other') args.stationId = d.stationId;
        else args.stationName = d.stationName;
        if (d.litresShownOnPump != null) args.litresShownOnPump = d.litresShownOnPump;
        if (d.meterReading != null && hasMeter(d)) args.meterReading = d.meterReading;
        return { channel: 'fuel:recordFill', args: args, kindLabel: 'kind_cash' };
      },
      facts: function (d) {
        var st = byId(S.stations, d.stationId);
        return [
          ['field_vehicle', assetName(assetOf(d))],
          hasMeter(d) ? ['field_reading', d.meterReading != null ? num(d.meterReading, 1) + ' ' + tr(meterUnit(d) === 'hours' ? 'unit_hours' : 'unit_km') : '—'] : null,
          ['field_amount', L.formatMoney(L.toMinor(d.amount, d.currency), d.currency)],
          ['field_shown', litresText(d.litresShownOnPump)],
          ['field_station', st ? st.name : d.stationName],
          ['field_full', d.fullTank ? tr('yes') : tr('no')],
        ];
      },
    },
  };
  var FLOW_ORDER_ATTENDANT = ['give', 'dip', 'send', 'received', 'delivery', 'bought'];
  var FLOW_ORDER_DRIVER = ['bought', 'give', 'dip', 'send', 'received', 'delivery'];
  var FLOW_SUB = { give: 'home_give_sub', dip: 'home_dip_sub', send: 'home_send_sub', received: 'home_received_sub', delivery: 'home_delivery_sub', bought: 'home_bought_sub' };

  function yesNo() { return [{ value: true, label: tr('yes') }, { value: false, label: tr('no') }]; }
  function hasChart(d) { var c = S.chartCache[d.locationId]; return Array.isArray(c) && c.length >= 2; }
  function dipLive(d, v) {
    if (v == null) return null;
    var r = L.chartLitres(S.chartCache[d.locationId], v);
    if (r.litres == null) return null;
    return { text: tr('dip_litres_live', { litres: num(r.litres) }) + (r.outOfRange ? ' — ' + tr('dip_out_of_range') : ''), warn: r.outOfRange };
  }
  function loadChart(d) {
    var id = d.locationId;
    if (!id || S.chartCache[id] !== undefined) return Promise.resolve();
    var loc = byId(S.locations, id);
    if (loc && !loc.hasChart) { S.chartCache[id] = null; return Promise.resolve(); }
    return rpc('fuel:getChart', id).then(function (c) { S.chartCache[id] = c || null; });
  }

  /* ── flow engine ───────────────────────────────────────────────── */
  function label(v, d) { return typeof v === 'function' ? v(d) : v; }
  function stepOn(step, d) { return !step.when || !!step.when(d); }

  function startFlow(key) {
    var flow = FLOWS[key];
    var d = { photos: {} };
    screen = { name: 'flow', key: key, flow: flow, data: d, index: -1, trail: [], session: null };
    showLoading();
    Promise.resolve(flow.start ? flow.start(d) : null).then(function () { advance(); }, function (err) {
      toast(err.message);
      goHome();
    });
  }

  /**
   * Move forward to the next step that applies. A tile step with only one
   * choice (the only tank) is picked by itself and never shown — Back skips it too.
   */
  function advance() {
    var f = screen.flow;
    var d = screen.data;
    var from = screen.index;
    var i = from + 1;
    function loop() {
      for (; i < f.steps.length; i += 1) {
        var st = f.steps[i];
        if (!stepOn(st, d)) continue;
        if (st.type === 'tiles' && st.autoSingle) {
          var items = st.items(d);
          if (items.length === 1) {
            d[st.key] = items[0].id;
            if (st.after) {
              i += 1;
              showLoading();
              return Promise.resolve(st.after(d)).then(loop, function (err) { toast(err.message); goHome(); });
            }
            continue;
          }
        }
        break;
      }
      if (from >= 0) screen.trail.push(from);
      screen.index = Math.min(i, f.steps.length - 1);
      render();
      return null;
    }
    loop();
  }

  function stepDone(value) {
    var f = screen.flow;
    var st = f.steps[screen.index];
    var d = screen.data;
    if (st.key) d[st.key] = value;
    if (st.stamp) d[st.stamp] = Date.now();
    if (st.remember && value) lsSet(st.remember, value);
    var p = st.after ? st.after(d) : null;
    if (p && p.then) {
      showLoading();
      p.then(advance, function (err) { toast(err.message); render(); });
    } else {
      advance();
    }
  }

  function goBack() {
    if (screen.name === 'flow' && screen.trail.length) {
      screen.index = screen.trail.pop();
      render();
      return;
    }
    goHome();
  }

  /* ── history: Android Back / iOS swipe go one step back ─────────── */
  var pushed = false;
  var ignorePop = false;
  function syncHistory() {
    var home = screen.name === 'home' || screen.name === 'connect' || screen.name === 'loading' || screen.name === 'error';
    if (!home && !pushed) {
      try { window.history.pushState({ fuel: 1 }, ''); pushed = true; } catch (_) { /* no history API */ }
    } else if (home && pushed) {
      pushed = false;
      ignorePop = true;
      try { window.history.back(); } catch (_) { ignorePop = false; }
    }
  }
  window.addEventListener('popstate', function () {
    if (ignorePop) { ignorePop = false; return; }
    pushed = false;
    if (screen.name === 'saving') { syncHistory(); return; }
    if (screen.name !== 'home') goBack();
  });

  /* ── rendering ─────────────────────────────────────────────────── */
  function setTitle(text, back) {
    titleEl.textContent = text;
    backBtn.hidden = !back;
    backBtn.setAttribute('aria-label', tr('back'));
    langBtn.textContent = tr('lang_other');
    document.documentElement.lang = lang;
  }
  function mount(nodes) {
    view.textContent = '';
    nodes.forEach(function (n) { if (n) view.appendChild(n); });
    window.scrollTo(0, 0);
    syncHistory();
  }
  function showLoading() {
    setTitle(tr('app_title'), screen.name === 'flow');
    mount([h('div', { class: 'spinner', role: 'progressbar', 'aria-label': tr('loading') })]);
  }

  function renderChip() {
    var c = L.counts(S.items, outboxCtx());
    var parts = [];
    if (c.waiting) parts.push(tr('waiting_n', { n: c.waiting }));
    if (c.failed) parts.push(tr('failed_n', { n: c.failed }));
    if (c.elsewhere) parts.push(tr('other_account') + ' (' + c.elsewhere + ')');
    if (!S.online) parts.unshift(tr('offline'));
    chip.hidden = parts.length === 0 || screen.name === 'connect';
    chip.textContent = parts.join(' · ');
    chip.className = 'chip' + (c.failed ? ' is-bad' : !S.online && !c.waiting ? ' is-off' : '');
  }

  function render() {
    renderChip();
    var fn = {
      connect: renderConnect, loading: showLoading, error: renderError, home: renderHome, flow: renderStep,
      saving: renderSaving, result: renderResult, outbox: renderOutbox, recent: renderRecent,
    }[screen.name];
    (fn || renderHome)();
  }

  function renderConnect() {
    setTitle(tr('connect_title'), false);
    var input = h('input', { class: 'textin', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': tr('connect_paste') });
    var msg = screen.message ? h('div', { class: 'notice notice--bad', text: screen.message }) : null;
    mount([h('div', { class: 'stack' }, [
      msg,
      h('p', { text: tr('connect_help') }),
      h('p', { class: 'muted small', text: tr('connect_paste') }),
      input,
      h('button', {
        type: 'button', class: 'big', text: tr('connect_btn'),
        onclick: function () {
          var t = input.value.trim();
          if (!t) return;
          token = t;
          lsSet(LS.tok, t);
          if (outbox) outbox.unblock();
          boot();
        },
      }),
    ])]);
  }

  function renderError() {
    setTitle(tr('app_title'), false);
    mount([h('div', { class: 'stack' }, [
      h('div', { class: 'notice notice--bad', text: screen.message || tr('cant_reach') }),
      h('button', { type: 'button', class: 'big', text: tr('try_again'), onclick: boot }),
    ])]);
  }

  function renderHome() {
    setTitle(tr('app_title'), false);
    var order = S.me && S.me.isDriver && !S.me.isFuelAttendant ? FLOW_ORDER_DRIVER : FLOW_ORDER_ATTENDANT;
    var tiles = order.filter(function (k) { return FLOWS[k].available(); }).map(function (k) {
      var f = FLOWS[k];
      return h('button', { type: 'button', class: 'flow-tile', 'data-flow': k, onclick: function () { startFlow(k); } }, [
        svg(ICON[f.icon]),
        h('span', {}, [h('span', { class: 'flow-tile__t', text: tr(f.title) }), h('span', { class: 'flow-tile__s', text: tr(FLOW_SUB[k]) })]),
      ]);
    });
    var co = byId(S.companies, S.companyId);
    var nodes = [];
    if (!S.storageOk) nodes.push(h('div', { class: 'notice notice--warn small', text: tr('storage_warning') }));
    if (!tiles.length) nodes.push(h('div', { class: 'notice notice--warn', text: tr('nothing_setup') }));
    nodes.push(h('div', { class: 'home' }, tiles));
    nodes.push(h('button', { type: 'button', class: 'flow-tile', onclick: showRecent }, [
      svg(ICON.list), h('span', {}, [h('span', { class: 'flow-tile__t', text: tr('home_recent') })]),
    ]));
    var who = [S.user && S.user.name, S.companies.length > 1 && co ? co.name : null].filter(Boolean).join(' · ');
    nodes.push(h('p', { class: 'muted small', style: 'text-align:center;margin-top:18px', text: who }));
    if (S.companies.length > 1) {
      var sel = h('select', { class: 'textin', 'aria-label': tr('company'), onchange: function () { switchCompany(sel.value); } },
        S.companies.map(function (c) { var o = h('option', { value: c.id, text: c.name }); if (c.id === S.companyId) o.selected = true; return o; }));
      nodes.push(sel);
    }
    nodes.push(h('button', { type: 'button', class: 'link', text: tr('sign_out'), onclick: signOut }));
    mount(nodes);
  }

  function stepTitle(st, d) {
    var k = label(st.title, d);
    return st.type === 'photo' && st.label ? tr(st.label) + ' — ' + tr(k) : tr(k);
  }

  function dots() {
    var f = screen.flow;
    var d = screen.data;
    var shown = [];
    f.steps.forEach(function (st, i) { if (stepOn(st, d)) shown.push(i); });
    return h('div', { class: 'dots', 'aria-hidden': 'true' }, shown.map(function (i) { return h('i', { class: i <= screen.index ? 'is-on' : '' }); }));
  }

  function renderStep() {
    var f = screen.flow;
    var st = f.steps[screen.index];
    var d = screen.data;
    if (!st) { goHome(); return; }
    setTitle(tr(f.title), true);
    var body = {
      tiles: tilesStep, photo: photoStep, number: numberStep, choice: choiceStep, cans: cansStep, text: textStep, review: reviewStep,
    }[st.type](st, d);
    mount([dots(), h('h1', { text: st.type === 'review' ? tr('review') : stepTitle(st, d) })].concat(body));
  }

  function tilesStep(st, d) {
    var items = st.items(d);
    var picked = d[st.key] || (st.preset ? st.preset(d) : null) || (st.remember ? lsGet(st.remember) : null);
    if (!items.length && st.empty) {
      return [h('div', { class: 'notice notice--warn', text: tr(st.empty) }), h('button', { type: 'button', class: 'big big--soft', text: tr('done'), onclick: goHome })];
    }
    var grid = h('div', { class: 'grid' });
    function draw(q) {
      grid.textContent = '';
      var needle = String(q || '').trim().toLowerCase();
      items.filter(function (it) { return !needle || (it.title + ' ' + it.sub).toLowerCase().indexOf(needle) !== -1; }).forEach(function (it) {
        var img = h('div', { class: 'tile__img', text: initials(it.title) });
        var tile = h('button', { type: 'button', class: 'tile' + (it.id === picked ? ' is-picked' : ''), 'data-id': it.id, onclick: function () { stepDone(it.id); } }, [
          img, h('div', { class: 'tile__t', text: it.title }), it.sub ? h('div', { class: 'tile__s', text: it.sub }) : null,
        ]);
        if (it.photo) tilePhoto(img, it.photo);
        grid.appendChild(tile);
      });
      if (st.none) grid.appendChild(h('button', { type: 'button', class: 'tile tile--plain', 'data-id': '', onclick: function () { stepDone(null); } }, [h('div', { class: 'tile__t', text: tr(st.none) })]));
      if (st.other) grid.appendChild(h('button', { type: 'button', class: 'tile tile--plain', 'data-id': '__other', onclick: function () { stepDone('__other'); } }, [h('div', { class: 'tile__t', text: tr(st.other) })]));
    }
    draw('');
    var out = [];
    if (st.search && items.length > 8) out.push(h('input', { class: 'search', type: 'search', placeholder: tr('search'), 'aria-label': tr('search'), oninput: function (e) { draw(e.target.value); } }));
    if (st.keepPick && picked && byId(items, picked)) out.push(h('button', { type: 'button', class: 'big', style: 'margin-bottom:12px', text: tr('next'), onclick: function () { stepDone(picked); } }));
    out.push(grid);
    return out;
  }

  function photoKey(st) { return st.slot ? st.slot + ':' + st.kind : st.kind; }

  function photoStep(st, d) {
    var key = photoKey(st);
    var have = d.photos[key];
    var status = h('p', { class: 'muted', style: 'text-align:center' });
    var input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': tr('take_photo') });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      status.textContent = tr('photo_working');
      shrinkPhoto(file).then(function (p) {
        if (have && have.url) URL.revokeObjectURL(have.url);
        d.photos[key] = { kind: st.kind, slot: st.slot || null, buf: p.buf, url: URL.createObjectURL(p.blob) };
        stepDone(undefined);
      }, function () {
        status.textContent = tr('photo_failed');
      });
    });
    var camera = h('label', { class: 'big photo-slot' }, [svg(ICON.camera), h('span', { text: have ? tr('retake') : tr('take_photo') }), input]);
    var out = [];
    if (have) {
      out.push(h('img', { class: 'photo-preview', src: have.url, alt: '' }));
      out.push(h('div', { class: 'row2', style: 'margin-top:12px' }, [camera, h('button', { type: 'button', class: 'big', text: tr('next'), onclick: function () { stepDone(undefined); } })]));
    } else {
      out.push(camera);
    }
    out.push(status);
    out.push(h('button', {
      type: 'button', class: 'link', text: tr('no_photo'),
      onclick: function () {
        if (d.photos[key] && d.photos[key].url) URL.revokeObjectURL(d.photos[key].url);
        delete d.photos[key];
        stepDone(undefined);
      },
    }));
    return out;
  }

  function numberStep(st, d) {
    var decimals = label(st.decimals, d);
    var text = d[st.key] != null ? String(d[st.key]) : '';
    var unit = st.money ? (d.currency === 'USD' ? '$' : '៛') : st.unit ? tr(label(st.unit, d)) : '';
    var readout = h('div', { class: 'readout', 'data-readout': '1' });
    var live = h('div', { class: 'live' });
    var next = h('button', { type: 'button', class: 'big', text: tr('next') });
    function update() {
      readout.textContent = L.formatTyping(text);
      if (unit) readout.appendChild(h('small', { text: unit }));
      var v = L.parseKeypad(text);
      var lv = st.live ? st.live(d, v) : null;
      live.textContent = lv ? lv.text : '';
      live.className = 'live' + (lv && lv.warn ? ' is-warn' : '');
      next.disabled = v == null || (st.valid && !st.valid(d, v));
    }
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimals > 0 ? '.' : '', '0', 'back'];
    var pad = h('div', { class: 'keypad' }, keys.map(function (k) {
      if (!k) return h('span');
      return h('button', {
        type: 'button', class: 'key', 'data-key': k, 'aria-label': k === 'back' ? 'Delete' : k, text: k === 'back' ? '⌫' : k,
        onclick: function () { text = L.keypadPress(text, k, { decimals: decimals, maxLen: 10 }); update(); },
      });
    }));
    next.addEventListener('click', function () { var v = L.parseKeypad(text); if (v != null) stepDone(v); });
    var out = [];
    if (st.intro) out.push(h('p', { class: 'muted', text: tr(st.intro) }));
    if (st.money) {
      var seg = h('div', { class: 'seg', role: 'group' }, ['KHR', 'USD'].map(function (c) {
        return h('button', {
          type: 'button', class: d.currency === c ? 'is-on' : '', text: tr(c === 'USD' ? 'currency_usd' : 'currency_khr'),
          onclick: function () { d.currency = c; lsSet(LS.currency, c); text = ''; render(); },
        });
      }));
      out.push(seg);
    }
    out.push(readout, live, pad, next);
    if (st.optional) out.push(h('button', { type: 'button', class: 'link', text: tr('skip'), onclick: function () { stepDone(null); } }));
    update();
    return out;
  }

  function choiceStep(st, d) {
    return [h('div', { class: 'stack' }, st.options(d).map(function (o) {
      return h('button', { type: 'button', class: 'big' + (d[st.key] === o.value ? '' : ' big--soft'), 'data-value': String(o.value), text: o.label, onclick: function () { stepDone(o.value); } });
    }))];
  }

  function cansStep(st, d) {
    var n = d[st.key] || 1;
    var size = canSize();
    var count = h('div', { class: 'readout' });
    var total = h('div', { class: 'live' });
    function update() {
      count.textContent = String(n);
      total.textContent = tr('cans_total', { n: n, size: num(size), litres: num(L.litresFromCans(n, size)) });
    }
    update();
    return [
      h('p', { class: 'muted', text: tr('cans_count', { size: num(size) }) }),
      h('div', { class: 'stepper' }, [
        h('button', { type: 'button', class: 'key', 'aria-label': '−', text: '−', onclick: function () { n = Math.max(1, n - 1); update(); } }),
        count,
        h('button', { type: 'button', class: 'key', 'aria-label': '+', text: '+', onclick: function () { n = Math.min(1000, n + 1); update(); } }),
      ]),
      total,
      h('button', { type: 'button', class: 'big', text: tr('next'), onclick: function () { stepDone(n); } }),
    ];
  }

  function textStep(st, d) {
    var input = h('input', { class: 'textin', type: 'text', value: d[st.key] || '', 'aria-label': stepTitle(st, d) });
    var next = h('button', { type: 'button', class: 'big', text: tr('next'), onclick: function () { var v = input.value.trim(); if (v) stepDone(v.slice(0, 200)); } });
    setTimeout(function () { try { input.focus(); } catch (_) { /* fine */ } }, 50);
    return [input, h('div', { style: 'height:12px' }), next];
  }

  function factsList(rows) {
    var dl = h('dl', { class: 'facts' });
    rows.filter(Boolean).forEach(function (r) {
      var k = r[0];
      dl.appendChild(h('dt', { text: L.STRINGS.en[k] ? tr(k) : k }));
      dl.appendChild(h('dd', { text: r[1] == null || r[1] === '' ? '—' : String(r[1]) }));
    });
    return dl;
  }

  function photoThumbs(d) {
    var keys = Object.keys(d.photos || {});
    if (!keys.length) return null;
    return h('div', { class: 'thumbs' }, keys.map(function (k) { return h('img', { src: d.photos[k].url, alt: '' }); }));
  }

  function reviewStep(st, d) {
    var f = screen.flow;
    return [
      h('div', { class: 'card' }, [factsList(f.facts(d)), photoThumbs(d)]),
      h('div', { style: 'height:14px' }),
      h('button', { type: 'button', class: 'big', 'data-save': '1', text: tr('save'), onclick: save }),
    ];
  }

  /* ── saving ────────────────────────────────────────────────────── */
  function payloadKey(built, d) {
    return JSON.stringify([built.channel, built.args, (built.pre || []).map(function (p) { return [p.as, p.cm]; }),
      Object.keys(d.photos).sort().map(function (k) { return [k, d.photos[k].buf.byteLength]; })]);
  }

  function save() {
    var f = screen.flow;
    var d = screen.data;
    var built = f.build(d);
    // One client_ref per record, made at the first Save. A Save of exactly the
    // same thing again (after a refusal or a lost answer) reuses it; anything
    // edited in between gets a new one — the server refuses a reused client_ref
    // with different contents.
    var pk = payloadKey(built, d);
    if (!screen.session || screen.session.key !== pk) screen.session = { key: pk, ref: L.makeClientRef(device), pre: {} };
    var session = screen.session;
    var photos = Object.keys(d.photos).filter(function (k) { return !d.photos[k].slot; }).map(function (k) { return { kind: d.photos[k].kind, data: d.photos[k].buf }; });
    var pre = (built.pre || []).map(function (p) {
      var ref = session.pre[p.as] || (session.pre[p.as] = L.makeClientRef(device));
      var ph = d.photos[p.key + ':stick'];
      return {
        channel: 'fuel:recordDip', clientRef: ref, as: p.as, takenAt: p.at,
        args: { locationId: d.locationId, dipCm: p.cm }, photos: ph ? [{ kind: 'stick', data: ph.buf }] : [],
      };
    });
    var summary = { kindLabel: built.kindLabel, facts: f.facts(d).filter(Boolean) };
    var saved = { flow: screen.key, data: d, built: built, summary: summary };
    screen = Object.assign({}, screen, { name: 'saving' });
    render();
    outbox.add({
      channel: built.channel, args: built.args, photos: photos, pre: pre, clientRef: session.ref,
      companyId: S.companyId, userId: S.user && S.user.id, summary: summary,
      takenAt: Date.now(),
    }).then(function (outcome) {
      if (outcome.status === 'auth') return null; // kept on the phone; the connect screen is showing
      if (outcome.status === 'failed') {
        // Not saved on the Mac. Take it off the phone's list; the person fixes and saves again.
        return outbox.remove(session.ref).then(function () {
          screen = Object.assign({}, screen, { name: 'flow' });
          render();
          toast(tr('save_failed', { error: outcome.error && outcome.error.message }));
        });
      }
      screen = { name: 'result', saved: saved, outcome: outcome };
      render();
      return null;
    }).catch(function (err) {
      screen = Object.assign({}, screen, { name: 'flow' });
      render();
      toast(tr('save_failed', { error: err.message }));
    }).then(scheduleWake);
  }

  function renderSaving() {
    setTitle(tr(screen.flow.title), false);
    mount([h('div', { class: 'spinner' }), h('p', { class: 'muted', style: 'text-align:center', text: tr('saving') })]);
  }

  function serverFacts(res) {
    if (!res) return [];
    var rec = res.fill || res.dip || res.delivery || res.transfer;
    if (!rec) return [];
    var at = rec.at || rec.takenAt || rec.deliveredAt || rec.receivedAt || rec.sentAt;
    var rows = [['field_time', fmtTime(at)]];
    if (res.fill) {
      rows.push(['field_vehicle', assetName(byId(S.assets, rec.assetId))]);
      rows.push(['field_litres', litresText(rec.litres)]);
      if (rec.amountPaidMinor != null) rows.push(['field_amount', L.formatMoney(rec.amountPaidMinor, rec.currency)]);
      if (rec.meterReading != null) rows.push(['field_reading', num(rec.meterReading, 1)]);
      rows.push(['field_full', rec.fullTank ? tr('yes') : tr('no')]);
    } else if (res.dip) {
      rows.push(['field_tank', locName(rec.locationId)]);
      if (rec.dipCm != null) rows.push(['field_dip', num(rec.dipCm, 1) + ' ' + tr('unit_cm')]);
      rows.push(['field_litres', litresText(rec.litres)]);
    } else if (res.delivery) {
      rows.push(['field_tank', locName(rec.locationId)]);
      rows.push(['litres_invoiced', litresText(rec.litresInvoiced)]);
    } else if (res.transfer) {
      rows.push(['field_tank', locName(rec.fromLocationId) + ' → ' + locName(rec.toLocationId)]);
      rows.push(['litres_sent', litresText(rec.litresSent)]);
      if (rec.litresReceived != null) rows.push(['litres_received', litresText(rec.litresReceived)]);
    }
    return rows;
  }

  function renderResult() {
    var o = screen.outcome;
    var saved = screen.saved;
    setTitle(tr(saved.summary.kindLabel), false);
    var nodes = [];
    if (o.status === 'sent') {
      var res = o.result || {};
      nodes.push(h('div', { class: 'notice notice--ok', 'data-result': 'sent' }, [h('b', { text: tr('saved_title') }), res.duplicate ? h('span', { text: tr('saved_already') }) : null]));
      nodes.push(h('div', { class: 'card' }, factsList(serverFacts(res))));
      var flags = (res.flags || []).filter(function (fl) { return fl && (fl.severity === 'red' || fl.severity === 'amber') && !fl.resolved; });
      if (flags.length) {
        nodes.push(h('div', { class: 'notice notice--warn' }, [h('b', { text: tr('check_this') })].concat(flags.map(function (fl) { return h('div', { class: 'small', text: fl.explanation || fl.ruleKey }); }))));
      }
    } else {
      nodes.push(h('div', { class: 'notice notice--warn', 'data-result': 'queued' }, [h('b', { text: tr('queued_title') }), h('span', { text: tr('queued_body') })]));
      nodes.push(h('div', { class: 'card' }, factsList(saved.summary.facts)));
    }
    nodes.push(h('div', { style: 'height:14px' }));
    nodes.push(h('div', { class: 'row2' }, [
      h('button', { type: 'button', class: 'big big--soft', text: tr('another'), onclick: function () { startFlow(saved.flow); } }),
      h('button', { type: 'button', class: 'big', text: tr('done'), onclick: goHome }),
    ]));
    // Free the photo previews; the outbox holds its own copy of the bytes.
    Object.keys(saved.data.photos || {}).forEach(function (k) { var u = saved.data.photos[k].url; setTimeout(function () { URL.revokeObjectURL(u); }, 60000); });
    mount(nodes);
  }

  /* ── outbox and recent screens ─────────────────────────────────── */
  function renderOutbox() {
    setTitle(tr('outbox_title'), true);
    var ctx = outboxCtx();
    var items = S.items.slice().sort(function (a, b) { return a.savedAt - b.savedAt; });
    if (!items.length) { mount([h('p', { class: 'muted', text: tr('outbox_empty') })]); return; }
    mount([h('div', { class: 'list' }, items.map(function (it) {
      var here = (!it.userId || it.userId === ctx.userId) && (!it.companyId || it.companyId === ctx.companyId);
      var state = !here ? tr('other_account') : it.state === 'failed' ? tr('state_failed', { error: it.lastError }) : it.state === 'sending' ? tr('state_sending') : tr('state_waiting');
      var sm = it.summary || {};
      return h('div', { class: 'card' }, [
        h('b', { text: (sm.kindLabel ? tr(sm.kindLabel) : it.channel) + ' · ' + fmtTime(it.savedAt) }),
        sm.facts ? factsList(sm.facts) : null,
        h('div', { class: it.state === 'failed' ? 'small notice notice--bad' : 'small muted', text: state }),
        here ? h('div', { class: 'row2' }, [
          h('button', { type: 'button', class: 'big big--soft', text: tr('send_now'), onclick: function () { outbox.retry(it.clientRef).then(scheduleWake); } }),
          h('button', {
            type: 'button', class: 'big big--soft', text: tr('delete'),
            onclick: function () { if (window.confirm(tr('delete_confirm'))) outbox.remove(it.clientRef); },
          }),
        ]) : null,
      ]);
    }))]);
  }

  function showRecent() {
    screen = { name: 'recent', data: null };
    showLoading();
    rpc('fuel:listMyRecent', { days: 3 }).then(function (r) {
      if (screen.name !== 'recent') return;
      screen.data = r;
      render();
    }, function (err) {
      toast(err.message);
      goHome();
    });
  }

  function renderRecent() {
    setTitle(tr('home_recent'), true);
    var r = screen.data || {};
    var rows = [];
    (r.fills || []).forEach(function (x) { rows.push({ at: x.at, kind: x.kind === 'cash_station' ? 'kind_cash' : 'kind_fill', text: assetName(byId(S.assets, x.assetId)) + ' · ' + litresText(x.litres), voided: x.voided }); });
    (r.dips || []).forEach(function (x) { rows.push({ at: x.takenAt, kind: 'kind_dip', text: locName(x.locationId) + ' · ' + litresText(x.litres), voided: x.voided }); });
    (r.deliveries || []).forEach(function (x) { rows.push({ at: x.deliveredAt, kind: 'kind_delivery', text: locName(x.locationId) + ' · ' + litresText(x.litresInvoiced), voided: x.voided }); });
    (r.transfers || []).forEach(function (x) { rows.push({ at: x.sentAt, kind: 'kind_transfer', text: locName(x.fromLocationId) + ' → ' + locName(x.toLocationId) + ' · ' + litresText(x.litresSent), voided: x.voided }); });
    rows.sort(function (a, b) { return b.at - a.at; });
    if (!rows.length) { mount([h('p', { class: 'muted', text: tr('recent_empty') })]); return; }
    mount([h('div', { class: 'list' }, rows.map(function (x) {
      return h('div', { class: 'card', style: x.voided ? 'opacity:.55;text-decoration:line-through' : '' }, [
        h('b', { text: tr(x.kind) + ' · ' + fmtTime(x.at) }), h('span', { text: x.text }),
      ]);
    }))]);
  }

  function goHome() {
    screen = { name: 'home' };
    render();
  }

  /* ── session ───────────────────────────────────────────────────── */
  function onTokenRejected() {
    if (screen.name === 'connect') return;
    screen = { name: 'connect', message: tr('token_rejected') };
    render();
  }

  function signOut() {
    if (!window.confirm(tr('sign_out_confirm'))) return;
    token = '';
    lsSet(LS.tok, null);
    S.user = null;
    screen = { name: 'connect' };
    render();
  }

  function switchCompany(id) {
    showLoading();
    rpc('companies:setActive', id).then(function () { S.companyId = id; return loadData(); }).then(function () {
      goHome();
      kick();
    }, function (err) {
      screen = { name: 'error', message: err.message };
      render();
    });
  }

  function loadData() {
    S.chartCache = {};
    return Promise.all([
      rpc('fuel:getSettings'),
      rpc('fuel:listAssets', { status: 'active' }),
      rpc('fuel:listLocations', {}),
      rpc('staff:list', { status: 'active' }),
      rpc('fuel:listStations', {}),
      rpc('staff:me').catch(function () { return null; }),
    ]).then(function (r) {
      S.settings = r[0] || {};
      S.assets = r[1] || [];
      S.locations = (r[2] || []).filter(function (l) { return l.status !== 'retired'; });
      S.staff = (r[3] || []).filter(function (e) { return e.status === 'active'; });
      S.stations = r[4] || [];
      S.me = r[5] || null;
    });
  }

  function boot() {
    if (!token) { screen = { name: 'connect' }; render(); return; }
    screen = { name: 'loading' };
    render();
    request('/api/whoami', {}, READ_TIMEOUT_MS).then(function (who) {
      var u = who && who.user;
      if (!u || !L.canRecordFuel(u.caps)) {
        screen = { name: 'connect', message: tr('no_fuel_access') };
        render();
        return null;
      }
      S.user = u;
      return Promise.all([rpc('companies:list'), rpc('companies:getActiveId').catch(function () { return null; })]).then(function (r) {
        S.companies = r[0] || [];
        if (!S.companies.length) throw new Error(tr('no_company'));
        var active = byId(S.companies, r[1]) ? r[1] : S.companies[0].id;
        S.companyId = active;
        return active === r[1] ? null : rpc('companies:setActive', active);
      }).then(loadData).then(function () {
        if (outbox) outbox.unblock();
        goHome();
        return refreshItems().then(kick);
      });
    }).catch(function (err) {
      if (err && err.status === 401) return; // onTokenRejected already showed the connect screen
      screen = { name: 'error', message: err && err.network ? tr('cant_reach') : err.message };
      render();
    });
  }

  backBtn.addEventListener('click', function () { goBack(); });
  langBtn.addEventListener('click', function () {
    lang = lang === 'km' ? 'en' : 'km';
    lsSet(LS.lang, lang);
    render();
  });
  chip.addEventListener('click', function () {
    if (screen.name === 'flow' || screen.name === 'saving') return;
    screen = { name: 'outbox' };
    render();
  });
  window.addEventListener('online', function () { kick(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') kick(); });

  openIdbStore().then(function (store) {
    if (!store) S.storageOk = false;
    outbox = L.createOutbox({
      store: store || L.memoryStore(),
      send: rpc,
      ctx: outboxCtx,
      encode: encodePhoto,
      onChange: refreshItems,
    });
    boot();
  });
})();
