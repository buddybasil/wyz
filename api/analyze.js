// WYZ API - Generic Statement Analyzer
// Purpose:
// - Extract transactions from bank statements, credit-card statements, CSV/text exports, and payslip-like text.
// - Keep extraction generic.
// - Do NOT hardcode merchant names or vendor categorisation.
// - Default classification:
//      CR -> income
//      DR -> expenses
// - User can later move selected rows into savings from the frontend.

const MODEL = 'claude-haiku-4-5-20251001';

const INSIGHT_MAX_TOKENS = 450;
const INSIGHT_TIMEOUT_MS = 18000;

const MAX_TOTAL_CHARS = 900000;
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

  // Remove large non-Latin legal/footer text blocks commonly found in bilingual statements.
  t = t.replace(
    /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\u0900-\u097F\uFB50-\uFDFF\uFE70-\uFEFF]/g,
    ' '
  );

  // Remove long legal/terms sections.
  t = t.replace(/General Terms and Important Information[\s\S]*$/i, '');
  t = t.replace(/Terms\s+(and|&)\s+Conditions[\s\S]{200,}$/i, '');
  t = t.replace(/Important (Information|Notice|Disclaimer)[\s\S]{200,}$/i, '');

  t = t.replace(/\*{3,}\s*END\s*OF\s*STATEMENT\s*\*{3,}/gi, '\nEND_OF_STATEMENT\n');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/[\w.-]+@[\w.-]+\.\w+/g, ' ');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

function parseAmount(v) {
  if (v == null) return 0;

  const raw = String(v).trim();
  const cleaned = raw
    .replace(/,/g, '')
    .replace(/[^\d.\-()[\]]/g, '');

  const n = Number(cleaned.replace(/[()[\]]/g, '').replace(/^-/, ''));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function parseSignedAmount(v) {
  const raw = String(v || '').trim();
  return {
    amount: parseAmount(raw),
    isNegative: /^-/.test(raw) || /^\(.*\)$/.test(raw),
  };
}

function isoFromDMY(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;

  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3];

  return `${yyyy}-${mm}-${dd}`;
}

function isoFromAnyDate(s) {
  const raw = String(s || '').trim();

  let m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }

  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);

  // Default to DD/MM/YYYY because your current training files are UAE-style.
  // If second part cannot be a month, assume MM/DD/YYYY.
  if (b > 12 && a <= 12) {
    return `${m[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }

  return `${m[3]}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
}

