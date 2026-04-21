// ══ MONEYWIZE API — Universal Bank Statement Analyzer (v4) ══
// Claude Haiku 4.5, with robust error handling for any PDF.
// Requires env variable: ANTHROPIC_API_KEY
//
// Design goals:
// 1. Never crash silently — always return a helpful JSON response.
// 2. Partial success is OK — report what worked + what failed.
// 3. Respect user time — cap total work to stay under Vercel's 60s limit.
// 4. Guard against rate limits with concurrency cap + retry.
// 5. Surface clear, actionable error messages.

// ══ CONFIG ══
const MODEL               = 'claude-haiku-4-5-20251001';
const MAX_TOKENS          = 8000;
const CHUNK_SIZE          = 45000;        // chars per Claude call
const MAX_TOTAL_CHARS     = 400000;       // hard cap per file
const REJECT_ABOVE_CHARS  = 800000;       // reject & ask user to split
const CLAUDE_TIMEOUT_MS   = 45000;        // per-call timeout
const MAX_CONCURRENT      = 3;            // parallel Claude calls per request
const MAX_RETRIES         = 1;            // retry once on 429/529
const RETRY_DELAY_MS      = 1500;

// ══ TAXONOMY ══
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
   - HEALTH insurance (medical, health cover) → cat="expenses", sub="misc", type="insurance", avoidable=false
   - TRAVEL/HOME/OTHER insurance → cat="expenses", sub="misc", type="insurance", avoidable=false
   - Unspecified "LIVA INSURANCE", "ALLIANCE INSURANCE", "POLICY BAZAAR" → default expenses/misc/insurance UNLESS description clearly indicates life policy
   - Insurance REFUNDS/REIMBURSEMENTS → cat="income", type="insurance_reimbursement"

2. **Credit card bill payments** — BOTH directions go to "loans":
   - Bank statement: "CREDIT CARD PAYMNT", "CC PAYMENT" (debit) → cat="loans", sub="main", type="card_payment", avoidable=false, direction="DR"
   - Card statement: "PAYMENT RECEIVED", "PAYMENT - THANK YOU" (credit) → cat="loans", sub="main", type="card_payment_received", avoidable=false, direction="CR"

3. **Loan/EMI** — "INSTALLMENT RECOVERY", "EMI", "MORTGAGE" → cat="loans", sub="main", type="loan_installment"

4. **Inter-account transfers** (same name sender/receiver, e.g. "MBTRF B/O BASIL ABRAHAM"):
   - Credit → cat="income", sub="indirect", type="transfer_in"
   - Debit → cat="expenses", sub="misc", type="transfer_out", avoidable=false

5. **Government fees/fines** (ADB POLICE, SMARTDXB, TASJEEL, RTA, DMV) → cat="expenses", sub="transport", type="gov_services"

6. **Telecom/utility** (DU, ETISALAT, VIRGIN, E&, Verizon, AT&T) → cat="expenses", sub="shelter", type="internet_phone"

7. **Salary** always cat="income", sub="direct", type="salary", freq="monthly"
`.trim();

const EXTRACT_PROMPT = `You are a financial transaction analyzer. You receive raw text extracted from a bank or credit card statement (any country, any bank, any currency) and return clean structured transactions.

TASK: Extract every real transaction. Ignore headers, balances, summaries, totals, interest-rate disclosures, terms & conditions, cashback summary rows, and all boilerplate — only actual transactions.

