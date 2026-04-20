// ══ MONEYWIZE API — Vercel Serverless Function ══
// Claude extraction + rules engine categorisation
// Equivalent to the Cloudflare Worker, runs on Vercel
// Requires env variable: ANTHROPIC_API_KEY

// ── Rules engine: fast, keyword-based categorisation (runs before Claude) ──
const RULES = [
  {match: /SALARY|PAYROLL|WAGE|EMPLOYMENT|BASIC PAY/i, cat: 'income', sub: 'direct', type: 'salary', freq: 'monthly'},
  {match: /CASHBACK|CASH BACK|REWARD/i, cat: 'income', sub: 'indirect', type: 'cashback', freq: 'monthly'},
  {match: /DIVIDEND/i, cat: 'income', sub: 'indirect', type: 'dividend', freq: 'adhoc'},
  {match: /REFUND|REIMBURSE|CREDIT NOTE/i, cat: 'income', sub: 'indirect', type: 'refund', freq: 'adhoc'},
  {match: /INSURANCE.*CREDIT|ALLIANCE.*INSUR/i, cat: 'income', sub: 'indirect', type: 'insurance_reimbursement', freq: 'adhoc'},
  {match: /PROFIT PAID|INTEREST PAID|PROFIT.*RATE/i, cat: 'income', sub: 'indirect', type: 'savings_profit', freq: 'quarterly'},

  {match: /LULU|CARREFOUR|SPINNEYS|UNION COOP|WAITROSE|GEANT|VIVA|CHOITHRAM/i, cat: 'expenses', sub: 'food', type: 'supermarket', freq: 'weekly'},
  {match: /TALABAT|DELIVEROO|ZOMATO|CAREEM.*FOOD|UBER.*EATS|NOON.*FOOD/i, cat: 'expenses', sub: 'food', type: 'food_delivery', freq: 'weekly', avoidable: true},
  {match: /STARBUCKS|COSTA|TIM HORTONS|KFC|MCDONALD|BURGER|PIZZA|SUBWAY/i, cat: 'expenses', sub: 'food', type: 'dining_out', freq: 'weekly', avoidable: true},

  {match: /ADNOC|ENOC|EPPCO|EMARAT/i, cat: 'expenses', sub: 'transport', type: 'fuel', freq: 'weekly'},
  {match: /SALIK|DARB/i, cat: 'expenses', sub: 'transport', type: 'toll', freq: 'weekly'},
  {match: /RTA|NOL|PARKING/i, cat: 'expenses', sub: 'transport', type: 'transport_misc', freq: 'weekly'},
  {match: /CAREEM|UBER/i, cat: 'expenses', sub: 'transport', type: 'ride_hail', freq: 'weekly', avoidable: true},

  {match: /DEWA|ETISALAT|DU |EMPOWER|TABREED|TECOM/i, cat: 'expenses', sub: 'shelter', type: 'utilities', freq: 'monthly'},
  {match: /RENT|EJARI|TENANCY/i, cat: 'expenses', sub: 'shelter', type: 'rent', freq: 'monthly'},

  {match: /ATM|CASH WITHDRAWAL|CASH WDL/i, cat: 'expenses', sub: 'misc', type: 'cash_withdrawal', freq: 'adhoc'},
  {match: /FEE|CHARGE|COMMISSION|VAT/i, cat: 'expenses', sub: 'fees', type: 'bank_fee', freq: 'adhoc'},

  {match: /NETFLIX|SPOTIFY|AMAZON PRIME|DISNEY|APPLE\.COM|GOOGLE.*STORAGE|ICLOUD/i, cat: 'expenses', sub: 'misc', type: 'subscription', freq: 'monthly', avoidable: true},
  {match: /AMAZON|NOON|CARREFOUR ONLINE|SHEIN|NAMSHI/i, cat: 'expenses', sub: 'misc', type: 'online_shopping', freq: 'adhoc'},

  {match: /LOAN|MORTGAGE|EMI|INSTALMENT|INSTALLMENT/i, cat: 'loans', sub: 'repayment', type: 'loan_repayment', freq: 'monthly'},
  {match: /CARD PAYMENT|CC PAYMENT|CREDIT CARD/i, cat: 'loans', sub: 'repayment', type: 'card_payment', freq: 'monthly'},

  {match: /VESTED|ZERODHA|STAKE|SARWA|IB |INTERACTIVE BROKER|EQUITY/i, cat: 'investments', sub: 'direct', type: 'equity_investment', freq: 'adhoc'},
  {match: /GOLD|DGCX|GOLD.*PURCHASE/i, cat: 'investments', sub: 'direct', type: 'gold', freq: 'adhoc'},
  {match: /ZURICH|AVIVA|METLIFE|SUKOON.*LIFE/i, cat: 'investments', sub: 'indirect', type: 'life_insurance', freq: 'monthly'},
];

const EXTRACT_PROMPT = `You are a financial transaction extraction engine for UAE bank statements.

Given the bank statement text below, extract ALL transactions as a JSON array. For each transaction return:
- date: "YYYY-MM-DD" format
- merchant: the payee/description, cleaned (remove ref numbers, card digits)
- amount: positive number (no currency symbols)
- currency: "AED" or the relevant currency code
- direction: "CR" for credits/incoming, "DR" for debits/outgoing
- note: optional context if useful (max 40 chars), otherwise null

Return ONLY a valid JSON array. No preamble, no code fences, no commentary. If you can't find transactions, return [].`;

// ── CORS headers (reusable) ──
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Apply rules engine to enrich Claude's output ──
function applyRules(txns) {
  return txns.map(t => {
    const merchant = t.merchant || '';
    const rule = RULES.find(r => r.match.test(merchant));
    if (rule) {
      return {
        ...t,
        cat: rule.cat,
        sub: rule.sub,
        type: rule.type,
        freq: rule.freq,
        avoidable: rule.avoidable || false,
      };
    }
    // Default: unknown → expenses/misc
    return {
      ...t,
      cat: t.direction === 'CR' ? 'income' : 'expenses',
      sub: t.direction === 'CR' ? 'indirect' : 'misc',
      type: 'uncategorised',
      freq: 'adhoc',
      avoidable: false,
    };
  });
}

// ── Parse JSON out of Claude's response, tolerating code fences ──
function parseJsonArray(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch (e) {
    return [];
  }
}

// ── Main handler ──
export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'Method not allowed'});

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({error: 'ANTHROPIC_API_KEY not configured in Vercel environment'});
  }

  try {
    const {action, text, filename} = req.body || {};

    if (action !== 'extract') {
      return res.status(400).json({error: 'Unknown action. Expected: extract'});
    }
    if (!text || typeof text !== 'string') {
      return res.status(400).json({error: 'Missing "text" field (statement text)'});
    }

    // Trim to safe size — Claude Sonnet handles ~200k input tokens but we cap to keep cost/speed sane
    const trimmed = text.slice(0, 80000);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 16000,
        messages: [
          {role: 'user', content: `${EXTRACT_PROMPT}\n\nFile: ${filename || 'statement.pdf'}\n\nStatement text:\n${trimmed}`},
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(claudeRes.status).json({
        error: 'Claude API error',
        detail: errText.slice(0, 500),
      });
    }

    const data = await claudeRes.json();
    const raw = data?.content?.[0]?.text || '';
    const rawTxns = parseJsonArray(raw);
    const enriched = applyRules(rawTxns);

    return res.status(200).json({
      transactions: enriched,
      count: enriched.length,
      filename: filename || null,
    });
  } catch (err) {
    return res.status(500).json({error: err.message || 'Unexpected error'});
  }
}
