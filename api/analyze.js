// ══ WYZ API — Universal Bank Statement Analyzer + Insights (v6) ══
// Claude Haiku 4.5. Two actions: "extract" (parse PDF text to txns) + "insight" (generate one sharp observation).
// v6 change: merchant field is now captured VERBATIM from the source PDF — no
// stripping of ref numbers, card digits, or tx IDs. This makes it easier for
// users to verify each row against the original statement.
// Requires env variable: ANTHROPIC_API_KEY

const MODEL               = 'claude-haiku-4-5-20251001';
const MAX_TOKENS          = 16000;
const INSIGHT_MAX_TOKENS  = 400;
const CHUNK_SIZE          = 45000;
const MAX_TOTAL_CHARS     = 400000;
const REJECT_ABOVE_CHARS  = 800000;
const CLAUDE_TIMEOUT_MS   = 45000;
const INSIGHT_TIMEOUT_MS  = 20000;
const MAX_CONCURRENT      = 3;
const MAX_RETRIES         = 1;
const RETRY_DELAY_MS      = 1500;

// ══ TAXONOMY ══
const TAXONOMY_PROMPT = `
CATEGORIES (pick one as "cat"):
- "income"              → money coming in (salary, refunds, cashback, dividends, rental income, transfers IN)
- "expenses"            → real consumption (food, fuel, rent, utilities, insurance, healthcare, etc.)
- "savings_investments" → money set aside for later (savings deposits, emergency fund, life insurance, stocks, retirement, crypto, gold)
- "loans"               → credit card bill payments (both directions) and loan/EMI/mortgage payments

SUB-CATEGORIES:
- If cat="income":              "direct" (salary/wages) OR "indirect" (everything else)
- If cat="expenses":            "food" | "shelter" | "transport" | "fees" | "misc"
- If cat="savings_investments": "liquid" (cash-accessible: savings deposits, emergency fund, money market)
                                OR "committed" (locked-in growth: life insurance, stocks, retirement, crypto, gold)
- If cat="loans":               always "main"

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
- Savings/Investments: savings_deposit, emergency_fund, equity, gold, life_insurance, mutual_fund, crypto, bond, retirement
- Loan:      card_payment, card_payment_received, loan_installment, mortgage_payment

FREQUENCY: "monthly" | "weekly" | "quarterly" | "annual" | "adhoc"

CRITICAL CLASSIFICATION RULES:

1. **Insurance** — distinguish carefully:
   - LIFE insurance with cash/surrender value (Zurich Life, Aviva, MetLife, LIC, HDFC Life, Sukoon Life) → cat="savings_investments", sub="committed", type="life_insurance"
   - MOTOR insurance (NEXT CAR, car insurance, auto insurance) → cat="expenses", sub="misc", type="insurance"
   - HEALTH insurance → cat="expenses", sub="misc", type="insurance"
   - TRAVEL/HOME/OTHER insurance → cat="expenses", sub="misc", type="insurance"
   - Unspecified "LIVA", "ALLIANCE INSURANCE", "POLICY BAZAAR" → default expenses/misc/insurance UNLESS clearly life
   - Insurance REFUNDS → cat="income", type="insurance_reimbursement"

2. **Credit card bill payments** — BOTH directions go to "loans":
   - Bank: "CREDIT CARD PAYMNT", "CC PAYMENT" (debit) → cat="loans", type="card_payment", direction="DR"
   - Card: "PAYMENT RECEIVED", "PAYMENT - THANK YOU" (credit) → cat="loans", type="card_payment_received", direction="CR"

3. **Loan/EMI** — "INSTALLMENT RECOVERY", "EMI", "MORTGAGE" → cat="loans", type="loan_installment"

4. **Transfers between accounts** — capture but classify conservatively:
   - DR (money out to another party/account): default cat="expenses", sub="misc", type="transfer_out"
   - CR (money in from another party): cat="income", sub="indirect", type="transfer_in"
   - **Self-transfer flag**: if you can identify the account holder's own name from the statement
     header (e.g. "MR BASIL ABRAHAM" at the top), and a DR transfer goes to that SAME name,
     add a "possibly_self_transfer": true field (as an extra JSON field). Do NOT auto-move it — let the
     user decide whether it's actually a savings transfer or a payment to someone else with
     the same name. The flag is a hint, not a verdict.

5. **Gov fees/fines** (POLICE, SMARTDXB, TASJEEL, RTA, DMV) → cat="expenses", sub="transport", type="gov_services"

6. **Telecom/utility** (DU, ETISALAT, VIRGIN, E&, Verizon, AT&T) → cat="expenses", sub="shelter", type="internet_phone"

7. **Salary** always cat="income", sub="direct", type="salary", freq="monthly"

8. **Explicit savings deposits** — labeled "SAVINGS", "FIXED DEPOSIT", "FD", "TERM DEPOSIT" → cat="savings_investments", sub="liquid", type="savings_deposit"
`.trim();

