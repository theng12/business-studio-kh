/**
 * v0.1.71 — bulk table column sets.
 *
 * The bulk edit table's column selection is a per-user view. The last-used
 * selection lives in the renderer's localStorage (instant + works offline);
 * the NAMED sets live here, company-scoped in the database, so the same view
 * can be recalled on another Mac (the owner runs two Macs and a client Mac).
 *
 * Same CRUD shape and same company guard as the Social Grid templates
 * (main/ipc/socialGrid.js): a create must name the ACTIVE company, and every
 * read/update/delete goes through assertEntityInActiveCompany so one company
 * can never touch another's sets.
 */
const companies = require('../db/companies');
const sets = require('../db/bulkColumnSets');

function register({ expose, assertEntityInActiveCompany }) {
  expose('bulkColumns:list', ({ companyId } = {}) => {
    const activeId = companies.getActiveId();
    if (companyId && companyId !== activeId) return [];
    return sets.list(companyId || activeId);
  });

  expose('bulkColumns:create', (input = {}) => {
    if (input.companyId !== companies.getActiveId()) throw new Error('Cross-company create blocked');
    return sets.create(input);
  });

  expose('bulkColumns:update', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(sets.get(id), 'Column set');
    return sets.update(id, patch);
  });

  expose('bulkColumns:remove', ({ id } = {}) => {
    assertEntityInActiveCompany(sets.get(id), 'Column set');
    return sets.remove(id);
  });

  expose('bulkColumns:duplicate', ({ id } = {}) => {
    assertEntityInActiveCompany(sets.get(id), 'Column set');
    return sets.duplicate(id);
  });

  /* v0.1.72: the remembered column WIDTHS. Same company guard shape as the
   * sets above — a read for another company returns nothing, and a write that
   * names another company is refused. */
  expose('bulkColumns:getWidths', ({ companyId } = {}) => {
    const activeId = companies.getActiveId();
    if (companyId && companyId !== activeId) return null;
    return sets.getWidths(companyId || activeId);
  });

  expose('bulkColumns:setWidths', (input = {}) => {
    if (input.companyId !== companies.getActiveId()) throw new Error('Cross-company update blocked');
    return sets.setWidths(input.companyId, input.widths);
  });
}

module.exports = { register };
