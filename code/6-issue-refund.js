/*
 * Refund Request Graph (MOCK) - step 6: Issue refund
 * Author: Jibril Sulaiman (with Claude Code)
 * Date: 2026-10-19
 * Deploy location: HubSpot > Automation > Workflows > "Refund Request Graph (MOCK)"
 *   > Custom code action "Issue refund". Design only: never deployed or run.
 * What: refunds the charge in Stripe, at most once per ticket.
 * Why: if the process dies after sending the refund and before
 *   reading the answer, a blind rerun would pay twice. Two guards stop that:
 *   1. Before refunding, look for a refund already tagged with this ticket id.
 *   2. Send the ticket id as Stripe's Idempotency-Key, so a retry within 24 hours
 *      returns the first refund instead of making a new one.
 *
 * Secret: REFUND_GRAPH_STRIPE (test-mode key while this is a mock)
 * Inputs: hs_object_id, rg_order_id, rg_order_amount
 * Outputs: refund_id (string), status (string: ok | error)
 */
const axios = require('axios');

const stripe = axios.create({
  baseURL: 'https://api.stripe.com/v1',
  timeout: 10000,
  headers: { Authorization: `Bearer ${process.env.REFUND_GRAPH_STRIPE}` },
});

function isRetryable(err) {
  const s = err.response && err.response.status;
  return s === 429 || (s >= 500 && s < 600) || !err.response;
}

exports.main = async (event, callback) => {
  const ticketId = String(event.inputFields['hs_object_id'] || '');
  const chargeId = event.inputFields['rg_order_id'];
  const cents = Math.round(parseFloat(event.inputFields['rg_order_amount'] || '0') * 100);

  if (!ticketId || !chargeId || cents <= 0) {
    return callback({ outputFields: { refund_id: '', status: 'error' } });
  }

  try {
    // Guard 1: a refund for this ticket may already exist from an earlier run.
    const existing = await stripe.get('/refunds', { params: { charge: chargeId, limit: 100 } });
    const mine = existing.data.data.find(
      (r) => r.metadata && r.metadata.hubspot_ticket_id === ticketId && r.status !== 'failed' && r.status !== 'canceled'
    );
    if (mine) {
      console.log(`Refund ${mine.id} already exists for ticket ${ticketId}`);
      return callback({ outputFields: { refund_id: mine.id, status: 'ok' } });
    }

    // Guard 2: Stripe returns the same refund for the same key on a retry.
    const body = new URLSearchParams({
      charge: chargeId,
      amount: String(cents),
      reason: 'requested_by_customer',
      'metadata[hubspot_ticket_id]': ticketId,
      'metadata[source]': 'refund-request-graph-mock',
    });
    const res = await stripe.post('/refunds', body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `refund-graph-ticket-${ticketId}`,
      },
    });

    callback({ outputFields: { refund_id: res.data.id, status: 'ok' } });
  } catch (err) {
    if (isRetryable(err)) throw err;
    console.log('Issue refund failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    callback({ outputFields: { refund_id: '', status: 'error' } });
  }
};