function amountTokenRegex() {
  return /(?:-?\(?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|-?\(?\d+(?:\.\d+)?\)?|\.\d+)/g;
}

function isNoiseLine(line) {
  const l = String(line || '').toLowerCase();

  return !line ||
    l.includes('transaction date description') ||
    (l.includes('transaction date') && l.includes('amount')) ||
    l.includes('posting date value date description') ||
    l.includes('primary card number') ||
    l.includes('card holder name') ||
    l.includes('credit card statement') ||
    l.includes('statement of account') ||
    l.includes('statement period') ||
    l.includes('opening balance') ||
    l.includes('closing balance') ||
    l.includes('current balance') ||
    l.includes('minimum amount due') ||
    l.includes('total amount due') ||
    l.includes('credit limit') ||
    l.includes('available credit') ||
    l.includes('licensed by the central bank') ||
    l.includes('end_of_statement') ||
    /^\*{3,}/.test(line);
}

function categorizeTxn(t) {
  const out = { ...t };

  if (out.direction === 'CR') {
    out.cat = 'income';
    out.sub = 'uncategorised';
    out.type = 'credit';
    out.freq = 'adhoc';
    return out;
  }

  out.cat = 'expenses';
  out.sub = 'uncategorised';
  out.type = 'debit';
  out.freq = 'adhoc';
  return out;
}

function makeTxn({ date, merchant, amount, currency = 'AED', direction, parser = null, raw = null }) {
  const amt = Number(amount) || 0;
  if (!date || amt <= 0) return null;

  const txn = {
    date,
    merchant: normalizeSpaces(merchant).slice(0, 280) || 'Unknown',
    amount: Math.round(amt * 100) / 100,
    currency,
    direction: direction === 'CR' ? 'CR' : 'DR',
    cat: direction === 'CR' ? 'income' : 'expenses',
    sub: 'uncategorised',
    type: direction === 'CR' ? 'credit' : 'debit',
    freq: 'adhoc',
    note: null,
    source: 'parser',
    parser,
  };

  if (raw) txn.raw = normalizeSpaces(raw).slice(0, 420);

  return categorizeTxn(txn);
}

function compactRows(rows) {
  return rows.filter(Boolean);
}

// Parser 1:
// date + description + DR/CR/D/C/DEBIT/CREDIT + amount
function parseTaggedSingleDate(text) {
  const rows = [];
  const lines = text.split(/\n+/).map(normalizeSpaces).filter(Boolean);

  const date = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';
  const re = new RegExp(
    `^(${date})\\s+(.+?)\\s+(DR|CR|D|C|DEBIT|CREDIT)\\s+(-?\\(?[\\d,]+(?:\\.\\d+)?\\)?|-?\\(?\\.\\d+\\)?)$`,
    'i'
  );

  for (const line of lines) {
    if (isNoiseLine(line)) continue;

    const m = line.match(re);
    if (!m) continue;

    const dateIso = isoFromAnyDate(m[1]);
    const marker = m[3].toUpperCase();
    const amount = parseAmount(m[4]);

    if (!dateIso || amount <= 0) continue;

    const direction = /^(CR|C|CREDIT)$/.test(marker) ? 'CR' : 'DR';

    rows.push(makeTxn({
      date: dateIso,
      merchant: m[2],
      amount,
      direction,
      parser: 'tagged_single_date',
      raw: line,
    }));
  }

  return compactRows(rows);
}

// Parser 2:
// date + posting date + description + amount + optional CR/DR
function parseTwoDateCard(text) {
  const rows = [];
  const lines = text.split(/\n+/).map(normalizeSpaces).filter(Boolean);

  const date = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';
  const re = new RegExp(
    `^(${date})\\s+(${date})\\s+(.+?)\\s+(-?\\(?[\\d,]+(?:\\.\\d+)?\\)?|-?\\(?\\.\\d+\\)?)\\s*(CR|DR|C|D|CREDIT|DEBIT)?$`,
    'i'
  );

  for (const line of lines) {
    if (isNoiseLine(line)) continue;
    if (/^\d{6}\*+\d+\s*-/.test(line)) continue;

    const m = line.match(re);
    if (!m) continue;

    const dateIso = isoFromAnyDate(m[1]);
    const desc = m[3];
    const signed = parseSignedAmount(m[4]);
    const marker = (m[5] || '').toUpperCase();

    if (!dateIso || signed.amount <= 0) continue;

    let direction = 'DR';

    if (/^(CR|C|CREDIT)$/.test(marker)) direction = 'CR';
    else if (/^(DR|D|DEBIT)$/.test(marker)) direction = 'DR';
    else if (signed.isNegative) direction = 'DR';
    else if (/\b(payment received|refund|reversal|cashback|credit adjustment)\b/i.test(desc)) direction = 'CR';

    rows.push(makeTxn({
      date: dateIso,
      merchant: desc,
      amount: signed.amount,
      direction,
      parser: 'two_date_card',
      raw: line,
    }));
  }

  return compactRows(rows);
}

// Parser 3:
// account statement format with debit / credit / balance tail.
// Supports multiline rows where date/time/value-date are split across PDF text extraction.
function parseAccountTable(text) {
  const lines = text
    .split(/\n+/)
    .map(normalizeSpaces)
    .filter(Boolean)
    .filter(line => !isNoiseLine(line));

  const rows = [];

  const datePat = '\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2}';
  const dateAtStart = new RegExp(`^(${datePat})(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?`);
  const twoDatesAtStart = new RegExp(`^(${datePat})(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?\\s+(${datePat})`);

  const isTimeOnly = s => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(s);

  const looksLikeStart = (i) => {
    const l = lines[i] || '';
    if (!dateAtStart.test(l)) return false;
    if (twoDatesAtStart.test(l)) return true;

    // Handles extraction where:
    // line i     = posting date
    // line i + 1 = time
    // line i + 2 = value date + description...
    const n1 = lines[i + 1] || '';
    const n2 = lines[i + 2] || '';

    return isTimeOnly(n1) && new RegExp(`^(${datePat})\\b`).test(n2);
  };

  const blocks = [];
  let current = [];

  for (let i = 0; i < lines.length; i++) {
    if (looksLikeStart(i)) {
      if (current.length) blocks.push(current.join(' '));
      current = [lines[i]];
    } else if (current.length) {
      current.push(lines[i]);
    }
  }

  if (current.length) blocks.push(current.join(' '));

  for (const rec0 of blocks) {
    const rec = rec0.replace(/\s+/g, ' ').trim();

    const dates = [...rec.matchAll(new RegExp(datePat, 'g'))].map(x => ({
      value: x[0],
      index: x.index,
    }));

    if (dates.length < 1) continue;

    const postingDate = dates[0].value;
    const secondDate = dates[1]?.value || dates[0].value;

    const numeric = [...rec.matchAll(/(?:^|\s)(-?\(?[\d,]+(?:\.\d+)?\)?|-?\(?\.\d+\)?)(?=\s|$)/g)];

    if (numeric.length < 2) continue;

    let amount = 0;
    let direction = null;
    let tailIndex = null;

    // Most account statements end with:
    // debit amount | credit amount | balance
    if (numeric.length >= 3) {
      const debit = parseAmount(numeric[numeric.length - 3][1]);
      const credit = parseAmount(numeric[numeric.length - 2][1]);

      if (debit > 0 || credit > 0) {
        amount = credit > 0 ? credit : debit;
        direction = credit > 0 ? 'CR' : 'DR';
        tailIndex = numeric[numeric.length - 3].index;
      }
    }

    // Fallback:
    // amount | balance
    // infer direction from sign or generic words.
    if (!direction && numeric.length >= 2) {
      const signed = parseSignedAmount(numeric[numeric.length - 2][1]);

      if (signed.amount > 0) {
        amount = signed.amount;
        direction = signed.isNegative
          ? 'DR'
          : (/\b(CR|CREDIT|DEPOSIT|PAID\s*IN|MONEY\s*IN|RECEIVED)\b/i.test(rec) ? 'CR' : 'DR');
        tailIndex = numeric[numeric.length - 2].index;
      }
    }

    if (!direction || amount <= 0) continue;

    let bodyStart = dates[1]
      ? (dates[1].index + secondDate.length)
      : (dates[0].index + postingDate.length);

    let body = rec.slice(bodyStart, tailIndex).trim();

    body = body.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, '').trim();
    body = body.replace(/\s+(PHUB\d+|[A-Z0-9]{8,}|\d{8,})\s*$/i, '').trim();
    body = body.replace(/^\d{6,}\s+/, '').trim();
    body = body.replace(/\b(REF\/CHEQUE NO|DEBIT AMOUNT|CREDIT AMOUNT|BALANCE)\b/gi, '').trim();

    const dateIso = isoFromAnyDate(postingDate);

    if (!dateIso || body.length < 2) continue;

    rows.push(makeTxn({
      date: dateIso,
      merchant: body,
      amount,
      direction,
      parser: 'account_table',
      raw: rec,
    }));
  }

  return compactRows(rows);
}

