/**
 * Price fields on the baseline product reads.
 *
 * `products:list` and `products:get` are baseline reads: every authenticated
 * user may call them so a client app can boot and browse. They carry the
 * catalog's price fields. The packer role must see no prices
 * (docs/PICK_AND_PACK_PLAN.md §7), so the server strips them from those two
 * reads for a price-blind role (main/util/capabilities.js canSeePrices).
 *
 * Safe by construction: every screen that shows or edits a price is
 * capability-gated, and the renderer formats a missing price as blank
 * (renderer/lib/prices.js formatPriceEntry returns '' when amount is null).
 */

const PRICE_FIELDS = ['priceRetail', 'priceWholesale', 'priceRetailCurrency', 'priceWholesaleCurrency', 'prices'];

function withoutPrices(product) {
  if (!product || typeof product !== 'object') return product;
  const out = { ...product };
  for (const field of PRICE_FIELDS) delete out[field];
  return out;
}

/** Pure: strip price fields from the two baseline product reads, nothing else. */
function stripProductPrices(channel, result) {
  if (channel === 'products:list') return Array.isArray(result) ? result.map(withoutPrices) : result;
  if (channel === 'products:get') return withoutPrices(result);
  return result;
}

module.exports = { stripProductPrices, PRICE_FIELDS };
