// scripts/attio/ensure-inquiries-schema.mjs
// One-time, idempotent: creates the mentoring_ai_inquiries attributes that submit.ts writes but
// the list did not have. Safe to re-run: existing slugs are skipped.
// Run: set -a && source ~/.env && set +a && node scripts/attio/ensure-inquiries-schema.mjs
//
// WHY. Attio 400s the WHOLE entry create when the payload names one attribute the list does not
// have — it does not drop the unknown key and write the rest. submit.ts grew price_unit,
// sessions_total, effective_per_session_eur and offer_valid_until without the list growing with it,
// so every single write to mentoring_ai_inquiries failed and the list sat at zero entries while
// the offer emails went out fine. Found 2026-08-30 from Filip Prochazka's record.
//
// The list is text-typed throughout (list_price_eur, free_sessions, leaders_count are all text),
// and submit.ts String()s every number on the way in, so these match that convention rather than
// introducing the first number/date columns.
const TOKEN = process.env.ATTIO_TOKEN;
if (!TOKEN) throw new Error('ATTIO_TOKEN missing (set -a && source ~/.env && set +a)');
const H = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = (p, init) => fetch(`https://api.attio.com/v2${p}`, { headers: H, ...init }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${p} → ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
});

async function ensureAttr(target, slug, title, type) {
  const { data } = await api(`/${target}/attributes?limit=100`);
  if (data.some((a) => a.api_slug === slug)) return console.log('skip', slug);
  await api(`/${target}/attributes`, {
    method: 'POST',
    body: JSON.stringify({ data: { title, description: title, api_slug: slug, type, is_required: false, is_unique: false, is_multiselect: false, config: {} } }),
  });
  console.log('created', slug);
}

const LIST = 'lists/mentoring_ai_inquiries';
for (const [slug, title] of [
  // The four that were silently failing every write.
  ['price_unit', 'Price unit'],
  ['sessions_total', 'Sessions total'],
  ['effective_per_session_eur', 'Effective per session EUR'],
  ['offer_valid_until', 'Offer valid until'],
  // Never sent before: the free-text the visitor typed — payment preferences, urgency, the seat
  // they actually sit in. The most actionable line in the offer email and the one thing about
  // them that existed nowhere in the CRM.
  ['notes', 'Notes'],
]) await ensureAttr(LIST, slug, title, 'text');
console.log('done');
