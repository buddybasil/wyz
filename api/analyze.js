// ══ WYZ API — Universal Bank Statement Analyzer + Insights (v5) ══
// Claude Haiku 4.5. Two actions: "extract" (parse PDF text to txns) + "insight" (generate one sharp observation).
// Requires env variable: ANTHROPIC_API_KEY

const MODEL               = 'claude-haiku-4-5-20251001';
const MAX_TOKENS          = 8000;
const INSIGHT_MAX_TOKENS  = 400;
const CHUNK_SIZE          = 45000;
const MAX_TOTAL_CHARS     = 400000;
const REJECT_ABOVE_CHARS  = 800000;
const CLAUDE_TIMEOUT_MS   = 45000;
const INSIGHT_TIMEOUT_MS  = 20000;
const MAX_CONCURRENT      = 3;
const MAX_RETRIES         = 1;
const RETRY_DELAY_MS      = 1500;

// ══ TAXONOMY (same as v4) ══
const TAXONOMY_PROMPT = `
CATEGORIES (pick one as "cat"):
- "income"      → money coming in (salary, refunds, cashback, dividends, rental income, inter-account transfers IN)
- "expenses"    → real spending (consumption — food, fuel, rent, utilities, insurance, healthcare, etc.)
- "investments" → capital build-up (stocks, gold, mutual funds, crypto, retirement, life-insurance premiums with surrender value)
- "loans"       → credit card bill payments (both directions) and loan/EMI/mortgage payments

SUB-CATEGORIES:
- If cat="income":      "direct" (salary/wages only) OR "indirect" (everything else)
- If cat="expenses":    "food" | "shelter" | "transport" | "fees" | "misc"
- If cat="investments": always "all"
- If cat="loans":       always "main"

TYPE:
- Food:      supermarket, food_delivery, dining_out, convenience_store
- Shelter:   rent, utilities, internet_phone, maintenance
- Transport: fuel, toll, parking, ride_hail, car_rental, public_transport, gov_services, vehicle_service
- Fees:      bank_fee, late_fee, overlimit_fee, forex_fee, annual_fee, school_tuition
- Misc:      subscription, online_shopping, healthcare, entertainment, travel,
             personal_care, clothing, electronics, cash_withdrawal, insurance,
             transfer_out, other
- Income:    salary, bonus, cashback, dividend, refund, rental_income,
             insurance_reimbursement, savings_profit, interest, transfer_in, other_income
- Investment: equity, gold, life_insurance, mutual_fund, crypto, bond, retirement
- Loan:      card_payment, card_payment_received, loan_installment, mortgage_payment

FREQUENCY: "monthly" | "weekly" | "quarterly" | "annual" | "adhoc"

AVOIDABLE (true/false): Set true ONLY for clearly discretionary spending:
- food_delivery, dining_out
- ride_hail (when not essential)
- entertainment, most subscriptions
- non-essential online_shopping, clothing
Set false for essentials: groceries, fuel, rent, utilities, healthcare, education, insurance, all loans, all income, all investments.

CRITICAL CLASSIFICATION RULES:

1. **Insurance** — distinguish carefully:
   - LIFE insurance (Zurich Life, Aviva, MetLife, LIC, HDFC Life, Sukoon Life) → cat="investments", type="life_insurance"
   - MOTOR insurance (NEXT CAR, car insurance, auto insurance) → cat="expenses", sub="misc", type="insurance", avoidable=false
   - HEALTH insurance → cat="expenses", sub="misc", type="insurance", avoidable=false
   - TRAVEL/HOME/OTHER insurance → cat="expenses", sub="misc", type="insurance", avoidable=false
   - Unspecified "LIVA", "ALLIANCE INSURANCE", "POLICY BAZAAR" → default expenses/misc/insurance UNLESS clearly life
   - Insurance REFUNDS → cat="income", type="insurance_reimbursement"

2. **Credit card bill payments** — BOTH directions go to "loans":
   - Bank: "CREDIT CARD PAYMNT", "CC PAYMENT" (debit) → cat="loans", type="card_payment", direction="DR"
   - Card: "PAYMENT RECEIVED", "PAYMENT - THANK YOU" (credit) → cat="loans", type="card_payment_received", direction="CR"

3. **Loan/EMI** — "INSTALLMENT RECOVERY", "EMI", "MORTGAGE" → cat="loans", type="loan_installment"

4. **Inter-account transfers** (same name sender/receiver):
   - CR → cat="income", sub="indirect", type="transfer_in"
   - DR → cat="expenses", sub="misc", type="transfer_out"

5. **Gov fees/fines** (POLICE, SMARTDXB, TASJEEL, RTA, DMV) → cat="expenses", sub="transport", type="gov_services"

6. **Telecom/utility** (DU, ETISALAT, VIRGIN, E&, Verizon, AT&T) → cat="expenses", sub="shelter", type="internet_phone"

7. **Salary** always cat="income", sub="direct", type="salary", freq="monthly"
`.trim();

