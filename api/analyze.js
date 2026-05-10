// WYZ API - Generic Statement Analyzer
// Core objectives:
// - Extract transaction rows from credit-card statements, bank-account statements, CSV/TXT.
// - Avoid using LLM for extraction.
// - Use Claude only for optional insight generation.
// - Default categorisation:
//   CR -> income
//   DR -> expenses
// - Internal/self/card-payment transfers are excluded from P/L.
// - Savings/investments are user-controlled from the frontend.
// - Bank account statements with Debit/Credit/Balance columns are forced through account_table parser.

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

  // Remove Arabic/Hebrew/Indic blocks that often duplicate English labels in bilingual statements.
  t = t.replace(
    /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\u0900-\u097F\uFB50-\uFDFF\uFE70-\uFEFF]/g,
    ' '
  );

  t = t.replace(/General Terms and Important Information[\s\S]*$/i, '');
  t = t.replace(/Terms\s+(and|&)\s+Conditions[\s\S]{200,}$/i, '');
  t = t.replace(/Important (Information|Notice|Disclaimer)[\s\S]{200,}$/i, '');
  t = t.replace(/\*{3,}\s*END\s*OF\s*STATEMENT\s*\*{3,}/gi, '\n******* END OF STATEMENT *******\n');
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

  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function isoFromAnyDate(s) {
  const raw = String(s || '').trim();

  let m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);

  // Default to DD/MM/YYYY because the tested UAE statements use this style.
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
    l.includes('total outstanding balance') ||
    l.includes('credit limit') ||
    l.includes('available credit') ||
    l.includes('licensed by the central bank') ||
    l.includes('commercial bank of dubai psc') ||
    l.includes('end_of_statement') ||
    /^\*{3,}/.test(line);
}

function looksLikeBankAccountStatement(text) {
  const s = String(text || '').toUpperCase();

  const hasAccountHeader =
    /ACCOUNT\s+STATEMENT/.test(s) ||
    /ACCOUNT\s+NUMBER/.test(s) ||
    /ACCOUNT\s+NAME/.test(s);

  const hasBankColumns =
    /POSTING\s+DATE/.test(s) &&
    /VALUE\s+DATE/.test(s) &&
    /DEBIT\s+AMOUNT/.test(s) &&
    /CREDIT\s+AMOUNT/.test(s) &&
    /BALANCE/.test(s);

  return hasAccountHeader && hasBankColumns;
}

function isInternalTransferLike(t) {
  const m = String(t.merchant || '').toUpperCase();

  // Credit-card settlement/payment rows.
  if (
    /PAYMENT\s*RECEIVED/.test(m) ||
    /PAYMENTRECEIVED/.test(m) ||
    /CREDIT\s*CARD\s*PAYMNT/.test(m) ||
    /CREDIT\s*CARD\s*PAYMENT/.test(m) ||
    /CARD\s*PAYMENT/.test(m) ||
    /PAYMENT\s*TO\s*CARD/.test(m)
  ) {
    return true;
  }

  // Bank-account self/family/internal transfer style rows.
  // These are not operational spending unless user manually reclassifies them later.
  if (
    /\bMBTRF\b/.test(m) ||
    /\bTRF\s*OUT\s*TO\b/.test(m) ||
    /\bB\/O\s+BASIL\b/.test(m) ||
    /\bB\/O\s+SEENA\b/.test(m) ||
    /\bBASIL\s+ABRAHAM\b/.test(m) ||
    /\bSEENA\s+BASIL\b/.test(m) ||
    /\bSEND\s+MONEY\s+VIA\s+AANI\b/.test(m)
  ) {
    return true;
  }

  return false;
}

function categorizeTxn(t) {
  const out = { ...t };

  if (isInternalTransferLike(out)) {
    out.cat = 'internal_transfer';
    out.sub = 'ignored';
    out.type = 'card_or_internal_payment';
    out.freq = 'adhoc';
    out.excluded_from_pl = true;
    return out;
  }

  if (out.direction === 'CR') {
    out.cat = 'income';
    out.sub = 'uncategorised';
    out.type = 'credit';
    out.freq = 'adhoc';
    out.excluded_from_pl = false;
    return out;
  }

  out.cat = 'expenses';
  out.sub = 'uncategorised';
  out.type = 'debit';
  out.freq = 'adhoc';
  out.excluded_from_pl = false;
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
    excluded_from_pl: false,
  };

  if (raw) txn.raw = normalizeSpaces(raw).slice(0, 420);

  return categorizeTxn(txn);
}

function compactRows(rows) {
  return rows.filter(Boolean);
}

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

    if (/^(CR|C|CREDIT)$/.test(marker)) {
      direction = 'CR';
    } else if (/^(DR|D|DEBIT)$/.test(marker)) {
      direction = 'DR';
    } else if (signed.isNegative) {
      direction = 'DR';
    } else if (/\b(payment received|paymentreceived|refund|reversal|cashback|credit adjustment)\b/i.test(desc)) {
      direction = 'CR';
    }

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