const EXTRACT_PROMPT = `You are a financial transaction analyzer. You receive raw text from a bank or credit-card statement (any country, any bank, any currency) and return clean structured transactions.

═══ THE CORE RULE (this is all that matters) ═══

**A line is a transaction if — and only if — it has:**
  (a) a DATE, AND
  (b) a DEBIT or CREDIT AMOUNT greater than zero (not 0.00, not blank).

**Capture every such line.** If in doubt, capture it — the user can delete it later. Do NOT filter for "real" vs "fee" vs "reversal" — any line with a date + non-zero amount is in scope.

**Skip only these (they are NEVER transactions):**
- Opening balance / Closing balance rows
- Sub-totals, page totals, "Total debits", "Total credits"
- Column headers (e.g. repeating "Posting Date / Description / Amount" rows)
- T&Cs, disclaimers, footnotes, marketing text
- Rows where BOTH debit and credit columns are 0.00 or blank

**Important — capture these too (they ARE transactions by the core rule):**
- Bank fees (FOREIGN TRANSACTION FEE, LATE PAYMENT FEE, OVERLIMIT FEE, ANNUAL FEE) → expenses/fees
- Interest charges and interest earned
- Government fees, traffic fines, RTA, SMARTDXB, TASJEEL → expenses/transport/gov_services
- Insurance premiums of any kind
- Credit card payments (both directions — bank→card debit AND card side credit) → loans
- Inter-account transfers between the user's own accounts → transfer_in / transfer_out
- Small amounts — any amount > 0 is captured

═══ OUTPUT ═══

For each transaction return this JSON object:
{
  "date": "YYYY-MM-DD",
  "merchant": THE FULL DESCRIPTION EXACTLY AS IT APPEARS IN THE STATEMENT — preserve every word, reference number, card digit, transaction ID, location code, and identifier from the source row. Only collapse runs of whitespace into single spaces and trim leading/trailing whitespace. DO NOT shorten, summarize, paraphrase, normalize, or "clean up" the description. The user is using this field to cross-check rows against the original PDF — exact verbatim wording matters.
  "amount": positive number (no currency symbol, must be > 0),
  "currency": ISO code (AED, USD, INR, GBP, EUR, etc.),
  "direction": "CR" for money IN, "DR" for money OUT,
  "cat": category from taxonomy below,
  "sub": sub-category,
  "type": specific type,
  "freq": frequency,
  "note": short context (<=40 chars) or null,
  "possibly_self_transfer": true | false | null  (include only when flagging a DR transfer to the holder's own name; omit otherwise)
}

IMPORTANT — MERCHANT FIELD: The merchant field must contain the COMPLETE, VERBATIM description from the source line. Examples of correct behavior:
  Source line: "ATM WDL 4569 EMIRATES NBD ABU DHABI ATM 12345"
  ✓ correct merchant: "ATM WDL 4569 EMIRATES NBD ABU DHABI ATM 12345"
  ✗ wrong merchant:   "ATM withdrawal" or "EMIRATES NBD ATM"

  Source line: "POS PURCHASE 1234567890 STARBUCKS DUBAI MALL #4521 AED"
  ✓ correct merchant: "POS PURCHASE 1234567890 STARBUCKS DUBAI MALL #4521 AED"
  ✗ wrong merchant:   "Starbucks" or "Starbucks Dubai Mall"

The "type" field handles classification (e.g. type="dining_out" for the Starbucks line) — the merchant string is for verification only, NOT for clean display.

${TAXONOMY_PROMPT}

GLOBAL CLASSIFICATION GUIDE (use your knowledge for any merchant — apply to "type", NOT to the merchant string itself):
- Starbucks/Costa/Tim Hortons → dining_out
- Shell/BP/ADNOC/ENOC/EPPCO/EMARAT/Exxon → fuel
- Netflix/Spotify/Disney+/Prime/Apple.com/iTunes → subscription
- Amazon/Noon/Flipkart → online_shopping
- Uber/Lyft/Ola/Careem → ride_hail
- Talabat/Deliveroo/DoorDash/Swiggy/Zomato → food_delivery
- Lulu/Carrefour/Spinneys/Waitrose/Tesco → supermarket
- SELFDRIVE/GLOMO → car_rental
- TAMARA/TABBY (BNPL) → online_shopping

═══ OUTPUT FORMAT ═══

Return TWO things, one per line:

Line 1: A JSON metadata object: {"lines_detected": N, "skipped_lines": [...]}
  where:
   · lines_detected = the total number of transaction-like rows you identified
     in the statement (every row that had a date + non-zero debit/credit amount,
     INCLUDING ones you ended up extracting into the array below).
   · skipped_lines (OPTIONAL — usually empty) = an array of raw verbatim text
     strings for any transaction-like line you could NOT extract. If you
     extracted every line, omit this field or return [].

Line 2: The JSON array of extracted transactions.

═══ SKIPPED LINES (rare — usually empty) ═══

You should extract EVERY transaction-like line. The skipped_lines array exists
only as a fallback for genuine edge cases: text severely garbled by OCR, lines
truncated at a chunk boundary, dates or amounts you cannot parse with any
confidence. In all other cases — including ambiguous categorization, unfamiliar
merchants, suspicious transfers — you should still EXTRACT the line and let the
user decide. Only put a line in skipped_lines if you literally cannot produce a
valid {date, amount, direction} triple for it.

When you do skip a line, the value is the raw text exactly as it appears in the
source. For example:
  "skipped_lines": [
    "12/04 ATM WITHDRAWAL 4569 EMIRATES @#&%$ corrupted text",
    "13/04 PAYMENT THANK YOU truncated mid-amount"
  ]

The user sees these verbatim so they can spot-check against their PDF.

═══ ORDER (important) ═══

Return transactions in the SAME ORDER they appear in the source statement, top to bottom. Do not reorder by date, amount, or category. The user numbers transactions by their position in your output, then audits "did every line in the PDF land somewhere in the app?" — so output order must match document order. If a chunk spans the middle of a statement, just return that chunk's rows in their natural document order; the backend stitches chunks together.

Example:
{"lines_detected": 47}
[
  {"date": "2026-04-10", "merchant": "POS PURCHASE 1234567 STARBUCKS DXB MALL #4521", "amount": 28, ...},
  ...
]

If zero transactions: {"lines_detected": 0}\\n[]

No preamble, no code fences, no commentary outside this format.`;

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
  if (!raw) return {items: [], meta: null};
  const clean = raw.replace(/```json|```/g, '').trim();
  // Pull off the metadata object on Line 1. It can now contain nested arrays
  // (skipped_lines), so we walk braces with depth tracking instead of using
  // a flat regex. We stop at the first complete top-level {...}.
  let meta = null;
  {
    let depth = 0, inStr = false, esc = false, start = -1;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try { meta = JSON.parse(clean.slice(start, i + 1)); } catch { meta = null; }
          break;
        }
      } else if (c === '[' && depth === 0) {
        // Hit the array before any object — no metadata
        break;
      }
    }
  }
  const start = clean.indexOf('[');
  if (start === -1) return {items: [], meta};
  const end = clean.lastIndexOf(']');
  if (end !== -1) {
    try {
      const parsed = JSON.parse(clean.slice(start, end + 1));
      if (Array.isArray(parsed)) return {items: parsed, meta};
    } catch { /* fall through */ }
  }
  const body = clean.slice(start + 1);
  const objects = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = body.slice(objStart, i + 1);
        try { objects.push(JSON.parse(objStr)); } catch { /* skip */ }
        objStart = -1;
      }
    }
  }
  return {items: objects, meta};
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
const VALID_SAV_SUBS = new Set(['liquid', 'committed']);
const VALID_CATS = new Set(['income', 'expenses', 'savings_investments', 'loans']);