const EXTRACT_PROMPT = `You are a financial transaction analyzer. You receive raw text from a bank/credit-card statement (any country/bank/currency) and return clean structured transactions.

TASK: Extract every real transaction. Ignore headers, balances, summaries, totals, interest-rate disclosures, T&Cs, cashback rollup rows, and all boilerplate.

Each transaction:
{
  "date": "YYYY-MM-DD",
  "merchant": cleaned description (strip ref numbers, card digits, tx IDs),
  "amount": positive number (no currency symbol),
  "currency": ISO code,
  "direction": "CR" (in) or "DR" (out),
  "cat": category,
  "sub": sub-category,
  "type": type,
  "freq": frequency,
  "avoidable": boolean,
  "note": short context (<=40 chars) or null
}

${TAXONOMY_PROMPT}

GLOBAL MERCHANT GUIDE:
- Starbucks/Costa/Tim Hortons → dining_out
- Shell/BP/ADNOC/ENOC/EPPCO/EMARAT/Exxon → fuel
- Netflix/Spotify/Disney+/Prime/Apple.com/iTunes → subscription
- Amazon/Noon/Flipkart → online_shopping
- Uber/Lyft/Ola/Careem → ride_hail
- Talabat/Deliveroo/DoorDash/Swiggy/Zomato → food_delivery
- Lulu/Carrefour/Spinneys/Waitrose/Tesco → supermarket
- SELFDRIVE/GLOMO (car rental) → car_rental, avoidable=false
- TAMARA/TABBY (BNPL) → online_shopping

OUTPUT: JSON array only. No preamble, no code fences. If none, return [].`;

// ══ INSIGHT PROMPT — tuned for short, specific, behaviorally-useful observations ══
const INSIGHT_PROMPT = `You are a thoughtful financial coach. Given a user's categorized spending summary, write ONE single observation that will stick with them psychologically before their next spending decision.

RULES — these matter:
1. Be SPECIFIC: name amounts and merchants, not categories. "AED 847 on Talabat" not "you spend a lot on food."
2. Be COMPARATIVE: compare to the past self or to income, never to strangers or national averages.
3. Be ACTIONABLE: hint at the next decision they'll face, don't lecture.
4. Be KIND: no shame, no "you should," no moralizing. Treat the user as an intelligent adult.
5. Be BRIEF: 2-3 sentences max, plain language, no financial jargon.
6. Find what's actually INTERESTING, not what's obvious. Don't say "your biggest category is food." Say something they didn't notice.
7. If there is nothing surprising, say something encouraging and honest ("Your spending looks steady month-over-month — biggest line is rent at X.") — do NOT invent drama.

OUTPUT FORMAT — return ONLY a JSON object, no preamble:
{
  "headline": "The one sentence that matters, max ~120 chars",
  "detail": "Optional 1-sentence expansion with the specific number/math, max ~180 chars",
  "tone": "neutral" | "warning" | "encouraging"
}

The headline is the critical piece — it's what the user will remember.`;

