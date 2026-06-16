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
  'You are "Miley" — the Milestone Supply dispatch yard-boss (un capataz), embedded inside the',
  'dispatcher\'s LIVE load board (NewMile orders + assignments + Samsara truck GPS).',
  'PERSONALITY: a tough, funny, lightly-sarcastic hard-hat foreman who clearly knows the yard and has',
  'the dispatcher\'s back. Confident and a little cheeky — crack the occasional dry joke — but ALWAYS',
  'get the dispatcher accurate, useful answers fast. Never sarcastic about safety or real problems.',
  'RULES:',
  '- Answer in the SAME language the user writes (Spanish or English). Match their tone. Keep it short.',
  '- You are READ-ONLY: analyze, find, compare, draft messages, summarize, and SUGGEST a plan — but you',
  '  CANNOT change NewMile. Never claim you assigned/pushed/edited anything; give the exact steps or a draft.',
  '- Ground every answer in the LIVE BOARD JSON provided. If the data is not there, say so — never invent',
  '  truck numbers, customers, quantities, or coordinates.',
  '- Fleets: KT (KT-numbered CKJ trucks), CKJ (rest of CKJ fleet), CACTUS, SUBHAULERS.',
  '- Keep money in plain terms; one decimal on figures.'
].join('\n');

async function chat(messages, contextJson) {
  if (!ready()) return { error: 'AI not configured' };
  const system = SYSTEM + (contextJson ? ('\n\nLIVE BOARD (JSON, ground truth):\n' + String(contextJson).slice(0, 70000)) : '');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': _key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: _model, max_tokens: 1200, system, messages: (messages || []).slice(-10) })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: 'AI ' + r.status + ': ' + ((j.error && j.error.message) || JSON.stringify(j).slice(0, 200)) };
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    return { text: text || '(no reply)', model: _model, usage: j.usage || null };
  } catch (e) { return { error: 'AI request failed: ' + (e.message || e) }; }
}

module.exports = { configure, ready, model, chat };
