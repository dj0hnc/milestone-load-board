'use strict';
/*
 * 🤖 MILEY — sabor TRACKER: el cerebro de FLOTA y GENTE (la del board es la de despacho).
 * Vive para el momento "estoy al teléfono con el chofer": dicta notas, recita la historia,
 * dice quién está disponible con horas, y copilotea el recruiting.
 * DORMANT sin API key: env ANTHROPIC_API_KEY manda; si no, se rescata la aiKey guardada en
 * los settings del board de escritorio (misma máquina). El repo es PÚBLICO: la key JAMÁS
 * se escribe aquí — solo se LEE de fuentes locales.
 */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.AI_MODEL || 'claude-sonnet-5';

function key() {
  let k = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!k) {
    try {
      k = String(JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'Milestone Load Board', 'app-settings.json'), 'utf8')).aiKey || '').trim();
    } catch (e) { /* sin settings del escritorio en esta máquina: dormant */ }
  }
  return k;
}
function ready() { return !!key(); }

const SYSTEM = [
  'You are "Miley" — the Milestone Supply FLEET & PEOPLE brain, embedded in the Cactus Tracker',
  '(truck availability, call log, HOS clocks, freight money, and the subhauler RECRUITING pipeline).',
  'Your sister instance on the Load Board handles dispatch; YOU handle trucks-as-people: who is',
  'available, what was discussed with each driver, who needs a follow-up, who earned what.',
  'PERSONALITY: tough, funny, lightly-sarcastic hard-hat forewoman. Short, useful, accurate.',
  'RULES:',
  '- Answer in the SAME language the user writes (Spanish or English). Keep it tight.',
  '- The context JSON is a compact snapshot — call the tools for live detail. Never invent trucks,',
  '  drivers, phone numbers, money or history. If the data is not there, say so.',
  '- The user\'s real name comes in context as "me" — notes you save are signed with it.',
  '- WRITE tools (save a note, mark a state, set a status, recruit note) ALWAYS show the dispatcher',
  '  a confirm card first. Never claim something was saved unless the tool returned success.',
  '- THE PHONE-CALL FLOW you are built for: dispatcher says "anótale al 720 que ..." → add_call_note.',
  '  "¿qué se ha hablado con el 1033?" → truck_history, then a 3-line summary, newest first.',
  '  "¿quién anda libre en Powderly con horas?" → find_available, rank by rested + HOS + low earner.',
  '- HOS SAFETY: <2h drive left = do not recommend for anything long; <4h = warn "tight".',
  '- MONEY FAIRNESS: when picks tie, favor the LOWER weekly earner and say so.',
  '- RECRUITING: recruit_brief shows Juan\'s desk (Onboarding & NewMile Training). Overdue',
  '  follow-ups first. You can draft texts/messages to subs — friendly, short, English unless asked.',
  '- Availability states: ok/shop/down/vacation/no_driver/deleased (status) + per-day marks:',
  '  assigned ✓ / X down today / NW no-work today / pending.'
].join('\n');

async function chat(messages, contextJson, tools) {
  if (!ready()) return { error: 'AI not configured (no API key on this machine)' };
  const system = SYSTEM + (contextJson ? ('\n\nLIVE TRACKER (compact JSON, ground truth):\n' + String(contextJson).slice(0, 60000)) : '');
  try {
    const body = { model: MODEL, max_tokens: 2000, system, messages: (messages || []).slice(-16) };
    if (tools && tools.length) body.tools = tools;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: 'AI ' + r.status + ': ' + ((j.error && j.error.message) || JSON.stringify(j).slice(0, 200)) };
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    return { text: text || '', content: j.content || [], stop_reason: j.stop_reason || 'end_turn', model: MODEL, usage: j.usage || null };
  } catch (e) { return { error: 'AI request failed: ' + (e.message || e) }; }
}

module.exports = { ready, chat, MODEL };
