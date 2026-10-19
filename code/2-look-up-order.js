/*
 * Refund Request Graph (MOCK) - step 2: Look up order
 * Author: Jibril Sulaiman (with Claude Code)
 * Date: 2026-10-19
 * Deploy location: HubSpot > Automation > Workflows > "Refund Request Graph (MOCK)"
 *   > Custom code action "Look up order". Design only: never deployed or run.
 * What: finds the customer's most recent paid, unrefunded Stripe charge by email.
 * Why: the "look up order" step. Plain code, no AI, so it is always the same answer.
 *
 * Secret: REFUND_GRAPH_STRIPE (new, Stripe restricted key: Charges read, Customers read,
 *   Disputes read, Refunds write). Use the test-mode key while this is a mock.
 * Inputs: rg_customer_email
 * Outputs: order_id (string), order_amount (number, dollars),
 *   order_date (date, midnight UTC in ms), status (string: found | not_found | error)
 */
const axios = require('axios');

const stripe = axios.create({
  baseURL: 'https://api.stripe.com/v1',
  timeout: 8000,
  headers: { Authorization: `Bearer ${process.env.REFUND_GRAPH_STRIPE}` },
});

function isRetryable(err) {
  const s = err.response && err.response.status;
  return s === 429 || (s >= 500 && s < 600) || !err.response;
}

function midnightUtc(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function chargesForEmail(email) {
  // Stripe search does not allow a double quote inside the value.
  const safe = email.replace(/"/g, '');
  const byEmail = await stripe.get('/charges/search', {
    params: { query: `billing_details.email:"${safe}" AND status:"succeeded"`, limit: 20 },
  });
  if (byEmail.data.data.length) return byEmail.data.data;

  // Checkout charges sometimes carry the email only on the Customer.
  const customers = await stripe.get('/customers/search', {
    params: { query: `email:"${safe}"`, limit: 5 },
  });
  const all = [];
  for (const c of customers.data.data) {
    const list = await stripe.get('/charges', { params: { customer: c.id, limit: 20 } });
    all.push(...list.data.data.filter((ch) => ch.status === 'succeeded'));
  }
  return all;
}

exports.main = async (event, callback) => {
  const email = (event.inputFields['rg_customer_email'] || '').trim().toLowerCase();
  const empty = { order_id: '', order_amount: 0, order_date: null };

  if (!email) {
    return callback({ outputFields: { ...empty, status: 'not_found' } });
  }

  try {
    const charges = (await chargesForEmail(email))
      .filter((ch) => !ch.refunded && ch.amount_refunded === 0)
      .sort((a, b) => b.created - a.created);

    if (!charges.length) {
      return callback({ outputFields: { ...empty, status: 'not_found' } });
    }

    const latest = charges[0];
    callback({
      outputFields: {
        order_id: latest.id,
        order_amount: latest.amount / 100,
        order_date: midnightUtc(latest.created),
        status: 'found',
      },
    });
  } catch (err) {
    if (isRetryable(err)) throw err;
    console.log('Look up order failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    callback({ outputFields: { ...empty, status: 'error' } });
  }
};