// ══ TEXT CLEANING ══
function cleanStatementText(text) {
  if (!text) return '';
  let cleaned = text;
  cleaned = cleaned.replace(
    /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u0900-\u097F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g,
    ''
  );
  const endMarkers = [
    /\*{3,}\s*END\s*OF\s*STATEMENT\s*\*{3,}/i,
    /End\s*of\s*Transaction\s*Details/i,
  ];
  for (const m of endMarkers) {
    const pos = cleaned.search(m);
    if (pos > 0) { cleaned = cleaned.slice(0, pos); break; }
  }
  cleaned = cleaned.replace(/General Terms and Important Information[\s\S]*$/i, '');
  cleaned = cleaned.replace(/Terms\s+(and|&)\s+Conditions[\s\S]{200,}$/i, '');
  cleaned = cleaned.replace(/Important (Information|Notice|Disclaimer)[\s\S]{200,}$/i, '');
  cleaned = cleaned.replace(/Disclaimer[\s\S]{200,}$/i, '');
  cleaned = cleaned.replace(/https?:\/\/\S+/g, '');
  cleaned = cleaned.replace(/[\w.-]+@[\w.-]+\.\w+/g, '');
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function chunkText(text, size = CHUNK_SIZE) {
  if (text.length <= size) return [text];
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > size && current.length > 0) {
      chunks.push(current); current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseJsonArray(raw) {
  if (!raw) return [];
  const clean = raw.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { return []; }
}

function parseJsonObject(raw) {
  if (!raw) return null;
  const clean = raw.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { return null; }
}

const VALID_EXP_SUBS = new Set(['food', 'shelter', 'transport', 'fees', 'misc']);
const VALID_CATS = new Set(['income', 'expenses', 'investments', 'loans']);

function normalizeTxn(t) {
  const direction = (t.direction || '').toUpperCase() === 'CR' ? 'CR' : 'DR';
  let cat = VALID_CATS.has(t.cat) ? t.cat : (direction === 'CR' ? 'income' : 'expenses');
  let sub = t.sub;
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
    cat, sub,
    type: t.type || 'other',
    freq: t.freq || 'adhoc',
    avoidable: Boolean(t.avoidable),
    note: t.note || null,
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ══ CLAUDE CALL (shared, with timeout + retry) ══
async function callClaude({prompt, userContent, apiKey, maxTokens, timeoutMs, attempt = 1}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        max_tokens: maxTokens,
        messages: [{role: 'user', content: `${prompt}\n\n${userContent}`}],
      }),
    });
    clearTimeout(timer);
    if ((res.status === 429 || res.status === 529) && attempt <= MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      return callClaude({prompt, userContent, apiKey, maxTokens, timeoutMs, attempt: attempt + 1});
    }
    if (!res.ok) {
      const errText = await res.text();
      const code = res.status;
      if (code === 401) throw new Error('auth_failed: API key invalid');
      if (code === 429) throw new Error('rate_limit: too many requests');
      if (code === 529) throw new Error('overloaded: Anthropic servers busy');
      if (code >= 500) throw new Error(`server_error: ${code}`);
      throw new Error(`claude_error: ${code} — ${errText.slice(0, 120)}`);
    }
    const data = await res.json();
    return data?.content?.[0]?.text || '';
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('timeout: Claude took too long');
    throw err;
  }
}

