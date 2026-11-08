/*
 * Pick & Pack phone page (`/pack`) — pure helpers.
 *
 * Kept separate from app.js so the token, capability and display rules can be
 * read (and tested) without a browser. Inlined by scripts/build-webclient.js.
 */
(function () {
  'use strict';

  var LS_TOKEN = 'mskh.pack.token';

  /** Token from a pairing link's fragment (`#t=<token>`), or null. */
  function tokenFromHash(hash) {
    var m = /(?:^#|&)t=([^&]+)/.exec(String(hash || ''));
    if (!m) return null;
    try {
      var tok = decodeURIComponent(m[1]).trim();
      return tok || null;
    } catch (_) {
      return null;
    }
  }

  /** What the page offers this account (the server's capability gate decides). */
  function pageAccess(caps) {
    var c = Array.isArray(caps) ? caps : [];
    var all = c.indexOf('*') !== -1;
    var has = function (k) { return all || c.indexOf(k) !== -1; };
    var work = has('pack.work') || has('orders.manage');
    return { work: work, manage: has('orders.manage'), any: work };
  }

  /** First line of an address, cut short — enough to read at the bench. */
  function shortAddress(address) {
    var s = String(address || '').trim();
    if (!s) return '';
    var first = s.split(/\r?\n/)[0].trim();
    return first.length > 80 ? first.slice(0, 77) + '…' : first;
  }

  /** `2 of 3` for one line. */
  function lineProgress(line) {
    var qty = Number(line && line.quantity) || 0;
    var done = Number(line && line.confirmedQty) || 0;
    return done + ' of ' + qty;
  }

  function lineDone(line) {
    return (Number(line && line.confirmedQty) || 0) >= (Number(line && line.quantity) || 0);
  }

  /** The first parcel still to pack, or null. */
  function nextOrder(orders) {
    return Array.isArray(orders) && orders.length ? orders[0] : null;
  }

  function moneyText() { return ''; } // the pack screen never shows money

  window.PackLogic = {
    LS_TOKEN: LS_TOKEN,
    tokenFromHash: tokenFromHash,
    pageAccess: pageAccess,
    shortAddress: shortAddress,
    lineProgress: lineProgress,
    lineDone: lineDone,
    nextOrder: nextOrder,
    moneyText: moneyText,
  };
})();
