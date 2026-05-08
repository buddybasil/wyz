// WYZ API - Hybrid Bank Statement Analyzer (v7)
// Goal: fast, reliable extraction without Vercel/Claude timeouts.
// Strategy:
//   1) Use deterministic parsers for common statement layouts.
//   2) Use local merchant/category rules for immediate dashboard output.
//   3) Use Claude only for optional insight text and last-resort extraction.
// Requires env variable: ANTHROPIC_API_KEY only for action="insight" and fallback_ai_extract.

const MODEL = 'claude-haiku-4-5-20251001';
const INSIGHT_MAX_TOKENS = 450;
const INSIGHT_TIMEOUT_MS = 18000;
const FALLBACK_TIMEOUT_MS = 35000;
const FALLBACK_MAX_TOKENS = 7000;
const MAX_TOTAL_CHARS = 700000;
const REJECT_ABOVE_CHARS = 1400000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizeSpaces(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\uFFFE/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.:;])/g, '$1')
    .trim();
}

function cleanStatementText(text) {
  if (!text) return '';
  let t = String(text).replace(/\r/g, '\n');
  t = t.replace(/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u0900-\u097F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0E00-\u0E7F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g, ' ');
  t = t.replace(/General Terms and Important Information[\s\S]*$/i, '');
  t = t.replace(/Terms\s+(and|&)\s+Conditions[\s\S]{200,}$/i, '');
  t = t.replace(/Important (Information|Notice|Disclaimer)[\s\S]{200,}$/i, '');
  t = t.replace(/\*{3,}\s*END\s*OF\s*STATEMENT\s*\*{3,}/gi, '\nEND_OF_STATEMENT\n');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/[\w.-]+@[\w.-]+\.\w+/g, ' ');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function parseAmount(v) {
  if (v == null) return 0;
  const s = String(v).replace(/,/g, '').replace(/[^[\]0-9.\-]/g, '');
  const n = Number(s.replace(/[\[\]]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function isoFromDMY(s) {
  const m = String(s || '').match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function makeTxn({date, merchant, amount, currency = 'AED', direction, source = 'parser', parser = null, raw = null}) {
  const t = {
    date,
    merchant: normalizeSpaces(merchant).slice(0, 240) || 'Unknown',
    amount: Number(amount) || 0,
    currency,
    direction: direction === 'CR' ? 'CR' : 'DR',
    cat: direction === 'CR' ? 'income' : 'expenses',
    sub: direction === 'CR' ? 'indirect' : 'misc',
    type: direction === 'CR' ? 'other_income' : 'other',
    freq: 'adhoc',
    note: null,
    source,
    parser,
  };
  if (raw) t.raw = normalizeSpaces(raw).slice(0, 320);
  return categorizeTxn(t);
}

function isNoiseLine(line) {
  const l = line.toLowerCase();
  return !line ||
    l.includes('transaction date description') ||
    l.includes('transaction date') && l.includes('amount') ||
    l.includes('primary card number') ||
    l.includes('card holder name') ||
    l.includes('credit card statement') ||
    l.includes('statement of account') ||
    l.includes('statement period') ||
    l.includes('current balance') ||
    l.includes('minimum amount due') ||
    l.includes('total amount due') ||
    l.includes('credit limit') ||
    l.includes('available credit') ||
    l.includes('commercial bank of dubai') ||
    l.includes('licensed by the central bank') ||
    l.includes('end_of_statement') ||
    /^\*{3,}/.test(line);
}

// ADCB 365 Cashback card table:
// 11/04/2026 LULU HYPERMARKET LLC BRAN ABU DHABI DR 113.5
function parseAdcbCreditCard(text) {
  const rows = [];
  const lines = text.split(/\n+/).map(normalizeSpaces).filter(Boolean);
  const re = /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(CR|DR)\s+([\d,]+(?:\.\d+)?)$/i;
  for (const line of lines) {
    if (isNoiseLine(line)) continue;
    const m = line.match(re);
    if (!m) continue;
    const date = isoFromDMY(m[1]);
    const amount = parseAmount(m[4]);
    if (!date || amount <= 0) continue;
    rows.push(makeTxn({date, merchant: m[2], amount, direction: m[3].toUpperCase(), parser: 'adcb_card', raw: line}));
  }
  return rows;
}

// CBD credit-card table:
// 25-03-2026 25-03-2026 CLAUDE.AI SUBSCRIPTION ANTHROPIC.COM CA [ 21.00] 80.97
// 27-03-2026 27-03-2026 PAYMENTRECEIVED - FTS & SWIFT 2,376.00 CR
function parseCbdCreditCard(text) {
  const rows = [];
  const lines = text.split(/\n+/).map(normalizeSpaces).filter(Boolean);
  const re = /^(\d{2}-\d{2}-\d{4})\s+(\d{2}-\d{2}-\d{4})\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s*(CR)?$/i;
  for (const line of lines) {
    if (isNoiseLine(line)) continue;
    if (/^\d{6}\*+\d+\s*-/.test(line)) continue;
    const m = line.match(re);
    if (!m) continue;
    let merchant = m[3];
    // Keep foreign currency marker in merchant, e.g. [ 63.00].
    const date = isoFromDMY(m[1]);
    const amount = parseAmount(m[4]);
    if (!date || amount <= 0) continue;
    const direction = m[5] || /payment\s*received|refund|reversal/i.test(merchant) ? 'CR' : 'DR';
    rows.push(makeTxn({date, merchant, amount, direction, parser: 'cbd_card', raw: line}));
  }
  return rows;
}

// ADCB account table. Works with layout-preserved rows and with many PDF.js multiline records.
// Columns: Posting Date, Value Date, Description, Ref/Cheque No, Debit Amount, Credit Amount, Balance.
function parseAdcbAccount(text) {
  const rows = [];
  const dateTime = /\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/g;
  const compact = text
    .split(/\n+/)
    .map(normalizeSpaces)
    .filter(Boolean)
    .filter(line => !isNoiseLine(line))
    .join('\n');

  const starts = [];
  let m;
  const startRe = /(?:^|\n)(\d{2}\/\d{2}\/\d{4})(?:\s+\d{2}:\d{2}(?::\d{2})?)?/g;
  while ((m = startRe.exec(compact)) !== null) starts.push(m.index + (compact[m.index] === '\n' ? 1 : 0));

  for (let i = 0; i < starts.length; i++) {
    const rec = compact.slice(starts[i], starts[i + 1] || compact.length).replace(/\n/g, ' ');
    const dates = [...rec.matchAll(/\d{2}\/\d{2}\/\d{4}/g)].map(x => ({value: x[0], index: x.index}));
    if (dates.length < 2) continue;
    const postingDate = dates[0].value;
    const valueDate = dates[1].value;

    // Tail must contain debit credit balance. Balances sometimes show .68, allow leading dot.
    const tail = rec.match(/(.+?)\s+([\d,]+(?:\.\d+)?|\.\d+)\s+([\d,]+(?:\.\d+)?|\.\d+)\s+([\d,]+(?:\.\d+)?|\.\d+)\s*$/);
    if (!tail) continue;
    const debit = parseAmount(tail[2]);
    const credit = parseAmount(tail[3]);
    if (debit <= 0 && credit <= 0) continue;

    let body = tail[1];
    const valueDatePos = body.indexOf(valueDate);
    if (valueDatePos >= 0) body = body.slice(valueDatePos + valueDate.length).trim();

    // Remove obvious trailing reference token, but keep transfer/merchant details.
    body = body.replace(/\s+(PHUB\d+|\d{8,}|[A-Z0-9]{4,})\s*$/i, '').trim();
    body = body.replace(/^\d{6,}\s+/, '').trim();

    const date = isoFromDMY(postingDate);
    const direction = credit > 0 ? 'CR' : 'DR';
    const amount = credit > 0 ? credit : debit;
    if (!date || amount <= 0 || body.length < 2) continue;
    rows.push(makeTxn({date, merchant: body, amount, direction, parser: 'adcb_account', raw: rec}));
  }
  return rows;
}

// Payslip support: useful because users often upload payslips with account statements.
function parsePayslip(text) {
  if (!/employee\s+payslip/i.test(text) || !/net\s+pay/i.test(text)) return [];
  const period = text.match(/Payroll Interval\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s+-\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i);
  const net = text.match(/Net\s+Pay\s+([\d,]+(?:\.\d+)?)/i);
  if (!net) return [];
  let date = null;
  if (period) {
    const d = new Date(period[2]);
    if (!Number.isNaN(d.getTime())) date = d.toISOString().slice(0, 10);
  }
  if (!date) date = new Date().toISOString().slice(0, 10);
  return [makeTxn({date, merchant: 'Employee Payslip Net Pay', amount: parseAmount(net[1]), direction: 'CR', parser: 'payslip', raw: 'Net Pay'})];
}

function dedupePreserveOrder(items) {
  const seen = new Map();
  const out = [];
  for (const t of items) {
    const key = `${t.date}|${t.direction}|${t.amount.toFixed(2)}|${t.merchant.toUpperCase()}`;
    const count = seen.get(key) || 0;
    // Do not over-dedupe genuine duplicate same-day purchases. Keep up to 4 identical rows.
    if (count < 4) {
      seen.set(key, count + 1);
      out.push(t);
    }
  }
  out.forEach((t, i) => { t.seq = i + 1; });
  return out;
}

function scoreParse(rows, text) {
  if (!rows.length) return 0;
  const dateCount = (text.match(/\b\d{2}[\/\-]\d{2}[\/\-]\d{4}\b/g) || []).length;
  return rows.length / Math.max(1, Math.min(dateCount, rows.length + 20));
}

function deterministicExtract(text) {
  const cleaned = cleanStatementText(text);
  const candidates = [
    {name: 'adcb_card', rows: parseAdcbCreditCard(cleaned)},
    {name: 'cbd_card', rows: parseCbdCreditCard(cleaned)},
    {name: 'adcb_account', rows: parseAdcbAccount(cleaned)},
    {name: 'payslip', rows: parsePayslip(cleaned)},
  ];
  candidates.sort((a, b) => {
    const bs = scoreParse(b.rows, cleaned), as = scoreParse(a.rows, cleaned);
    if (bs !== as) return bs - as;
    return b.rows.length - a.rows.length;
  });
  const best = candidates[0];
  if (best && best.rows.length > 0) return {parser: best.name, rows: dedupePreserveOrder(best.rows), cleaned};
  return {parser: null, rows: [], cleaned};
}

function categorizeTxn(t) {
  const m = String(t.merchant || '').toUpperCase();
  const out = {...t};

  if (out.direction === 'CR') {
    if (/PAYMENT\s*RECEIVED|CARD\s*PAYMENT\s*RECEIVED|PRINCIPAL CR/.test(m)) {
      out.cat = 'loans'; out.sub = 'main'; out.type = 'card_payment_received'; return out;
    }
    if (/CASHBACK/.test(m)) {
      out.cat = 'income'; out.sub = 'indirect'; out.type = 'cashback'; return out;
    }
    if (/SALARY|PAYSLIP|NET PAY/.test(m)) {
      out.cat = 'income'; out.sub = 'direct'; out.type = 'salary'; out.freq = 'monthly'; return out;
    }
    if (/DIVIDEND|PROFIT PAID|INTEREST/.test(m)) {
      out.cat = 'income'; out.sub = 'indirect'; out.type = 'dividend'; return out;
    }
    if (/REFUND|REVERSAL|LANDMARK|AMAZON\.AE/.test(m)) {
      out.cat = 'income'; out.sub = 'indirect'; out.type = 'refund'; return out;
    }
    out.cat = 'income'; out.sub = 'indirect'; out.type = 'transfer_in'; return out;
  }

  if (/CREDIT CARD PAYMNT|CREDIT CARD PAYMENT|CARD PAYMENT|PAYMENT TO CARD|PRINCIPAL DB/.test(m)) {
    out.cat = 'loans'; out.sub = 'main'; out.type = 'card_payment'; return out;
  }
  if (/INSTALLMENT RECOVERY|EMI|LOAN|MORTGAGE/.test(m)) {
    out.cat = 'loans'; out.sub = 'main'; out.type = 'loan_installment'; return out;
  }
  if (/ZURICH INTL|ZURICH|LIFE LTD|LIC |HDFC LIFE|METLIFE|AVIVA/.test(m)) {
    out.cat = 'savings_investments'; out.sub = 'committed'; out.type = 'life_insurance'; return out;
  }
  if (/POLICY BAZAAR|LIVA|ALLIANCE INSURANCE|NEXTCAR|CAR INSURANCE|INSURANCE/.test(m)) {
    out.cat = 'expenses'; out.sub = 'misc'; out.type = 'insurance'; return out;
  }
  if (/ADNOC|ENOC|EPPCO|SHELL|FUEL|PETROL|SITE\s+\d+/.test(m)) {
    out.cat = 'expenses'; out.sub = 'transport'; out.type = 'fuel'; return out;
  }
  if (/SALIK|TASJEEL|RTA|SMARTDXB|DUBAI SMARTGOVERNMENT|ABU DHABI POLICE|POLICE|PARKING|NOQODI|DIFC PARKING/.test(m)) {
    out.cat = 'expenses'; out.sub = 'transport'; out.type = 'gov_services'; return out;
  }
  if (/LULU|CARREFOUR|CRREFOUR|WAITROSE|SPINNEYS|SUPERMARKET|HYPERMARKET|GROCERY|MINIMART|MINI MARKET|AD COOP|BAQALA|MARKET/.test(m)) {
    out.cat = 'expenses'; out.sub = 'food'; out.type = 'supermarket'; return out;
  }
  if (/TALABAT|DELIVEROO|NOON FOOD|KEETA|FOOD DELIVERY/.test(m)) {
    out.cat = 'expenses'; out.sub = 'food'; out.type = 'food_delivery'; return out;
  }
  if (/RESTAURANT|RESTAU|CAFE|CAFETERIA|KFC|BURGER|MCDONALD|SUBWAY|KRISPY|DINING|KARAK|SHAWARMA|BAKERY|CHOCOLATE|CHURROS|MALABAR|VASANTA|ARAB FOOD/.test(m)) {
    out.cat = 'expenses'; out.sub = 'food'; out.type = 'dining_out'; return out;
  }
  if (/DU |DU\s|E&|ETISALAT|VIRGIN MOBILE|APPLE PAY800188|APPLE PAYDUBAI|DIGITAL APP|POSTPAID|ONE-TIME PAY/.test(m)) {
    out.cat = 'expenses'; out.sub = 'shelter'; out.type = 'internet_phone'; return out;
  }
  if (/GEMS|SCHOOL|TUITION|UNITED INDIAN/.test(m)) {
    out.cat = 'expenses'; out.sub = 'fees'; out.type = 'school_tuition'; return out;
  }
  if (/APPLE\.COM|ITUNES|OPENAI|CHATGPT|CLAUDE\.AI|ANTHROPIC|LUMALABS|OPENART|NETFLIX|SPOTIFY|SUBSCRIPTION|NOON ONE/.test(m)) {
    out.cat = 'expenses'; out.sub = 'misc'; out.type = 'subscription'; return out;
  }
  if (/FOREIGN TRANSACTION FEE|VAT ON FOREIGN|ANNUAL FEE|OVERLIMIT FEE|VATON OVERLIMIT|VAT ON ANNUAL/.test(m)) {
    out.cat = 'expenses'; out.sub = 'fees'; out.type = m.includes('OVERLIMIT') ? 'overlimit_fee' : (m.includes('ANNUAL') ? 'annual_fee' : 'forex_fee'); return out;
  }
  if (/PHARMACY|MEDICAL|HOSPITAL|CLINIC|BURJEEL|ASTER|MEDICLINIC|NMC|TAHA/.test(m)) {
    out.cat = 'expenses'; out.sub = 'misc'; out.type = 'healthcare'; return out;
  }
  if (/AMAZON|NOON|TABBY|TAMARA|TRENDYOL|IKEA|HOME CENTRE|HOME BOX|LANDMARK|MINISO|FIRSTCRY|CHARLES AND KEITH|MARKS&SPENCER/.test(m)) {
    out.cat = 'expenses'; out.sub = 'misc'; out.type = 'online_shopping'; return out;
  }
  if (/AIRBNB|HOTEL|HYATT|PULLMAN|ETIHAD AIR|AIRWAYS|AIRPORTS|APOLLO FLIGHT|TRAVEL|TICKET|PLATINUMLIST/.test(m)) {
    out.cat = 'expenses'; out.sub = 'misc'; out.type = 'travel'; return out;
  }
  if (/CAREEM|TAXI|SELFDRIVE|GLOMO|CAR RENTAL|MOBILITY/.test(m)) {
    out.cat = 'expenses'; out.sub = 'transport'; out.type = /TAXI|CAREEM/.test(m) ? 'ride_hail' : 'car_rental'; return out;
  }
  if (/ATM WDL|CASH WITHDRAWAL/.test(m)) {
    out.cat = 'expenses'; out.sub = 'misc'; out.type = 'cash_withdrawal'; return out;
  }
  if (/TRF OUT|SEND MONEY|MBTRF|AANI|TRANSFER/.test(m)) {
    out.cat = 'expenses'; out.sub = 'misc'; out.type = 'transfer_out';
    if (/BASIL ABRAHAM/.test(m)) out.possibly_self_transfer = true;
    return out;
  }
  out.cat = 'expenses'; out.sub = 'misc'; out.type = 'other';
  return out;
}

function summarizeTransactions(txns) {
  const totals = {income: 0, expenses: 0, savings_investments: 0, loans: 0};
  const by_sub = {};
  const merchants = new Map();
  for (const t of txns) {
    const cat = totals[t.cat] == null ? 'expenses' : t.cat;
    totals[cat] += t.amount;
    const subKey = `${cat}/${t.sub || 'main'}`;
    by_sub[subKey] = (by_sub[subKey] || 0) + t.amount;
    if (t.direction === 'DR' && cat !== 'savings_investments' && cat !== 'loans') {
      const key = t.merchant;
      const prev = merchants.get(key) || {merchant: key, total: 0, count: 0, category: t.type};
      prev.total += t.amount; prev.count += 1;
      merchants.set(key, prev);
    }
  }
  const round = n => Math.round(n * 100) / 100;
  for (const k of Object.keys(totals)) totals[k] = round(totals[k]);
  for (const k of Object.keys(by_sub)) by_sub[k] = round(by_sub[k]);
  return {
    totals,
    by_sub,
    top_merchants: [...merchants.values()].sort((a,b) => b.total - a.total).slice(0, 20).map(x => ({...x, total: round(x.total)})),
    months: new Set(txns.map(t => String(t.date).slice(0, 7))).size || 1,
  };
}

async function callClaude({prompt, userContent, apiKey, maxTokens, timeoutMs}) {
  if (!apiKey) throw new Error('config_missing: ANTHROPIC_API_KEY is not configured');
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
      body: JSON.stringify({model: MODEL, max_tokens: maxTokens, messages: [{role: 'user', content: `${prompt}\n\n${userContent}`}]}),
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`claude_error:${res.status}:${body.slice(0, 160)}`);
    }
    const data = await res.json();
    return data?.content?.[0]?.text || '';
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('timeout: Claude took too long');
    throw err;
  }
}

function parseJsonObject(raw) {
  if (!raw) return null;
  const clean = raw.replace(/```json|```/g, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s < 0 || e < s) return null;
  try { return JSON.parse(clean.slice(s, e + 1)); } catch { return null; }
}

function parseJsonArray(raw) {
  if (!raw) return [];
  const clean = raw.replace(/```json|```/g, '').trim();
  const s = clean.indexOf('['), e = clean.lastIndexOf(']');
  if (s < 0 || e < s) return [];
  try { const arr = JSON.parse(clean.slice(s, e + 1)); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

const FALLBACK_PROMPT = `Extract only clear financial transaction rows from the statement text. Return a JSON array only. Each object must be {"date":"YYYY-MM-DD","merchant":"verbatim description","amount":number,"currency":"AED","direction":"DR"|"CR"}. Do not include opening balance, closing balance, headers, terms, explanations, or code fences. If unsure, skip the row.`;

async function fallbackAiExtract(cleaned, filename, apiKey) {
  // Keep fallback small to avoid timeout. Use only likely transaction lines/records.
  const likely = cleaned
    .split(/\n+/)
    .map(normalizeSpaces)
    .filter(l => /\b\d{2}[\/\-]\d{2}[\/\-]\d{4}\b/.test(l))
    .slice(0, 180)
    .join('\n');
  if (likely.length < 50) return [];
  const raw = await callClaude({prompt: FALLBACK_PROMPT, userContent: `File: ${filename || 'statement'}\n\n${likely}`, apiKey, maxTokens: FALLBACK_MAX_TOKENS, timeoutMs: FALLBACK_TIMEOUT_MS});
  return parseJsonArray(raw).map(t => makeTxn({
    date: t.date,
    merchant: t.merchant,
    amount: t.amount,
    currency: t.currency || 'AED',
    direction: t.direction,
    parser: 'ai_fallback',
    source: 'claude',
  })).filter(t => t.date && t.amount > 0);
}

async function handleExtract(req, res, apiKey) {
  const {text, filename, allow_ai_fallback = false} = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({error: 'missing_text', message: 'No readable text was provided. The PDF may be image-only, password-protected, or unsupported.'});
  }
  if (text.length > REJECT_ABOVE_CHARS) {
    return res.status(413).json({error: 'file_too_large', message: `Readable text is very large (${Math.round(text.length / 1000)}k chars). Split and retry.`, size_chars: text.length, limit_chars: REJECT_ABOVE_CHARS});
  }

  let input = text;
  let wasTruncated = false;
  if (input.length > MAX_TOTAL_CHARS) { input = input.slice(0, MAX_TOTAL_CHARS); wasTruncated = true; }

  const {parser, rows, cleaned} = deterministicExtract(input);
  let transactions = rows;
  let usedFallback = false;
  let fallbackError = null;

  if (transactions.length === 0 && allow_ai_fallback) {
    try {
      transactions = dedupePreserveOrder(await fallbackAiExtract(cleaned, filename, apiKey));
      usedFallback = transactions.length > 0;
    } catch (err) {
      fallbackError = err.message;
    }
  }

  const summary = summarizeTransactions(transactions);
  const response = {
    transactions,
    count: transactions.length,
    filename: filename || null,
    parser: parser || (usedFallback ? 'ai_fallback' : null),
    deterministic: Boolean(parser),
    ai_fallback_used: usedFallback,
    text_chars: cleaned.length,
    lines_detected: transactions.length,
    total_seq: transactions.length,
    skipped_lines: [],
    summary,
  };
  if (wasTruncated) response.warning = `Text was truncated at ${MAX_TOTAL_CHARS} chars. Results may be incomplete.`;
  if (fallbackError) response.warning = `No deterministic parser matched and AI fallback failed: ${fallbackError}`;
  if (transactions.length === 0 && !response.warning) {
    response.warning = 'No transactions found. This may be an image-only file, a non-statement document, or a format that needs another parser.';
    response.diagnostic = {sample_text: cleaned.slice(0, 500)};
  }
  return res.status(200).json(response);
}

const INSIGHT_PROMPT = `You are a thoughtful financial coach. Given categorized spending data, write one specific, kind, actionable observation. Use actual amounts and merchants. Output JSON only: {"headline":"...","detail":"...","tone":"neutral|warning|encouraging"}.`;

async function handleInsight(req, res, apiKey) {
  const {summary, transactions = []} = req.body || {};
  const effective = summary || summarizeTransactions(transactions);
  const userContent = JSON.stringify(effective, null, 2).slice(0, 9000);
  try {
    const raw = await callClaude({prompt: INSIGHT_PROMPT, userContent, apiKey, maxTokens: INSIGHT_MAX_TOKENS, timeoutMs: INSIGHT_TIMEOUT_MS});
    const obj = parseJsonObject(raw);
    if (!obj || !obj.headline) throw new Error('bad_insight_json');
    return res.status(200).json({headline: String(obj.headline).slice(0, 180), detail: obj.detail ? String(obj.detail).slice(0, 260) : null, tone: ['neutral','warning','encouraging'].includes(obj.tone) ? obj.tone : 'neutral'});
  } catch (err) {
    // Insight must never block the dashboard.
    return res.status(200).json({headline: null, detail: null, tone: 'neutral', warning: err.message});
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error: 'method_not_allowed', message: 'Use POST'});

  const apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    const action = req.body?.action;
    if (action === 'extract') return await handleExtract(req, res, apiKey);
    if (action === 'insight') return await handleInsight(req, res, apiKey);
    return res.status(400).json({error: 'bad_action', message: 'Unknown action. Expected extract or insight.'});
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({error: 'unexpected', message: err.message || 'Unexpected server error'});
  }
}