function normalizeTxn(t) {
  const direction = (t.direction || '').toUpperCase() === 'CR' ? 'CR' : 'DR';
  let cat = t.cat;
  if (cat === 'investments') cat = 'savings_investments';
  if (!VALID_CATS.has(cat)) cat = direction === 'CR' ? 'income' : 'expenses';
  let sub = t.sub;
  if (cat === 'savings_investments') sub = VALID_SAV_SUBS.has(sub) ? sub : 'committed';
  else if (cat === 'loans')          sub = 'main';
  else if (cat === 'income')         sub = (sub === 'direct' ? 'direct' : 'indirect');
  else if (cat === 'expenses')       sub = VALID_EXP_SUBS.has(sub) ? sub : 'misc';
  // Merchant: preserve verbatim but cap at 200 chars to avoid runaway data
  // (was 120; raised because we no longer strip ref numbers)
  return {
    date: t.date || null,
    merchant: String(t.merchant || 'Unknown').replace(/\s+/g, ' ').trim().slice(0, 200),
    amount: Number(t.amount) || 0,
    currency: t.currency || 'AED',
    direction,
    cat, sub,
    type: t.type || 'other',
    freq: t.freq || 'adhoc',
    note: t.note || null,
    possibly_self_transfer: Boolean(t.possibly_self_transfer),
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
        const {items: parsed, meta} = parseJsonArray(raw);
        const trimmedEnd = raw.trimEnd().replace(/```$/, '').trimEnd();
        const looksTruncated = raw.length > 12000 && !trimmedEnd.endsWith(']');
        if (looksTruncated) {
          errors[myIdx] = `truncated: response was ${raw.length} chars, cut off mid-output. Recovered ${parsed.length} complete transactions — consider splitting this file for full coverage.`;
          console.warn(`Chunk ${myIdx + 1} likely truncated; recovered ${parsed.length} txns`);
        }
        results[myIdx] = parsed;
        rawSamples[myIdx] = {
          raw_length: raw.length,
          raw_start: raw.slice(0, 200),
          raw_end: raw.slice(-200),
          parsed_count: parsed.length,
          lines_detected: meta?.lines_detected ?? null,
          skipped_lines: Array.isArray(meta?.skipped_lines) ? meta.skipped_lines : [],
          truncated: looksTruncated,
        };
        const metaStr = meta?.lines_detected != null ? ` [lines_detected=${meta.lines_detected}]` : '';
        console.log(`Chunk ${myIdx + 1}/${chunks.length}: raw=${raw.length} chars, parsed=${parsed.length} txns${metaStr}${looksTruncated ? ' (TRUNCATED)' : ''}`);
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
  const all = results.flat().map(normalizeTxn).filter(t => t.date && t.amount >= 0.01);
  // Per-file dedupe: only collapse rows that match on (date, amount, direction, full merchant string)
  // Now that merchant is verbatim, exact duplicate rows from the same statement are extremely rare;
  // this protects against accidental double-extraction within a single chunk only.
  const seen = new Map();
  const unique = [];
  for (const t of all) {
    const key = `${t.date}|${t.amount}|${t.merchant}|${t.direction}`;
    const count = seen.get(key) || 0;
    if (count < 3) { seen.set(key, count + 1); unique.push(t); }
  }
  // Stamp seq numbers (1-indexed) in document order. The frontend will prefix
  // these with a per-upload file index ("1-12" = file 1, line 12). Together
  // with lines_detected this lets the user audit capture: every seq from
  // 1..total_seq must land somewhere — bucket, Tally-out, or recycle bin —
  // for the file's coverage to read 100%.
  unique.forEach((t, i) => { t.seq = i + 1; });
  let linesDetected = 0;
  let claudeReported = false;
  const allSkippedLines = [];
  for (const s of rawSamples) {
    if (s && typeof s.lines_detected === 'number') {
      linesDetected += s.lines_detected;
      claudeReported = true;
    }
    if (s && Array.isArray(s.skipped_lines)) {
      for (const ln of s.skipped_lines) {
        if (typeof ln === 'string' && ln.trim()) {
          allSkippedLines.push(ln.trim().slice(0, 300));
        }
      }
    }
  }
  const response = {
    transactions: unique, count: unique.length, filename: filename || null,
    chunks_total: chunksTotal, chunks_ok: chunksOk, chunks_failed: chunksFailed,
    text_chars: cleaned.length,
    lines_detected: claudeReported ? linesDetected : null,
    total_seq: unique.length, // highest seq number assigned (= unique.length)
    skipped_lines: allSkippedLines, // raw text of any lines Claude couldn't extract
  };
  if (chunksFailed > 0) {
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

async function handleInsight(req, res, apiKey) {
  const {summary} = req.body || {};
  if (!summary || typeof summary !== 'object') {
    return res.status(400).json({
      error: 'missing_summary',
      message: 'No summary data provided.',
    });
  }
  const userContent = `Spending summary (${summary.period || 'recent period'}):

Income:                 AED ${summary.totals?.income || 0}
Expenses:               AED ${summary.totals?.expenses || 0}
Savings & Investments:  AED ${summary.totals?.savings_investments || 0}
Loan/card payments:     AED ${summary.totals?.loans || 0}
Net surplus:            AED ${(summary.totals?.income || 0) - (summary.totals?.expenses || 0) - (summary.totals?.savings_investments || 0) - (summary.totals?.loans || 0)} over ${summary.months || 1} months

Top expenses by merchant (excludes savings transfers; ${summary.top_merchants?.length || 0}):
${(summary.top_merchants || []).slice(0, 15).map(m => `- ${m.merchant}: AED ${m.total} (${m.count}x, ${m.category})`).join('\n')}

Spend by sub-category:
${Object.entries(summary.by_sub || {}).map(([k, v]) => `- ${k}: AED ${v}`).join('\n')}

${summary.month_over_month ? `Month-over-month: ${summary.month_over_month}` : ''}

Now write ONE observation per the rules. Focus on what's genuinely interesting. Do NOT moralize about whether spending is "avoidable" — the user decides that. Just surface patterns they might not have noticed.`;

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
