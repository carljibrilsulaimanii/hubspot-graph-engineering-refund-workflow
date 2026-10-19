/*
 * Refund Request Graph (MOCK) - step 1: Classify (AI)
 * Author: Jibril Sulaiman (with Claude Code)
 * Date: 2026-10-19
 * Deploy location: HubSpot > Automation > Workflows > "Refund Request Graph (MOCK)"
 *   > Custom code action "Classify (AI)". Design only: never deployed or run.
 * What: one Claude call that labels a new ticket as refund_request, complaint or other.
 * Why: this is the "classify" step, the only place the model picks a path.
 *   Every later branch is decided by plain rules on ticket properties.
 *
 * Secret: REFUND_GRAPH_CLAUDE (new, Claude API key used only by this workflow).
 * Inputs (Property to include in code): subject, content
 * Outputs (Data outputs): request_type (string), status (string: ok | error)
 *
 * Raw HTTP via axios because HubSpot code actions cannot install @anthropic-ai/sdk.
 * HubSpot stops a code action after 20 seconds, so effort is low and output is short.
 */
const axios = require('axios');

const MODEL = 'claude-opus-5-5';
const TYPES = ['refund_request', 'complaint', 'other'];

const SCHEMA = {
  type: 'object',
  properties: {
    request_type: { type: 'string', enum: TYPES },
  },
  required: ['request_type'],
  additionalProperties: false,
};

const SYSTEM = [
  'You sort customer support tickets for a business that sells products online.',
  'refund_request: the customer wants money back for a purchase.',
  'complaint: the customer is unhappy but is not asking for money back.',
  'other: anything else, such as a login problem or a question.',
  'If a ticket both complains and asks for money back, it is a refund_request.',
].join('\n');

function isRetryable(err) {
  const s = err.response && err.response.status;
  return s === 429 || (s >= 500 && s < 600) || !err.response;
}

exports.main = async (event, callback) => {
  const subject = event.inputFields['subject'] || '';
  const content = event.inputFields['content'] || '';

  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 2000,
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Subject: ${subject}\n\nMessage:\n${content}` }],
      },
      {
        timeout: 15000,
        headers: {
          'x-api-key': process.env.REFUND_GRAPH_CLAUDE,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
          'content-type': 'application/json',
        },
      }
    );

    if (res.data.stop_reason === 'refusal') {
      return callback({ outputFields: { request_type: 'other', status: 'error' } });
    }
    const text = res.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text);
    const requestType = TYPES.includes(parsed.request_type) ? parsed.request_type : 'other';

    callback({ outputFields: { request_type: requestType, status: 'ok' } });
  } catch (err) {
    // Throwing a rate-limit or server error lets HubSpot retry the action on its own.
    if (isRetryable(err)) throw err;
    console.log('Classify failed:', err.message);
    callback({ outputFields: { request_type: 'other', status: 'error' } });
  }
};
