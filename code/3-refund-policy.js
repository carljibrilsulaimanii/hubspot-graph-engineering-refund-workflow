/*
 * Refund Request Graph (MOCK) - step 3: Refund policy
 * Author: Jibril Sulaiman (with Claude Code)
 * Date: 2026-10-19
 * Deploy location: HubSpot > Automation > Workflows > "Refund Request Graph (MOCK)"
 *   > Custom code action "Refund policy". Design only: never deployed or run.
 * What: lists the policy clauses that apply to this ticket, with the facts that decide each.
 * Why: the "refund policy" step. The decide step may only cite clauses written here,
 *   which is how its answer gets checked.
 *
 * The three clauses are placeholders, not a real policy. Open decision.
 *
 * Secret: none
 * Inputs: rg_order_date, rg_order_amount, content
 * Outputs: clauses (string, one clause per line), status (string: ok | error)
 */
const POLICY = [
  { id: '2.1', text: 'Return window: refunds are allowed within 30 days of purchase.' },
  { id: '2.3', text: 'Damage claims: a photo of the damage is required.' },
  { id: '4.1', text: 'Approval: refunds over $500 need a manager to approve.' },
];

const WINDOW_DAYS = 30;
const APPROVAL_OVER_USD = 500;
const DAMAGE_WORDS = /\b(broke|broken|crack|cracked|damage|damaged|defect|defective|shattered)\b/i;

function toMs(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isNaN(n)) return n;
  const p = Date.parse(value);
  return Number.isNaN(p) ? null : p;
}

exports.main = async (event, callback) => {
  try {
    const orderMs = toMs(event.inputFields['rg_order_date']);
    const amount = parseFloat(event.inputFields['rg_order_amount'] || '0');
    const content = event.inputFields['content'] || '';

    const days = orderMs === null ? null : Math.floor((Date.now() - orderMs) / 86400000);
    const lines = [];

    const window = POLICY.find((c) => c.id === '2.1');
    lines.push(
      days === null
        ? `${window.id} ${window.text} Fact: order date unknown.`
        : `${window.id} ${window.text} Fact: ${days} days since purchase, ${days <= WINDOW_DAYS ? 'inside' : 'outside'} the window.`
    );

    if (DAMAGE_WORDS.test(content)) {
      const damage = POLICY.find((c) => c.id === '2.3');
      lines.push(`${damage.id} ${damage.text} Fact: the message describes damage.`);
    }

    if (amount > APPROVAL_OVER_USD) {
      const approval = POLICY.find((c) => c.id === '4.1');
      lines.push(`${approval.id} ${approval.text} Fact: order is $${amount.toFixed(2)}.`);
    }

    callback({ outputFields: { clauses: lines.join('\n'), status: 'ok' } });
  } catch (err) {
    console.log('Refund policy failed:', err.message);
    callback({ outputFields: { clauses: '', status: 'error' } });
  }
};