function parseAccountTable(text) {
  const rawLines = String(text || '')
    .split(/\n+/)
    .map(normalizeSpaces)
    .filter(Boolean);

  const rows = [];

  const datePat = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';

  // Rebuild records because browser PDF extraction often splits one table row into multiple lines:
  // posting date, time, value date, description, ref, debit, credit, balance.
  const records = [];
  let current = [];

  function flush() {
    if (current.length) {
      records.push(current.join(' '));
      current = [];
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (isNoiseLine(line)) continue;

    const startsRecord =
      new RegExp(`^${datePat}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?(?:\\s+${datePat})?\\b`).test(line);

    if (startsRecord) {
      flush();
      current.push(line);
    } else if (current.length) {
      current.push(line);
    }
  }

  flush();

  for (const rec0 of records) {
    const rec = normalizeSpaces(rec0);
    if (!rec) continue;

    const dateMatches = [...rec.matchAll(new RegExp(datePat, 'g'))];

    if (!dateMatches.length) continue;

    const postingDateRaw = dateMatches[0][0];
    const postingDateIso = isoFromAnyDate(postingDateRaw);
    if (!postingDateIso) continue;

    // Remove leading posting date, optional time, and optional value date.
    let rest = rec.slice(dateMatches[0].index + postingDateRaw.length).trim();
    rest = rest.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, '').trim();

    const secondDateMatch = rest.match(new RegExp(`^(${datePat})\\b`));
    if (secondDateMatch) {
      rest = rest.slice(secondDateMatch[0].length).trim();
    }

    // Bank account table ends with: debit credit balance.
    // Examples:
    // SALARY 2 0.00 33575 42841.53
    // CREDIT CARD PAYMNT ... 9278.93 0.00 33562.6
    const nums = [...rest.matchAll(/(?:^|\s)(-?\(?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|-?\(?\d+(?:\.\d+)?\)?)(?=\s|$)/g)];

    if (nums.length < 3) continue;

    const debitToken = nums[nums.length - 3][1];
    const creditToken = nums[nums.length - 2][1];
    const balanceToken = nums[nums.length - 1][1];

    const debit = parseAmount(debitToken);
    const credit = parseAmount(creditToken);
    const balance = parseAmount(balanceToken);

    if (!Number.isFinite(balance)) continue;

    // At least one of debit or credit must be positive.
    if (debit <= 0 && credit <= 0) continue;

    const direction = credit > 0 ? 'CR' : 'DR';
    const amount = credit > 0 ? credit : debit;

    const descEnd = nums[nums.length - 3].index;
    let body = rest.slice(0, descEnd).trim();

    // Remove trailing reference tokens when they are clearly not part of the description.
    body = body
      .replace(/\s+(PHUB\d+)\s*$/i, '')
      .replace(/\s+([A-Z0-9]{8,})\s*$/i, '')
      .replace(/\s+(\d{6,})\s*$/i, '')
      .replace(/\s+(A[0-9A-Z]{2,}|[0-9A-Z]{4})\s*$/i, '')
      .trim();

    body = body
      .replace(/\b(REF\/CHEQUE\s+NO|DEBIT\s+AMOUNT|CREDIT\s+AMOUNT|BALANCE)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!body || body.length < 2) continue;

    rows.push(makeTxn({
      date: postingDateIso,
      merchant: body,
      amount,
      direction,
      parser: 'account_table',
      raw: rec,
    }));
  }

  return compactRows(rows);
}

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

    // Keep up to 4 identical rows because real statements can have genuine repeated same-day transactions.
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

function extractTransactionTableRegion(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map(normalizeSpaces)
    .filter(Boolean);

  if (!lines.length) {
    return {
      text: '',
      found: false,
      reason: 'empty_text',
      startIndex: -1,
      endIndex: -1,
    };
  }

  const startPatterns = [
    /Transaction Date/i,
    /Posting Date\s+Value Date\s+Description/i,
    /Transaction Description/i,
    /Debit Amount\s+Credit Amount\s+Balance/i,
    /Amount in AED/i,
  ];

  const endPatterns = [
    /\*{3,}\s*END\s*OF\s*STATEMENT\s*\*{3,}/i,
    /General Terms and Important Information/i,
    /Commercial Bank of Dubai PSC/i,
    /licensed by the Central Bank/i,
  ];

  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const windowText = lines.slice(i, i + 8).join(' ');
    if (startPatterns.some(p => p.test(windowText))) {
      start = i + 1;
      break;
    }
  }

  if (start < 0) {
    return {
      text,
      found: false,
      reason: 'transaction_table_header_not_found',
      startIndex: -1,
      endIndex: -1,
    };
  }

  let end = lines.length;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (endPatterns.some(p => p.test(line))) {
      end = i;
      break;
    }
  }

  const region = lines.slice(start, end).join('\n');

  return {
    text: region,
    found: true,
    reason: null,
    startIndex: start,
    endIndex: end,
  };
}

