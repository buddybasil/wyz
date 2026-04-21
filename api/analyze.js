// ══ MONEYWIZE API — Universal Bank Statement Analyzer ══
// Powered by Claude Haiku 4.5. Works with any bank, any country, any currency.
// Categorization is done by Claude using an enforced taxonomy — no hardcoded
// merchant rules. This means new banks / new markets work out of the box.
// Requires env variable: ANTHROPIC_API_KEY

// ── CONFIG ──
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 8000;
const CHUNK_SIZE = 45000;        // chars per Claude call
const MAX_TOTAL_CHARS = 400000;  // hard sanity cap
const CLAUDE_TIMEOUT_MS = 45000; // per-call timeout (Vercel cap is 60s total)

// ══ TAXONOMY ══
// These values are ENFORCED — Claude must pick from them. This keeps
// categorization consistent across all banks and statements, which is
// what makes the dashboard groupings meaningful.
const TAXONOMY_PROMPT = `
CATEGORIES (pick one as "cat"):
- "income"      → money coming in (salary, refunds, cashback, dividends, rental income)
- "expenses"    → any spending
- "investments" → stocks, gold, mutual funds, life insurance premiums, crypto
- "loans"       → credit card bill payments, EMIs, mortgage payments

SUB-CATEGORIES (pick based on cat):
- If cat="income":      "direct" (salary/wages only) OR "indirect" (everything else)
- If cat="expenses":    "food" | "shelter" | "transport" | "fees" | "misc"
- If cat="investments": always "all"
- If cat="loans":       always "main"

TYPE (specific classification — pick the closest match):
- Food:      supermarket, food_delivery, dining_out, convenience_store
- Shelter:   rent, utilities, internet_phone, maintenance
- Transport: fuel, toll, parking, ride_hail, car_rental, public_transport, gov_services, vehicle_service
- Fees:      bank_fee, late_fee, overlimit_fee, forex_fee, annual_fee, school_tuition
- Misc:      subscription, online_shopping, healthcare, entertainment, travel,
             personal_care, education, clothing, electronics, cash_withdrawal, transfer, other
- Income:    salary, bonus, cashback, dividend, refund, rental_income,
             insurance_reimbursement, savings_profit, interest, other_income
- Investment: equity, gold, life_insurance, mutual_fund, crypto, bond, retirement
- Loan:      card_payment, loan_installment, mortgage_payment

FREQUENCY: "monthly" | "weekly" | "quarterly" | "annual" | "adhoc"

AVOIDABLE (true/false): Set true ONLY for clearly discretionary spending:
- food_delivery, dining_out
- ride_hail (when not essential)
- entertainment, most subscriptions
- non-essential online_shopping, clothing
Set false for essentials: groceries, fuel, rent, utilities, healthcare, education, insurance.
`.trim();

const EXTRACT_PROMPT = `You are a financial transaction analyzer. You receive raw text extracted from a bank or credit card statement (any country, any bank, any currency) and return clean structured transactions.

TASK: Extract every real transaction. Ignore headers, balances, summaries, totals, interest-rate disclosures, terms & conditions, and all other boilerplate — only return actual transactions.

For each transaction, return a JSON object:
{
  "date": "YYYY-MM-DD",
  "merchant": cleaned description (strip ref numbers, card digits, long transaction IDs),
  "amount": positive number (no currency symbol),
  "currency": ISO code (AED, USD, INR, GBP, EUR, etc.),
  "direction": "CR" for money IN, "DR" for money OUT,
  "cat": category from taxonomy,
  "sub": sub-category from taxonomy,
  "type": specific type from taxonomy,
  "freq": frequency from taxonomy,
  "avoidable": true or false,
  "note": short context (<=40 chars) or null
}

${TAXONOMY_PROMPT}

IMPORTANT RULES:
1. Use your knowledge of global merchants to categorize correctly:
   - Starbucks/Costa/Tim Hortons → dining_out
   - Shell/BP/ADNOC/ENOC/Exxon → fuel
   - Netflix/Spotify/Disney+/Prime → subscription
   - HDFC Life/Zurich Life/Aviva/MetLife → investments, life_insurance
   - Amazon/Noon/Flipkart/eBay → online_shopping
   - Uber/Lyft/Ola/Careem → ride_hail
   - Talabat/Deliveroo/DoorDash/Swiggy → food_delivery
2. For unfamiliar merchants, infer category from context clues in the description.
3. Internal transfers between a user's own accounts: if clearly a credit-card bill payment, use loans/main/card_payment; otherwise expenses/misc/transfer with avoidable=false.
4. Salary credits are always income/direct/salary/monthly/false.
5. Installment / EMI recoveries are always loans/main/loan_installment/monthly/false.
6. If currency is unclear from context, use "AED" as default for Middle East statements, else infer.

OUTPUT: Return ONLY a valid JSON array. No preamble, no code fences, no commentary. If you find no transactions, return [].`;

