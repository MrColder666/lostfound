// src/lib/order-admin.js
// Pure rules for the reward shop: which status can move where, what a
// cancellation has to put back, and how a stock adjustment is allowed to look.
// The API layer runs the SQL; nothing here touches the database.

export const ORDER_STATUSES = ['pending', 'fulfilled', 'cancelled'];

export function fulfillmentPlan(status) {
  if (status === 'pending') return { ok: true, next: 'fulfilled' };
  if (status === 'fulfilled') return { ok: false, error: 'ALREADY_FULFILLED' };
  if (status === 'cancelled') return { ok: false, error: 'ORDER_CANCELLED' };
  return { ok: false, error: 'UNKNOWN_STATUS' };
}

// A cancellation refunds the points the student paid and puts one unit back in
// stock. Already cancelled counts as success (idempotent) but refunds nothing.
export function cancellationPlan({ status, points_cost, stock } = {}) {
  const cost = Number(points_cost) || 0;
  const current = Number(stock) || 0;
  if (status === 'pending') return { ok: true, already: false, refund: cost, stock_after: current + 1, next: 'cancelled' };
  if (status === 'cancelled') return { ok: true, already: true, refund: 0, stock_after: current, next: 'cancelled' };
  if (status === 'fulfilled') return { ok: false, error: 'ALREADY_FULFILLED' };
  return { ok: false, error: 'UNKNOWN_STATUS' };
}

export function stockAdjustPlan({ stock, delta } = {}) {
  const current = Number(stock);
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) return { ok: false, error: 'BAD_DELTA' };
  if (Math.abs(d) > 999) return { ok: false, error: 'BAD_DELTA' };
  if (!Number.isFinite(current)) return { ok: false, error: 'NOT_FOUND' };
  const next = current + d;
  if (next < 0) return { ok: false, error: 'NEGATIVE_STOCK', stock: current };
  return { ok: true, stock_after: next, delta: d };
}

// The order row has to be pending for a fulfillment to be written. Used by the
// API to decide between 200 and 409 before touching anything.
export function canFulfill(status) {
  return fulfillmentPlan(status).ok;
}
