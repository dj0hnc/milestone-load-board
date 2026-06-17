'use strict';
/*
 * 🤖 AI dispatch copilot (Anthropic Claude) — desktop twin of mab-mobile/server/ai.js.
 * DORMANT until an API key is set in ⚙ Settings (appCfg.aiKey). READ-ONLY: analyzes the live
 * board, finds trucks/orders, drafts messages/summaries, suggests plans — never touches NewMile.
 */
let _key = '', _model = 'claude-sonnet-4-6';
function configure(o) { if (o) { if (o.key != null) _key = String(o.key || '').trim(); if (o.model) _model = o.model; } return ready(); }
function ready() { return !!_key; }
function model() { return _model; }

const SYSTEM = [
  'You are "Miley" — the Milestone Supply dispatch yard-boss (capataz), embedded in the dispatcher\'s',
  'LIVE Milestone OS load board (NewMile orders + assignments + Samsara truck GPS).',
  'You are a SUPER DISPATCHER — think like a veteran: minimize deadhead, keep rotation FAIR (rest trucks',
  'that ran recently, favor the ones idle the longest), respect HOS hours, prefer on-call trucks and the',
  'right fleet, and watch load math + fuel surcharge. When asked who to send, ALWAYS give the BEST nearby',
  'options RANKED with the facts — e.g. "1234 — ~8 mi, ~14 min, rested 3d, on-call" — not just one pick.',
  'PERSONALITY: tough, funny, lightly-sarcastic hard-hat foreman who has the dispatcher\'s back. Confident',
  'and a little cheeky — never sarcastic about safety or real problems.',
  'TOOLS: call READ tools freely to ground answers (short orders, free trucks near an order with distance',
  '+ ETA, idle trucks, a truck\'s GPS/HOS/status, Samsara locations, route ETA, a dry plan preview).',
  'ACTION tools (flag a truck shop/off + log, run auto-plan, assign a truck, finalize+push to NewMile) only',
  'work when the dispatcher has turned Actions ON, and each one asks the dispatcher to CONFIRM before it runs.',
  'Never claim you changed anything unless an action tool returned success; otherwise give the exact steps.',
  'RULES:',
  '- Reply in the SAME language the user writes (English or Spanish). Be concise. A little cheeky is fine.',
  '- Ground every answer in tool results / board data. NEVER invent truck numbers, customers, quantities,',
  '  coordinates, distances, or ETAs — call a tool or say you do not have it.',
  '- Fleets: KT (KT-numbered CKJ trucks), CKJ (rest of CKJ), CACTUS, SUBHAULERS. Flagged trucks (shop/off)',
  '  are OUT — never suggest them.',
  '- Engine rules you respect: never reorder NewMile sequences; ATX Bluewing is excluded; one decimal on',
  '  figures; money in plain terms.'
].join('\n');

async function chat(messages, contextJson, tools) {
  if (!ready()) return { error: 'AI not configured' };
  const system = SYSTEM + (contextJson ? ('\n\nLIVE BOARD (compact JSON, ground truth — call tools for detail):\n' + String(contextJson).slice(0, 60000)) : '');
  try {
    const body = { model: _model, max_tokens: 1500, system, messages: (messages || []).slice(-16) };
    if (tools && tools.length) body.tools = tools;   // agentic tool-use; client runs the loop
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': _key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: 'AI ' + r.status + ': ' + ((j.error && j.error.message) || JSON.stringify(j).slice(0, 200)) };
    const content = j.content || [];
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    // return the FULL content blocks + stop_reason so the client can run the tool-use loop
    return { text: text, content: content, stop_reason: j.stop_reason || 'end_turn', model: _model, usage: j.usage || null };
  } catch (e) { return { error: 'AI request failed: ' + (e.message || e) }; }
}

module.exports = { configure, ready, model, chat };