// Parser 4:
// date + description + signed amount
function parseSignedAmountRows(text) {
  const rows = [];
  const lines = text.split(/\n+/).map(normalizeSpaces).filter(Boolean);

  const date = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';
  const re = new RegExp(
    `^(${date})\\s+(.+?)\\s+(-\\(?[\\d,]+(?:\\.\\d+)?\\)?|\\([\\d,]+(?:\\.\\d+)?\\))\\s*(?:[A-Z]{3})?(?:\\s+[-\\d,.()]+)?$`,
    'i'
  );

  for (const line of lines) {
    if (isNoiseLine(line)) continue;

    const m = line.match(re);
    if (!m) continue;

    const dateIso = isoFromAnyDate(m[1]);
    const signed = parseSignedAmount(m[3]);

    if (!dateIso || signed.amount <= 0) continue;

    rows.push(makeTxn({
      date: dateIso,
      merchant: m[2],
      amount: signed.amount,
      direction: signed.isNegative ? 'DR' : 'CR',
      parser: 'signed_amount',
      raw: line,
    }));
  }

  return compactRows(rows);
}

// Parser 5:
// Simple CSV parser for exported data.
// Looks for common headers: date, description/merchant/narration, amount, debit, credit.
function parseCsvLike(text) {
  const raw = String(text || '').trim();
  if (!raw.includes(',') && !raw.includes('\t')) return [];

  const delimiter = raw.includes('\t') ? '\t' : ',';
  const lines = raw.split(/\n+/).filter(Boolean);

  if (lines.length < 2) return [];

  const split = line => {
    const out = [];
    let cur = '';
    let q = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          q = !q;
        }
      } else if (ch === delimiter && !q) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }

    out.push(cur.trim());
    return out;
  };

  const headers = split(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, '_'));

  const idx = (...names) => {
    for (const n of names) {
      const i = headers.findIndex(h => h === n || h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  const dateIdx = idx('date', 'transaction_date', 'posting_date');
  const descIdx = idx('description', 'merchant', 'narration', 'details', 'particulars');
  const amountIdx = idx('amount');
  const debitIdx = idx('debit', 'withdrawal', 'paid_out', 'money_out');
  const creditIdx = idx('credit', 'deposit', 'paid_in', 'money_in');

  if (dateIdx < 0 || descIdx < 0) return [];

  const rows = [];

  for (const line of lines.slice(1)) {
    const cells = split(line);
    const dateIso = isoFromAnyDate(cells[dateIdx]);
    const desc = cells[descIdx];

    if (!dateIso || !desc) continue;

    let direction = null;
    let amount = 0;

    if (debitIdx >= 0 && parseAmount(cells[debitIdx]) > 0) {
      direction = 'DR';
      amount = parseAmount(cells[debitIdx]);
    } else if (creditIdx >= 0 && parseAmount(cells[creditIdx]) > 0) {
      direction = 'CR';
      amount = parseAmount(cells[creditIdx]);
    } else if (amountIdx >= 0) {
      const signed = parseSignedAmount(cells[amountIdx]);
      direction = signed.isNegative ? 'DR' : 'CR';
      amount = signed.amount;
    }

    if (!direction || amount <= 0) continue;

    rows.push(makeTxn({
      date: dateIso,
      merchant: desc,
      amount,
      direction,
      parser: 'csv_like',
      raw: line,
    }));
  }

  return compactRows(rows);
}

// Parser 6:
// Payslip style. Creates one income row from Net Pay.
function parsePayslip(text) {
  if (!/payslip|payroll|net\s+pay/i.test(text)) return [];

  const net = text.match(/Net\s+Pay\s+([\d,]+(?:\.\d+)?)/i);
  if (!net) return [];

  const period = text.match(/Payroll Interval\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s+-\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i);

  let dateIso = new Date().toISOString().slice(0, 10);

  if (period) {
    const d = new Date(period[2]);
    if (!Number.isNaN(d.getTime())) dateIso = d.toISOString().slice(0, 10);
  }

  return compactRows([
    makeTxn({
      date: dateIso,
      merchant: 'Payslip Net Pay',
      amount: parseAmount(net[1]),
      direction: 'CR',
      parser: 'payslip',
      raw: 'Net Pay',
    }),
  ]);
}

function dedupePreserveOrder(items) {
  const seen = new Map();
  const out = [];

  for (const t of items) {
    if (!t) continue;

    const key = `${t.date}|${t.direction}|${Number(t.amount).toFixed(2)}|${String(t.merchant).toUpperCase()}`;
    const count = seen.get(key) || 0;

    // Keep up to 4 identical rows because real statements often contain genuine repeated transactions.
    if (count < 4) {
      seen.set(key, count + 1);
      out.push(t);
    }
  }

  out.forEach((t, i) => {
    t.seq = i + 1;
  });

  return out;
}

function scoreParse(rows, text) {
  if (!rows.length) return 0;

  const dateCount = (String(text).match(/\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g) || []).length;
  return rows.length / Math.max(1, Math.min(dateCount, rows.length + 20));
}

function countCandidateRows(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map(normalizeSpaces)
    .filter(Boolean)
    .filter(l => !isNoiseLine(l));

  let count = 0;
  const samples = [];

  for (const line of lines) {
    const hasDate = /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/.test(line);
    const money = line.match(amountTokenRegex()) || [];
    const hasMoneyWords = /\b(DR|CR|DEBIT|CREDIT|WITHDRAWAL|DEPOSIT|PAID\s*OUT|PAID\s*IN|MONEY\s*OUT|MONEY\s*IN|BALANCE)\b/i.test(line);

    if (hasDate && (money.length >= 1 || hasMoneyWords)) {
      count++;
      if (samples.length < 8) samples.push(line.slice(0, 240));
    }
  }

  return { count, samples };
}

function makeParseReport({ filename, parser, rows, cleaned, candidates, warning = null }) {
  const candidate = countCandidateRows(cleaned);
  const extracted = rows.length;
  const rejected = Math.max(0, candidate.count - extracted);

  let confidence = 0;
  if (extracted > 0) {
    confidence = Math.min(0.99, extracted / Math.max(extracted, Math.min(candidate.count || extracted, extracted + 12)));
    if (/generic|signed|csv/i.test(parser || '')) confidence = Math.max(0.62, confidence - 0.08);
  }

  const status = extracted === 0
    ? 'failed'
    : rejected > Math.max(8, extracted * 0.25)
      ? 'warning'
      : 'ok';

  const warnings = [];
  if (warning) warnings.push(warning);
  if (extracted === 0) warnings.push('No transaction rows were extracted. This format may need OCR or another parser.');
  else if (status === 'warning') warnings.push(`Parsed ${extracted} rows, but about ${rejected} candidate rows may need review.`);

  return {
    filename: filename || null,
    parser: parser || null,
    status,
    confidence: Math.round(confidence * 100) / 100,
    candidate_date_rows: candidate.count,
    transactions_extracted: extracted,
    rejected_rows_estimate: rejected,
    parser_scores: (candidates || []).map(c => ({
      parser: c.name,
      rows: c.rows.length,
      score: Math.round(scoreParse(c.rows, cleaned) * 1000) / 1000,
    })),
    sample_candidate_rows: candidate.samples,
    warnings,
  };
}

function deterministicExtract(text, filename = null) {
  const cleaned = cleanStatementText(text);

  const candidates = [
    { name: 'csv_like', rows: parseCsvLike(cleaned) },
    { name: 'tagged_single_date', rows: parseTaggedSingleDate(cleaned) },
    { name: 'two_date_card', rows: parseTwoDateCard(cleaned) },
    { name: 'account_table', rows: parseAccountTable(cleaned) },
    { name: 'signed_amount', rows: parseSignedAmountRows(cleaned) },
    { name: 'payslip', rows: parsePayslip(cleaned) },
  ];

  candidates.sort((a, b) => {
    const bs = scoreParse(b.rows, cleaned);
    const as = scoreParse(a.rows, cleaned);

    if (bs !== as) return bs - as;
    return b.rows.length - a.rows.length;
  });

  const best = candidates[0];
  const rows = best && best.rows.length > 0 ? dedupePreserveOrder(best.rows) : [];
  const parser = rows.length ? best.name : null;

  const parse_report = makeParseReport({
    filename,
    parser,
    rows,
    cleaned,
    candidates,
  });

  return {
    parser,
    rows,
    cleaned,
    candidates,
    parse_report,
  };
}

function summarizeTransactions(txns) {
  const totals = {
    income: 0,
    expenses: 0,
    savings_investments: 0,
  };

  for (const t of txns) {
    const amt = Number(t.amount) || 0;

    if (t.cat === 'income') totals.income += amt;
    else if (t.cat === 'savings_investments') totals.savings_investments += amt;
    else totals.expenses += amt;
  }

  totals.pl = totals.income - totals.expenses - totals.savings_investments;

  for (const k of Object.keys(totals)) {
    totals[k] = Math.round(totals[k] * 100) / 100;
  }

  return {
    totals,
    months: new Set(txns.map(t => String(t.date).slice(0, 7))).size || 1,
  };
}

async function callClaude({ prompt, userContent, apiKey, maxTokens, timeoutMs }) {
  if (!apiKey) {
    throw new Error('config_missing: ANTHROPIC_API_KEY is not configured');
  }

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
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\n${userContent}`,
          },
        ],
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`claude_error:${res.status}:${body.slice(0, 180)}`);
    }

    const data = await res.json();
    return data?.content?.[0]?.text || '';
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('timeout: Claude took too long');
    }
    throw err;
  }
}

function parseJsonObject(raw) {
  if (!raw) return null;

  const clean = String(raw).replace(/```json|```/g, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');

  if (s < 0 || e < s) return null;

  try {
    return JSON.parse(clean.slice(s, e + 1));
  } catch {
    return null;
  }
}

async function handleExtract(req, res) {
  const { text, filename } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      error: 'missing_text',
      message: 'No readable text was provided. The PDF may be image-only, password-protected, or unsupported.',
    });
  }

  if (text.length > REJECT_ABOVE_CHARS) {
    return res.status(413).json({
      error: 'file_too_large',
      message: `Readable text is very large (${Math.round(text.length / 1000)}k chars). Split and retry.`,
      size_chars: text.length,
      limit_chars: REJECT_ABOVE_CHARS,
    });
  }

  let input = text;
  let wasTruncated = false;

  if (input.length > MAX_TOTAL_CHARS) {
    input = input.slice(0, MAX_TOTAL_CHARS);
    wasTruncated = true;
  }

  const { parser, rows, cleaned, parse_report } = deterministicExtract(input, filename);
  const summary = summarizeTransactions(rows);

  const response = {
    transactions: rows,
    count: rows.length,
    filename: filename || null,
    parser,
    deterministic: Boolean(parser),
    text_chars: cleaned.length,
    lines_detected: rows.length,
    total_seq: rows.length,
    skipped_lines: [],
    summary,
    parse_report,
  };

  if (wasTruncated) {
    response.warning = `Text was truncated at ${MAX_TOTAL_CHARS} chars. Results may be incomplete.`;
  }

  if (rows.length === 0) {
    response.warning = response.warning || 'No transactions found. This may be an image-only file, a non-statement document, or a format that needs another parser.';
    response.diagnostic = {
      sample_text: cleaned.slice(0, 700),
      parse_report,
    };
  } else if (parse_report && parse_report.status === 'warning') {
    response.warning = parse_report.warnings[0] || 'Some candidate rows may need review.';
  }

  return res.status(200).json(response);
}

const INSIGHT_PROMPT = `You are a careful financial coach. Given generic categorized cash-flow data, write one short, useful observation. Do not assume merchant categories. Mention that user-classified savings affect P/L if relevant. Output JSON only: {"headline":"...","detail":"...","tone":"neutral|warning|encouraging"}.`;

async function handleInsight(req, res, apiKey) {
  const { summary, transactions = [] } = req.body || {};
  const effective = summary || summarizeTransactions(transactions);

  try {
    const raw = await callClaude({
      prompt: INSIGHT_PROMPT,
      userContent: JSON.stringify(effective, null, 2).slice(0, 9000),
      apiKey,
      maxTokens: INSIGHT_MAX_TOKENS,
      timeoutMs: INSIGHT_TIMEOUT_MS,
    });

    const obj = parseJsonObject(raw);

    if (!obj || !obj.headline) {
      throw new Error('bad_insight_json');
    }

    return res.status(200).json({
      headline: String(obj.headline).slice(0, 180),
      detail: obj.detail ? String(obj.detail).slice(0, 300) : null,
      tone: ['neutral', 'warning', 'encouraging'].includes(obj.tone) ? obj.tone : 'neutral',
    });
  } catch (err) {
    // Insight should never block the dashboard.
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'method_not_allowed',
      message: 'Use POST',
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  try {
    const action = req.body?.action;

    if (action === 'extract') {
      return await handleExtract(req, res);
    }

    if (action === 'insight') {
      return await handleInsight(req, res, apiKey);
    }

    return res.status(400).json({
      error: 'bad_action',
      message: 'Unknown action. Expected extract or insight.',
    });
  } catch (err) {
    console.error('Handler error:', err);

    return res.status(500).json({
      error: 'unexpected',
      message: err.message || 'Unexpected server error',
    });
  }
}