// ══ TEXT PRE-PROCESSING ══
// Strips boilerplate and non-Latin scripts so we don't waste tokens.
// Works for statements in any language — non-Latin is dropped wholesale,
// Latin boilerplate is pattern-matched generically.
function cleanStatementText(text) {
  if (!text) return '';
  let cleaned = text;

  // 1. Strip non-Latin scripts (Arabic, Hebrew, Devanagari, CJK, Korean, Thai, etc.)
  //    These appear in statements from UAE, Israel, India, China, Japan, Korea, Thailand
  cleaned = cleaned.replace(
    /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u0900-\u097F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g,
    ''
  );

  // 2. Truncate at end-of-statement markers (reliable boundary across banks)
  const endMarkers = [
    /\*{3,}\s*END\s*OF\s*STATEMENT\s*\*{3,}/i,
    /End\s*of\s*Transaction\s*Details/i,
    /\*{3,}\s*End\s*of\s*Statement\s*\*{3,}/i,
  ];
  for (const marker of endMarkers) {
    const pos = cleaned.search(marker);
    if (pos > 0) { cleaned = cleaned.slice(0, pos); break; }
  }

  // 3. Remove terms & conditions / disclaimer blocks (always at the end)
  cleaned = cleaned.replace(/General Terms and Important Information[\s\S]*$/i, '');
  cleaned = cleaned.replace(/Terms\s+(and|&)\s+Conditions[\s\S]{200,}$/i, '');
  cleaned = cleaned.replace(/Important (Information|Notice|Disclaimer)[\s\S]{200,}$/i, '');
  cleaned = cleaned.replace(/Disclaimer[\s\S]{200,}$/i, '');

  // 4. Strip URLs, emails, long phone numbers
  cleaned = cleaned.replace(/https?:\/\/\S+/g, '');
  cleaned = cleaned.replace(/[\w.-]+@[\w.-]+\.\w+/g, '');

  // 5. Normalize whitespace
  cleaned = cleaned.replace(/[ \t]+/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.trim();

  return cleaned;
}

// ══ CHUNK LONG TEXT (respects line boundaries so transactions aren't split) ══
function chunkText(text, size = CHUNK_SIZE) {
  if (text.length <= size) return [text];
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > size && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ══ CORS ══
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ══ PARSE JSON ARRAY from Claude (tolerates code fences and stray text) ══
function parseJsonArray(raw) {
  if (!raw) return [];
  const clean = raw.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { return []; }
}

// ══ NORMALIZE TXN — enforce taxonomy, fill defaults, protect the frontend ══
const VALID_EXP_SUBS = new Set(['food', 'shelter', 'transport', 'fees', 'misc']);
const VALID_CATS = new Set(['income', 'expenses', 'investments', 'loans']);

function normalizeTxn(t) {
  const direction = (t.direction || '').toUpperCase() === 'CR' ? 'CR' : 'DR';
  let cat = VALID_CATS.has(t.cat) ? t.cat : (direction === 'CR' ? 'income' : 'expenses');
  let sub = t.sub;

  // Enforce sub values (matches v10 frontend's CATS structure)
  if (cat === 'investments')      sub = 'all';
  else if (cat === 'loans')       sub = 'main';
  else if (cat === 'income')      sub = (sub === 'direct' ? 'direct' : 'indirect');
  else if (cat === 'expenses')    sub = VALID_EXP_SUBS.has(sub) ? sub : 'misc';

  return {
    date: t.date || null,
    merchant: String(t.merchant || 'Unknown').slice(0, 120),
    amount: Number(t.amount) || 0,
    currency: t.currency || 'AED',
    direction,
    cat,
    sub,
    type: t.type || 'other',
    freq: t.freq || 'adhoc',
    avoidable: Boolean(t.avoidable),
    note: t.note || null,
  };
}

// ══ CALL CLAUDE (one chunk, with timeout) ══
async function callClaude(text, filename, apiKey, chunkLabel = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: `${EXTRACT_PROMPT}\n\nFile: ${filename || 'statement.pdf'}${chunkLabel ? ` (${chunkLabel})` : ''}\n\nStatement text:\n${text}`,
        }],
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = data?.content?.[0]?.text || '';
    return parseJsonArray(raw);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Claude timeout (>45s)');
    throw err;
  }
}

// ══ MAIN HANDLER ══
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({error: 'Method not allowed'});

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({error: 'ANTHROPIC_API_KEY not configured in Vercel'});

  try {
    const {action, text, filename} = req.body || {};
    if (action !== 'extract')                  return res.status(400).json({error: 'Unknown action'});
    if (!text || typeof text !== 'string')     return res.status(400).json({error: 'Missing "text" field'});

    // 1. Clean
    let cleaned = cleanStatementText(text);
    if (cleaned.length < 50) {
      return res.status(200).json({transactions: [], count: 0, filename, note: 'No extractable content'});
    }
    if (cleaned.length > MAX_TOTAL_CHARS) cleaned = cleaned.slice(0, MAX_TOTAL_CHARS);

    // 2. Chunk
    const chunks = chunkText(cleaned);

    // 3. Extract in parallel (fail-soft per chunk — one failure doesn't kill all)
    const results = await Promise.all(chunks.map((c, i) =>
      callClaude(c, filename, apiKey, chunks.length > 1 ? `part ${i + 1}/${chunks.length}` : '')
        .catch(err => {
          console.error(`Chunk ${i + 1} failed:`, err.message);
          return [];
        })
    ));

    // 4. Merge, normalize, dedupe (date + amount + merchant)
    const all = results.flat().map(normalizeTxn).filter(t => t.date && t.amount > 0);
    const seen = new Set();
    const unique = all.filter(t => {
      const key = `${t.date}|${t.amount}|${t.merchant.slice(0, 30)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({
      transactions: unique,
      count: unique.length,
      filename: filename || null,
      chunks: chunks.length,
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({error: err.message || 'Unexpected error'});
  }
}
