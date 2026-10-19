/*
 * Refund Request Graph (MOCK) - step 5: Decide (AI)
 * Author: Jibril Sulaiman (with Claude Code)
 * Date: 2026-10-19
 * Deploy location: HubSpot > Automation > Workflows > "Refund Request Graph (MOCK)"
 *   > Custom code action "Decide (AI)". Design only: never deployed or run.
 * What: one Claude call that reads the gathered evidence and returns a decision,
 *   the policy clause it relies on and a short reason. The clause is then checked
 *   against the real list, and the call is retried up to 3 times if it cites one that
 *   does not exist.
 * Why: the "decide" step with its "is the clause real?" check. The model judges;
 *   the amount branch and the approval wait stay in plain workflow rules.
 *
 * Secret: REFUND_GRAPH_CLAUDE
 * Inputs: content, rg_order_amount, rg_order_date, rg_policy_clauses, rg_fraud_score
 * Outputs: decision (string), cited_clause (string), reason (string),
 *   status (string: ok | error)
 *
 * Raw HTTP via axios because HubSpot code actions cannot install @anthropic-ai/sdk.
 * HubSpot stops a code action after 20 seconds, so retries stop at a 14-second budget.
 */
const axios = require('axios');

const MODEL = 'claude-opus-5-5';
const DECISIONS = ['refund', 'deny', 'needs_info', 'fraud_review'];
const MAX_ATTEMPTS = 3;
const TIME_BUDGET_MS = 14000;

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: DECISIONS },
    cited_clause: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['decision', 'cited_clause', 'reason'],
  additionalProperties: false,
};

const SYSTEM = [
  'You decide refund requests using only the policy clauses you are given.',
  'refund: the request meets every clause that applies. Approval for large amounts is handled after you, so still answer refund.',
  'deny: a clause rules it out, such as being outside the return window.',
  'needs_info: a clause needs something the customer has not sent yet, such as a photo of damage.',
  'fraud_review: the fraud score or the message suggests the request may not be genuine.',
  'cited_clause is the id of the one clause your decision rests on, exactly as written, for example 2.1.',
  'reason is one or two plain sentences a support rep can read to the customer.',
].join('\n');

function isRetryable(err) {
  const s = err.response && err.response.status;
  return s === 429 || (s >= 500 && s < 600) || !err.response;
}

async function askClaude(prompt, timeoutMs) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: MODEL,
      max_tokens: 4000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      timeout: timeoutMs,
      headers: {
        'x-api-key': process.env.REFUND_GRAPH_CLAUDE,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'content-type': 'application/json',
      },
    }
  );
  if (res.data.stop_reason === 'refusal') return null;
  const text = res.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

exports.main = async (event, callback) => {
  const started = Date.now();
  const clauses = event.inputFields['rg_policy_clauses'] || '';
  const realIds = (clauses.match(/^\d+\.\d+/gm) || []).map((s) => s.trim());
  const failed = (reason) =>
    callback({ outputFields: { decision: '', cited_clause: '', reason, status: 'error' } });

  if (!realIds.length) return failed('No policy clauses on the ticket.');

  const basePrompt = [
    `Customer message:\n${event.inputFields['content'] || ''}`,
    `Order amount: $${parseFloat(event.inputFields['rg_order_amount'] || '0').toFixed(2)}`,
    `Fraud score (0 to 1): ${event.inputFields['rg_fraud_score'] || '0'}`,
    `Policy clauses that apply:\n${clauses}`,
  ].join('\n\n');

  let prompt = basePrompt;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const left = TIME_BUDGET_MS - (Date.now() - started);
      if (left < 3000) break;

      const answer = await askClaude(prompt, left);
      if (!answer) return failed('The model declined to answer.');

      const cited = String(answer.cited_clause).trim();
      if (DECISIONS.includes(answer.decision) && realIds.includes(cited)) {
        return callback({
          outputFields: { decision: answer.decision, cited_clause: cited, reason: answer.reason, status: 'ok' },
        });
      }

      console.log(`Attempt ${attempt} cited "${cited}", not one of ${realIds.join(', ')}`);
      prompt = `${basePrompt}\n\nYour last answer cited clause "${cited}", which is not in the list. Cite one of: ${realIds.join(', ')}.`;
    }
    failed('No valid decision after 3 attempts.');
  } catch (err) {
    if (isRetryable(err)) throw err;
    console.log('Decide failed:', err.message);
    failed(err.message);
  }
};