// ══ EXTRACT: run chunks with concurrency cap ══
async function runChunksConcurrent(chunks, filename, apiKey) {
  const results = new Array(chunks.length);
  const errors = new Array(chunks.length).fill(null);
  const rawSamples = new Array(chunks.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < chunks.length) {
      const myIdx = idx++;
      const label = chunks.length > 1 ? `part ${myIdx + 1}/${chunks.length}` : '';
      try {
        const raw = await callClaude({
          prompt: EXTRACT_PROMPT,
          userContent: `File: ${filename || 'statement.pdf'}${label ? ` (${label})` : ''}\n\nStatement text:\n${chunks[myIdx]}`,
          apiKey,
          maxTokens: MAX_TOKENS,
          timeoutMs: CLAUDE_TIMEOUT_MS,
        });
        const parsed = parseJsonArray(raw);
        results[myIdx] = parsed;
        rawSamples[myIdx] = {
          raw_length: raw.length,
          raw_start: raw.slice(0, 200),
          raw_end: raw.slice(-200),
          parsed_count: parsed.length,
        };
        console.log(`Chunk ${myIdx + 1}/${chunks.length}: raw=${raw.length} chars, parsed=${parsed.length} txns. Start: ${raw.slice(0, 100).replace(/\n/g, ' ')}`);
      } catch (err) {
        console.error(`Chunk ${myIdx + 1} failed:`, err.message);
        errors[myIdx] = err.message;
        results[myIdx] = [];
      }
    }
  }
  const workerCount = Math.min(MAX_CONCURRENT, chunks.length);
  await Promise.all(Array.from({length: workerCount}, () => worker()));
  return {results, errors, rawSamples};
}

// ══ HANDLER: extract action ══
async function handleExtract(req, res, apiKey) {
  const {text, filename} = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      error: 'missing_text',
      message: 'No statement text provided. The PDF may be image-only or password-protected.',
    });
  }
  if (text.length > REJECT_ABOVE_CHARS) {
    return res.status(413).json({
      error: 'file_too_large',
      message: `This statement is very large (${Math.round(text.length / 1000)}k characters). Please split the PDF into smaller files and re-upload.`,
      size_chars: text.length,
      limit_chars: REJECT_ABOVE_CHARS,
      suggestion: 'split_and_retry',
    });
  }
  let cleaned = cleanStatementText(text);
  if (cleaned.length < 50) {
    return res.status(200).json({
      transactions: [], count: 0, filename,
      warning: 'This file contained very little readable text. It may be image-only, password-protected, or not a statement.',
    });
  }
  const originalLen = cleaned.length;
  let truncated = false;
  if (cleaned.length > MAX_TOTAL_CHARS) {
    cleaned = cleaned.slice(0, MAX_TOTAL_CHARS);
    truncated = true;
  }
  const chunks = chunkText(cleaned);
  console.log(`Extract request: filename=${filename}, text_len=${(text||'').length}`);
  const {results, errors, rawSamples} = await runChunksConcurrent(chunks, filename, apiKey);
  const chunksFailed = errors.filter(e => e).length;
  const chunksTotal = chunks.length;
  const chunksOk = chunksTotal - chunksFailed;
  if (chunksFailed === chunksTotal && chunksTotal > 0) {
    const firstErr = errors.find(e => e) || 'unknown error';
    const [code, detail] = firstErr.split(':').map(s => s.trim());
    return res.status(502).json({
      error: code || 'extraction_failed',
      message: detail || 'Could not extract transactions. Please retry.',
      chunks_total: chunksTotal, chunks_failed: chunksFailed,
    });
  }
  const all = results.flat().map(normalizeTxn).filter(t => t.date && t.amount > 0);
  const seen = new Map();
  const unique = [];
  for (const t of all) {
    const key = `${t.date}|${t.amount}|${t.merchant.slice(0, 20).toLowerCase()}|${t.direction}`;
    const count = seen.get(key) || 0;
    if (count < 3) { seen.set(key, count + 1); unique.push(t); }
  }
  const response = {
    transactions: unique, count: unique.length, filename: filename || null,
    chunks_total: chunksTotal, chunks_ok: chunksOk, chunks_failed: chunksFailed,
  };
  if (chunksFailed > 0) {
    // Surface the actual underlying error messages so users/devs can diagnose
    const errSamples = errors.filter(e => e).slice(0, 3);
    const errSummary = errSamples.map(e => e.split(':')[0]).join(', ');
    response.warning = `${chunksFailed} of ${chunksTotal} sections failed (${errSummary}). Results may be incomplete — consider splitting this file.`;
    response.error_details = errSamples;
    response.suggestion = 'partial_split_recommended';
  }
  if (truncated) {
    response.warning = (response.warning ? response.warning + ' Additionally, ' : '') +
      `this file was truncated at ${MAX_TOTAL_CHARS} chars (original was ${originalLen}). Split for complete analysis.`;
  }
  if (unique.length === 0 && chunksFailed === 0) {
    // Chunk succeeded but produced zero parseable transactions — usually a summary/non-statement page
    response.warning = 'No transactions were found in this file. It may be a summary page, cover page, or unsupported statement format.';
    response.diagnostic = {
      cleaned_chars: cleaned.length,
      chunks_processed: chunksTotal,
      sample_text: cleaned.slice(0, 200),
      claude_samples: rawSamples,
    };
    console.log('Zero txns returned. Raw samples:', JSON.stringify(rawSamples));
  }
  return res.status(200).json(response);
}

