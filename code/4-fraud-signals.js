/*
 * Refund Request Graph (MOCK) - step 4: Fraud signals
 * Author: Jibril Sulaiman (with Claude Code)
 * Date: 2026-10-19
 * Deploy location: HubSpot > Automation > Workflows > "Refund Request Graph (MOCK)"
 *   > Custom code action "Fraud signals". Design only: never deployed or run.
 * What: a 0 to 1 fraud score from Stripe history: Radar risk level on the charge,
 *   disputes and earlier refunds by the same customer in the last 365 days.
 * Why: the "fraud signals" step. Plain code, so the score can be explained line by line.
 *
 * The weights below are placeholders for a mock. Open decision.
 *
 * Secret: REFUND_GRAPH_STRIPE (test-mode key while this is a mock)
 * Inputs: rg_order_id, rg_customer_email
 * Outputs: fraud_score (number), status (string: ok | error)
 */
const axios = require('axios');

const stripe = axios.create({
  baseURL: 'https://api.stripe.com/v1',
  timeout: 8000,
  headers: { Authorization: `Bearer ${process.env.REFUND_GRAPH_STRIPE}` },
});

const WEIGHTS = {
  riskElevated: 0.25,
  riskHighest: 0.5,
  anyDispute: 0.4,
  oneEarlierRefund: 0.1,
  twoOrMoreEarlierRefunds: 0.2,
};

function isRetryable(err) {
  const s = err.response && err.response.status;
  return s === 429 || (s >= 500 && s < 600) || !err.response;
}

exports.main = async (event, callback) => {
  const orderId = event.inputFields['rg_order_id'];
  const email = (event.inputFields['rg_customer_email'] || '').trim().toLowerCase().replace(/"/g, '');

  if (!orderId) {
    return callback({ outputFields: { fraud_score: 0, status: 'error' } });
  }

  try {
    const charge = (await stripe.get(`/charges/${orderId}`)).data;
    const since = Math.floor(Date.now() / 1000) - 365 * 86400;

    const history = charge.customer
      ? (await stripe.get('/charges', { params: { customer: charge.customer, limit: 100, 'created[gte]': since } })).data.data
      : (await stripe.get('/charges/search', { params: { query: `billing_details.email:"${email}" AND created>${since}`, limit: 100 } })).data.data;

    const others = history.filter((ch) => ch.id !== charge.id);
    const earlierRefunds = others.filter((ch) => ch.amount_refunded > 0).length;
    const disputes = history.filter((ch) => ch.disputed).length;
    const risk = charge.outcome && charge.outcome.risk_level;

    let score = 0;
    if (risk === 'elevated') score += WEIGHTS.riskElevated;
    if (risk === 'highest') score += WEIGHTS.riskHighest;
    if (disputes > 0) score += WEIGHTS.anyDispute;
    if (earlierRefunds === 1) score += WEIGHTS.oneEarlierRefund;
    if (earlierRefunds >= 2) score += WEIGHTS.twoOrMoreEarlierRefunds;
    score = Math.min(1, Math.round(score * 100) / 100);

    console.log(`risk_level=${risk} disputes=${disputes} earlier_refunds=${earlierRefunds} score=${score}`);
    callback({ outputFields: { fraud_score: score, status: 'ok' } });
  } catch (err) {
    if (isRetryable(err)) throw err;
    console.log('Fraud signals failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    callback({ outputFields: { fraud_score: 0, status: 'error' } });
  }
};