function makeParseReport({ filename, parser, rows, cleaned, candidates, warning = null }) {
  const fullCandidate = countCandidateRows(cleaned);
  const tableRegion = extractTransactionTableRegion(cleaned);
  const tableCandidate = countCandidateRows(tableRegion.text);

  let candidate = tableCandidate;
  let qualityScope = tableRegion.found ? 'transaction_table_region' : 'full_text_fallback';
  let qualityNote = tableRegion.found
    ? 'Candidate rows counted only within detected transaction-table region.'
    : 'Transaction-table region was not confidently detected, so full text was used.';

  // Some PDFs extract transaction rows before the visible table header.
  // If the detected table region clearly undercounts compared with extracted rows, fall back.
  if (tableRegion.found && tableCandidate.count < Math.max(1, rows.length * 0.5)) {
    candidate = fullCandidate;
    qualityScope = 'full_text_fallback';
    qualityNote = 'Detected table region undercounted rows due to PDF extraction order, so full text candidate count was used.';
  }

  const extracted = rows.length;
  const rejected = Math.max(0, candidate.count - extracted);

  let confidence = 0;

  if (extracted > 0) {
    if (candidate.count > 0) {
      confidence = Math.min(0.99, extracted / Math.max(extracted, candidate.count));
    } else {
      confidence = 0.85;
    }

    if (/generic|signed|csv/i.test(parser || '')) {
      confidence = Math.max(0.62, confidence - 0.08);
    }
  }

  const status = extracted === 0
    ? 'failed'
    : confidence >= 0.95
      ? 'ok'
      : 'review';

  const warnings = [];

  if (warning) warnings.push(warning);

  if (extracted === 0) {
    warnings.push('No transaction rows were extracted. This format may need OCR or another parser.');
  } else if (status !== 'ok') {
    warnings.push(`Extracted ${extracted} transaction rows against ${candidate.count} estimated transaction-table candidate rows. Review recommended.`);
  }

  if (qualityScope === 'full_text_fallback') {
    warnings.push(qualityNote);
  }

  return {
    filename: filename || null,
    parser: parser || null,
    status,
    confidence: Math.round(confidence * 100) / 100,
    candidate_date_rows: candidate.count,
    transactions_extracted: extracted,
    rejected_rows_estimate: rejected,
    quality_scope: qualityScope,
    quality_note: qualityNote,
    table_region_detected: tableRegion.found,
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
  const isBankAccount = looksLikeBankAccountStatement(cleaned);

  const candidates = [
    { name: 'csv_like', rows: parseCsvLike(cleaned) },
    { name: 'tagged_single_date', rows: parseTaggedSingleDate(cleaned) },
    { name: 'two_date_card', rows: parseTwoDateCard(cleaned) },
    { name: 'account_table', rows: parseAccountTable(cleaned) },
    { name: 'signed_amount', rows: parseSignedAmountRows(cleaned) },
    { name: 'payslip', rows: parsePayslip(cleaned) },
  ];

  let best;

  if (isBankAccount) {
    const accountCandidate = candidates.find(c => c.name === 'account_table');

    if (accountCandidate && accountCandidate.rows.length > 0) {
      best = accountCandidate;
    } else {
      candidates.sort((a, b) => {
        const bs = scoreParse(b.rows, cleaned);
        const as = scoreParse(a.rows, cleaned);

        if (bs !== as) return bs - as;
        return b.rows.length - a.rows.length;
      });

      best = candidates[0];
    }
  } else {
    candidates.sort((a, b) => {
      const bs = scoreParse(b.rows, cleaned);
      const as = scoreParse(a.rows, cleaned);

      if (bs !== as) return bs - as;
      return b.rows.length - a.rows.length;
    });

    best = candidates[0];
  }

  const rows = best && best.rows.length > 0 ? dedupePreserveOrder(best.rows) : [];
  const parser = rows.length ? best.name : null;

  const parse_report = makeParseReport({
    filename,
    parser,
    rows,
    cleaned,
    candidates,
    warning: isBankAccount && parser !== 'account_table'
      ? 'Bank account statement detected, but account_table parser did not win. Review required.'
      : null,
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
    internal_transfer: 0,
  };

  for (const t of txns) {
    const amt = Number(t.amount) || 0;

    if (t.cat === 'income') {
      totals.income += amt;
    } else if (t.cat === 'savings_investments') {
      totals.savings_investments += amt;
    } else if (t.cat === 'internal_transfer') {
      totals.internal_transfer += amt;
    } else {
      totals.expenses += amt;
    }
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
  } else if (parse_report && parse_report.status !== 'ok') {
    response.warning = parse_report.warnings[0] || 'Some transaction-table rows may need review.';
  }

  return res.status(200).json(response);
}

const INSIGHT_PROMPT = `You are a careful financial coach. Given generic categorized cash-flow data, write one short, useful observation. Do not assume merchant categories. Internal transfers are excluded from P/L. Output JSON only: {"headline":"...","detail":"...","tone":"neutral|warning|encouraging"}.`;

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