// ══ HANDLER: insight action ══
async function handleInsight(req, res, apiKey) {
  const {summary} = req.body || {};
  if (!summary || typeof summary !== 'object') {
    return res.status(400).json({
      error: 'missing_summary',
      message: 'No summary data provided.',
    });
  }
  // Build a compact user-facing summary string for Claude
  const userContent = `Spending summary (${summary.period || 'recent period'}):

Income:        AED ${summary.totals?.income || 0}
Expenses:      AED ${summary.totals?.expenses || 0}
Investments:   AED ${summary.totals?.investments || 0}
Loan/card pmt: AED ${summary.totals?.loans || 0}
Net surplus:   AED ${(summary.totals?.income || 0) - (summary.totals?.expenses || 0) - (summary.totals?.investments || 0) - (summary.totals?.loans || 0)} over ${summary.months || 1} months

Top expenses by merchant (${summary.top_merchants?.length || 0}):
${(summary.top_merchants || []).slice(0, 15).map(m => `- ${m.merchant}: AED ${m.total} (${m.count}x, ${m.category})`).join('\n')}

Spend by sub-category:
${Object.entries(summary.by_sub || {}).map(([k, v]) => `- ${k}: AED ${v}`).join('\n')}

Avoidable spending total: AED ${summary.avoidable_total || 0} across ${summary.avoidable_count || 0} transactions.

${summary.month_over_month ? `Month-over-month: ${summary.month_over_month}` : ''}

Now write ONE observation per the rules.`;

  try {
    const raw = await callClaude({
      prompt: INSIGHT_PROMPT,
      userContent,
      apiKey,
      maxTokens: INSIGHT_MAX_TOKENS,
      timeoutMs: INSIGHT_TIMEOUT_MS,
    });
    const obj = parseJsonObject(raw);
    if (!obj || !obj.headline) {
      return res.status(200).json({
        headline: null,
        detail: null,
        tone: 'neutral',
        warning: 'Could not generate insight — please try again',
      });
    }
    return res.status(200).json({
      headline: String(obj.headline).slice(0, 200),
      detail: obj.detail ? String(obj.detail).slice(0, 250) : null,
      tone: ['neutral', 'warning', 'encouraging'].includes(obj.tone) ? obj.tone : 'neutral',
    });
  } catch (err) {
    console.error('Insight error:', err.message);
    return res.status(200).json({
      headline: null,
      detail: null,
      tone: 'neutral',
      warning: err.message,
    });
  }
}

// ══ MAIN HANDLER ══
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({error: 'method_not_allowed', message: 'Use POST'});

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'config_missing',
      message: 'Server not configured. Please contact support.',
    });
  }

  try {
    const action = req.body?.action;
    if (action === 'extract') return await handleExtract(req, res, apiKey);
    if (action === 'insight') return await handleInsight(req, res, apiKey);
    return res.status(400).json({
      error: 'bad_action',
      message: 'Unknown action. Expected "extract" or "insight".',
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({
      error: 'unexpected',
      message: err.message || 'An unexpected error occurred. Please retry.',
    });
  }
}