For each transaction:
{
  "date": "YYYY-MM-DD",
  "merchant": cleaned description (strip ref numbers, card digits, transaction IDs),
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

GLOBAL MERCHANT GUIDE (use your knowledge):
- Starbucks/Costa/Tim Hortons → dining_out
- Shell/BP/ADNOC/ENOC/EPPCO/EMARAT/Exxon → fuel
- Netflix/Spotify/Disney+/Prime/Apple.com/iTunes → subscription
- Amazon/Noon/Flipkart/eBay → online_shopping
- Uber/Lyft/Ola/Careem → ride_hail
- Talabat/Deliveroo/DoorDash/Swiggy/Zomato/Noon Food → food_delivery
- Lulu/Carrefour/Spinneys/Waitrose/Tesco → supermarket
- SELFDRIVE/GLOMO (car rental) → car_rental, avoidable=false
- TAMARA/TABBY (BNPL) → online_shopping unless underlying purchase clear

OUTPUT: Return ONLY a valid JSON array. No preamble, no code fences, no commentary. If no transactions, return [].`;

// ══ TEXT CLEANING ══
function cleanStatementText(text) {
  if (!text) return '';
  let cleaned = text;

  // Strip non-Latin scripts (Arabic, Hebrew, Devanagari, CJK, etc.)
  cleaned = cleaned.replace(
    /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u0900-\u097F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g,
    ''
  );

  // Truncate at end-of-statement markers
  const endMarkers = [
    /\*{3,}\s*END\s*OF\s*STATEMENT\s*\*{3,}/i,
    /End\s*of\s*Transaction\s*Details/i,
  ];
  for (const m of endMarkers) {
    const pos = cleaned.search(m);
    if (pos > 0) { cleaned = cleaned.slice(0, pos); break; }
  }

  // Strip disclaimer blocks
  cleaned = cleaned.replace(/General Terms and Important Information[\s\S]*$/i, '');
  cleaned = cleaned.replace(/Terms\s+(and|&)\s+Conditions[\s\S]{200,}$/i, '');
  cleaned = cleaned.replace(/Important (Information|Notice|Disclaimer)[\s\S]{200,}$/i, '');
  cleaned = cleaned.replace(/Disclaimer[\s\S]{200,}$/i, '');

  // Strip URLs & emails
  cleaned = cleaned.replace(/https?:\/\/\S+/g, '');
  cleaned = cleaned.replace(/[\w.-]+@[\w.-]+\.\w+/g, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

// ══ CHUNK ON LINE BOUNDARIES ══
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

// ══ PARSE JSON ARRAY — tolerant of code fences + stray text ══
function parseJsonArray(raw) {
  if (!raw) return [];
  const clean = raw.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(clean.slice(start, end + 1)); }
  catch { return []; }
}

// ══ NORMALIZE TXN ══
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

// ══ SLEEP ══
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ══ CALL CLAUDE — with timeout + retry on transient errors ══
async function callClaude(text, filename, apiKey, chunkLabel = '', attempt = 1) {
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

    // Retry on rate-limit (429) or overload (529)
    if ((res.status === 429 || res.status === 529) && attempt <= MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      return callClaude(text, filename, apiKey, chunkLabel, attempt + 1);
    }

    if (!res.ok) {
      const errText = await res.text();
      const code = res.status;
      // Map common codes to actionable messages
      if (code === 401) throw new Error('auth_failed: API key invalid');
      if (code === 429) throw new Error('rate_limit: too many requests, please retry shortly');
      if (code === 529) throw new Error('overloaded: Anthropic servers busy, please retry');
      if (code >= 500) throw new Error(`server_error: Claude returned ${code}`);
      throw new Error(`claude_error: ${code} — ${errText.slice(0, 120)}`);
    }

    const data = await res.json();
    const raw = data?.content?.[0]?.text || '';
    return parseJsonArray(raw);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('timeout: Claude took >45s');
    throw err;
  }
}

// ══ RUN CHUNKS WITH CONCURRENCY CAP ══
async function runChunksConcurrent(chunks, filename, apiKey) {
  const results = new Array(chunks.length);
  const errors = new Array(chunks.length).fill(null);
  let idx = 0;

  async function worker() {
    while (idx < chunks.length) {
      const myIdx = idx++;
      const label = chunks.length > 1 ? `part ${myIdx + 1}/${chunks.length}` : '';
      try {
        results[myIdx] = await callClaude(chunks[myIdx], filename, apiKey, label);
      } catch (err) {
        console.error(`Chunk ${myIdx + 1} failed:`, err.message);
        errors[myIdx] = err.message;
        results[myIdx] = [];
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT, chunks.length);
  await Promise.all(Array.from({length: workerCount}, () => worker()));
  return {results, errors};
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
    const {action, text, filename} = req.body || {};

    if (action !== 'extract') {
      return res.status(400).json({
        error: 'bad_action',
        message: 'Unknown action. Expected "extract".',
      });
    }
    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'missing_text',
        message: 'No statement text provided. The PDF may be image-only or password-protected.',
      });
    }

    // ─── Pre-flight size check ───
    if (text.length > REJECT_ABOVE_CHARS) {
      return res.status(413).json({
        error: 'file_too_large',
        message: `This statement is very large (${Math.round(text.length / 1000)}k characters). Please split the PDF into smaller files (e.g. one statement per month) and re-upload.`,
        size_chars: text.length,
        limit_chars: REJECT_ABOVE_CHARS,
        suggestion: 'split_and_retry',
      });
    }

    // ─── Clean ───
    let cleaned = cleanStatementText(text);
    if (cleaned.length < 50) {
      return res.status(200).json({
        transactions: [],
        count: 0,
        filename,
        warning: 'This file contained very little readable text. It may be image-only, password-protected, or not a statement. Try OCR or a different PDF.',
      });
    }

    // Secondary cap (should rarely trigger given REJECT_ABOVE_CHARS check)
    const originalLen = cleaned.length;
    let truncated = false;
    if (cleaned.length > MAX_TOTAL_CHARS) {
      cleaned = cleaned.slice(0, MAX_TOTAL_CHARS);
      truncated = true;
    }

    // ─── Chunk ───
    const chunks = chunkText(cleaned);

    // ─── Extract with concurrency cap + retry ───
    const {results, errors} = await runChunksConcurrent(chunks, filename, apiKey);

    const chunksFailed = errors.filter(e => e).length;
    const chunksTotal = chunks.length;
    const chunksOk = chunksTotal - chunksFailed;

    // If ALL chunks failed, surface the first error properly
    if (chunksFailed === chunksTotal && chunksTotal > 0) {
      const firstErr = errors.find(e => e) || 'unknown error';
      const [code, detail] = firstErr.split(':').map(s => s.trim());
      return res.status(502).json({
        error: code || 'extraction_failed',
        message: detail || 'Could not extract transactions. Please retry.',
        chunks_total: chunksTotal,
        chunks_failed: chunksFailed,
      });
    }

    // ─── Normalize + dedupe ───
    // Dedupe key: date + amount + first 20 chars of merchant + direction
    // Allow up to 3 identical-key entries (legit repeats like 3 fuel fills same day)
    const all = results.flat().map(normalizeTxn).filter(t => t.date && t.amount > 0);
    const seen = new Map();
    const unique = [];
    for (const t of all) {
      const key = `${t.date}|${t.amount}|${t.merchant.slice(0, 20).toLowerCase()}|${t.direction}`;
      const count = seen.get(key) || 0;
      if (count < 3) {
        seen.set(key, count + 1);
        unique.push(t);
      }
    }

    // ─── Build response ───
    const response = {
      transactions: unique,
      count: unique.length,
      filename: filename || null,
      chunks_total: chunksTotal,
      chunks_ok: chunksOk,
      chunks_failed: chunksFailed,
    };

    // Partial-failure warning
    if (chunksFailed > 0) {
      response.warning = `${chunksFailed} of ${chunksTotal} sections of this file timed out or errored. The results may be incomplete. Consider splitting this file into smaller PDFs and re-uploading.`;
      response.suggestion = 'partial_split_recommended';
    }

    // Truncation warning (defensive — should not usually happen)
    if (truncated) {
      response.warning = (response.warning ? response.warning + ' Additionally, ' : '') +
        `this file was truncated at ${MAX_TOTAL_CHARS} characters (original was ${originalLen}). Please split it for complete analysis.`;
    }

    // Zero-transaction diagnostic
    if (unique.length === 0 && chunksFailed === 0) {
      response.warning = 'No transactions were found in this file. It may be a summary page, a marketing email, or an unsupported statement format.';
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({
      error: 'unexpected',
      message: err.message || 'An unexpected error occurred. Please retry.',
    });
  }
}
