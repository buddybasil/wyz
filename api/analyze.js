// WYZ API - Generic Statement Analyzer
// v19-pdfplumber-validated
//
// Core rule:
// - If tableRows are provided, use them as the primary source.
// - Debit column = expense.
// - Credit column = income.
// - Balance column = validation only.
// - Failed account rows are excluded from P/L by default.
// - Text/card parsers remain as fallback.

const BACKEND_VERSION = 'strict-account-table-v19-pdfplumber-validated';

const NUM_SRC = String.raw`-?\(?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|-?\(?\d+(?:\.\d+)?\)?|\.\d+`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizeSpaces(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function parseAmount(v) {
  if (v == null) return 0;

  let raw = String(v).trim();
  if (!raw) return 0;

  if (/^\.\d+$/.test(raw)) raw = `0${raw}`;

  const cleaned = raw
    .replace(/,/g, '')
    .replace(/[^\d.\-()[\]]/g, '');

  if (!cleaned) return 0;

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

function isoFromAnyDate(s) {
  const raw = String(s || '').trim();

  let m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);

  if (b > 12 && a <= 12) {
    return `${m[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
  }

  return `${m[3]}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
}

function isInternalTransferLike(t) {
  const m = String(`${t.merchant || ''} ${t.reference || ''}`).toUpperCase();

  if (
    /PAYMENT\s*RECEIVED/.test(m) ||
    /PAYMENTRECEIVED/.test(m) ||
    /CREDIT\s*CARD\s*PAYMNT/.test(m) ||
    /CREDIT\s*CARD\s*PAYMENT/.test(m) ||
    /CARD\s*PAYMENT/.test(m) ||
    /PAYMENT\s*TO\s*CARD/.test(m) ||
    /FTS\s*&\s*SWIFT/.test(m)
  ) {
    return true;
  }

  if (
    /\bB\/O\s+BASIL\b/.test(m) ||
    /\bBASIL\s+ABRAHAM\b/.test(m) ||
    /\bB\/O\s+SEENA\b/.test(m) ||
    /\bSEENA\s+BASIL\b/.test(m) ||
    /\bOUT\s+TO\s+BASIL\b/.test(m) ||
    /\bOUT\s+TO\s+SEENA\b/.test(m) ||
    /\bTRF\s+OUT\s+TO\b/.test(m) ||
    (/\bMBTRF\b/.test(m) && /\bTRF\b/.test(m)) ||
    /\bSEND\s+MONEY\s+VIA\s+AANI\b/.test(m)
  ) {
    return true;
  }

  if (
    /\bALLIANCE\s+INSURANCE\b/.test(m) ||
    /\bB\/O\s+ALLIANCE\b/.test(m)
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

  if (out.validation && out.validation.exclude_from_pl) {
    out.cat = 'internal_transfer';
    out.sub = 'validation_failed';
    out.type = 'review_excluded';
    out.freq = 'adhoc';
    out.excluded_from_pl = true;
    out.note = 'Excluded because balance validation failed.';
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

function makeTxn({
  date,
  merchant,
  amount,
  currency = 'AED',
  direction,
  parser = null,
  raw = null,
  reference = null,
  statement_type = null,
  balance = null,
  debit = null,
  credit = null,
  validation = null,
}) {
  const amt = Number(amount) || 0;
  if (!date || amt <= 0) return null;

  const txn = {
    date,
    merchant: normalizeSpaces(merchant).slice(0, 520) || 'Unknown',
    reference: reference ? normalizeSpaces(reference).slice(0, 260) : null,
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
    statement_type,
    excluded_from_pl: false,
  };

  if (balance != null && Number.isFinite(Number(balance))) {
    txn.balance = Math.round(Number(balance) * 100) / 100;
  }

  if (debit != null && Number.isFinite(Number(debit))) {
    txn.debit = Math.round(Number(debit) * 100) / 100;
  }

  if (credit != null && Number.isFinite(Number(credit))) {
    txn.credit = Math.round(Number(credit) * 100) / 100;
  }

  if (validation) txn.validation = validation;
  if (raw) txn.raw = normalizeSpaces(raw).slice(0, 900);

  return categorizeTxn(txn);
}

function validateAccountBalances(rows) {
  if (!rows.length) return rows;

  const tolerance = 0.05;

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];

    if (!cur.validation) cur.validation = {};
    cur.validation.balance_check = 'not_checked';

    if (cur.balance == null || !Number.isFinite(Number(cur.balance))) {
      cur.validation.balance_check = 'missing_balance';
      continue;
    }

    const nextOlder = rows[i + 1];

    if (!nextOlder || nextOlder.balance == null || !Number.isFinite(Number(nextOlder.balance))) {
      cur.validation.balance_check = 'edge_row';
      continue;
    }

    const debit = cur.direction === 'DR' ? Number(cur.amount) : 0;
    const credit = cur.direction === 'CR' ? Number(cur.amount) : 0;

    const expectedOlderBalance = Number(cur.balance) + debit - credit;
    const diff = Math.abs(expectedOlderBalance - Number(nextOlder.balance));

    if (diff <= tolerance) {
      cur.validation.balance_check = 'passed_reverse_order';
      cur.validation.balance_diff = Math.round(diff * 100) / 100;
      continue;
    }

    const expectedCurrentBalance = Number(nextOlder.balance) - debit + credit;
    const diff2 = Math.abs(expectedCurrentBalance - Number(cur.balance));

    if (diff2 <= tolerance) {
      cur.validation.balance_check = 'passed_forward_order';
      cur.validation.balance_diff = Math.round(diff2 * 100) / 100;
      continue;
    }

    cur.validation.balance_check = 'failed';
    cur.validation.balance_diff = Math.round(Math.min(diff, diff2) * 100) / 100;
    cur.validation.exclude_from_pl = true;
  }

  return rows;
}

function dedupePreserveOrder(items) {
  const seen = new Map();
  const out = [];

  for (const t of items) {
    if (!t) continue;

    const key = `${t.date}|${t.direction}|${Number(t.amount).toFixed(2)}|${String(t.merchant).toUpperCase()}|${String(t.reference || '').toUpperCase()}`;
    const count = seen.get(key) || 0;

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

function parsePdfplumberAccountRows(tableRows, filename = null) {
  const rawRows = [];

  for (const r of tableRows || []) {
    const date = isoFromAnyDate(r.postingDate);
    if (!date) continue;

    const debit = parseAmount(r.debit);
    const credit = parseAmount(r.credit);
    const balance = parseAmount(r.balance);

    let direction = null;
    let amount = 0;

    if (debit > 0 && credit === 0) {
      direction = 'DR';
      amount = debit;
    } else if (credit > 0 && debit === 0) {
      direction = 'CR';
      amount = credit;
    } else {
      continue;
    }

    rawRows.push({
      date,
      merchant: r.description || 'Unknown',
      reference: r.reference || null,
      amount,
      direction,
      raw: r.raw || null,
      debit,
      credit,
      balance,
      validation: {
        balance_check: 'pending',
        balance_used_as_amount: false,
        amount_source: direction === 'DR' ? 'pdfplumber_debit_column' : 'pdfplumber_credit_column',
      },
    });
  }

  validateAccountBalances(rawRows);

  const txns = rawRows.map(r => makeTxn({
    date: r.date,
    merchant: r.merchant,
    reference: r.reference,
    amount: r.amount,
    direction: r.direction,
    parser: 'pdfplumber_account_table',
    statement_type: 'bank_account',
    raw: r.raw,
    debit: r.debit,
    credit: r.credit,
    balance: r.balance,
    validation: r.validation,
  }));

  const rows = dedupePreserveOrder(txns.filter(Boolean));

  return {
    parser: rows.length ? 'pdfplumber_account_table' : null,
    rows,
    parse_report: makeParseReport({
      filename,
      parser: 'pdfplumber_account_table',
      rows,
      candidateCount: Array.isArray(tableRows) ? tableRows.length : rows.length,
      qualityScope: 'pdfplumber_table_extraction',
      qualityNote: 'Rows were extracted by pdfplumber from PDF table cells. Debit/Credit columns are used directly. Balance is validation only.',
    }),
  };
}

function makeParseReport({
  filename,
  parser,
  rows,
  candidateCount,
  qualityScope,
  qualityNote,
}) {
  const extracted = rows.length;

  const validationSummary = {
    balance_passed: rows.filter(r => r.validation && String(r.validation.balance_check || '').startsWith('passed')).length,
    balance_failed: rows.filter(r => r.validation && r.validation.balance_check === 'failed').length,
    balance_not_checked: rows.filter(r => r.validation && ['pending', 'not_checked', 'edge_row', 'missing_balance'].includes(r.validation.balance_check)).length,
    balance_used_as_amount: rows.filter(r => r.validation && r.validation.balance_used_as_amount === true).length,
  };

  const confidence = extracted > 0
    ? Math.min(0.99, extracted / Math.max(1, candidateCount || extracted))
    : 0;

  const status = extracted === 0
    ? 'failed'
    : confidence >= 0.95 && validationSummary.balance_failed === 0
      ? 'ok'
      : 'review';

  const warnings = [];

  if (status !== 'ok') {
    warnings.push(`Extracted ${extracted} transaction rows against ${candidateCount} detected rows. Review recommended.`);
  }

  if (validationSummary.balance_failed > 0) {
    warnings.push(`${validationSummary.balance_failed} account row(s) failed running-balance validation and were excluded from P/L.`);
  }

  return {
    filename: filename || null,
    parser,
    status,
    confidence: Math.round(confidence * 100) / 100,
    candidate_date_rows: candidateCount || extracted,
    transactions_extracted: extracted,
    rejected_rows_estimate: Math.max(0, (candidateCount || extracted) - extracted),
    quality_scope: qualityScope,
    quality_note: qualityNote,
    table_region_detected: true,
    validation_summary: validationSummary,
    parser_scores: [
      {
        parser,
        rows: extracted,
        score: extracted,
      },
    ],
    sample_candidate_rows: [],
    warnings,
  };
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
  const balanceIdx = idx('balance');

  if (dateIdx < 0 || descIdx < 0) return [];

  const rows = [];

  for (const line of lines.slice(1)) {
    const cells = split(line);
    const dateIso = isoFromAnyDate(cells[dateIdx]);
    const desc = cells[descIdx];

    if (!dateIso || !desc) continue;

    let direction = null;
    let amount = 0;

    const debit = debitIdx >= 0 ? parseAmount(cells[debitIdx]) : 0;
    const credit = creditIdx >= 0 ? parseAmount(cells[creditIdx]) : 0;
    const balance = balanceIdx >= 0 ? parseAmount(cells[balanceIdx]) : null;

    if (debit > 0 && credit === 0) {
      direction = 'DR';
      amount = debit;
    } else if (credit > 0 && debit === 0) {
      direction = 'CR';
      amount = credit;
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
      statement_type: 'csv',
      raw: line,
      debit,
      credit,
      balance,
    }));
  }

  return rows.filter(Boolean);
}

function parseCardText(text) {
  const rows = [];
  const lines = String(text || '').split(/\n+/).map(normalizeSpaces).filter(Boolean);

  const date = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';

  const twoDateRe = new RegExp(
    `^(${date})\\s+(${date})\\s+(.+?)\\s+(-?\\(?[\\d,]+(?:\\.\\d+)?\\)?|-?\\(?\\.\\d+\\)?)\\s*(CR|DR|C|D|CREDIT|DEBIT)?$`,
    'i'
  );

  const taggedRe = new RegExp(
    `^(${date})\\s+(.+?)\\s+(DR|CR|D|C|DEBIT|CREDIT)\\s+(-?\\(?[\\d,]+(?:\\.\\d+)?\\)?|-?\\(?\\.\\d+\\)?)$`,
    'i'
  );

  for (const line of lines) {
    let m = line.match(twoDateRe);

    if (m) {
      const dateIso = isoFromAnyDate(m[1]);
      const desc = m[3];
      const signed = parseSignedAmount(m[4]);
      const marker = (m[5] || '').toUpperCase();

      if (!dateIso || signed.amount <= 0) continue;

      let direction = 'DR';

      if (/^(CR|C|CREDIT)$/.test(marker)) direction = 'CR';
      else if (/^(DR|D|DEBIT)$/.test(marker)) direction = 'DR';
      else if (signed.isNegative) direction = 'DR';
      else if (/\b(payment received|paymentreceived|refund|reversal|cashback|credit adjustment)\b/i.test(desc)) direction = 'CR';

      rows.push(makeTxn({
        date: dateIso,
        merchant: desc,
        amount: signed.amount,
        direction,
        parser: 'card_text',
        statement_type: 'credit_card',
        raw: line,
      }));

      continue;
    }

    m = line.match(taggedRe);

    if (m) {
      const dateIso = isoFromAnyDate(m[1]);
      const amount = parseAmount(m[4]);

      if (!dateIso || amount <= 0) continue;

      rows.push(makeTxn({
        date: dateIso,
        merchant: m[2],
        amount,
        direction: /^(CR|C|CREDIT)$/i.test(m[3]) ? 'CR' : 'DR',
        parser: 'card_text',
        statement_type: 'credit_card',
        raw: line,
      }));
    }
  }

  return rows.filter(Boolean);
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

    if (t.excluded_from_pl || t.cat === 'internal_transfer') {
      totals.internal_transfer += amt;
    } else if (t.cat === 'income') {
      totals.income += amt;
    } else if (t.cat === 'savings_investments') {
      totals.savings_investments += amt;
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

async function handleExtract(req, res) {
  const { text, filename, tableRows } = req.body || {};

  if (Array.isArray(tableRows) && tableRows.length) {
    const parsed = parsePdfplumberAccountRows(tableRows, filename);
    const summary = summarizeTransactions(parsed.rows);

    return res.status(200).json({
      backend_version: BACKEND_VERSION,
      transactions: parsed.rows,
      count: parsed.rows.length,
      filename: filename || null,
      parser: parsed.parser,
      deterministic: true,
      text_chars: typeof text === 'string' ? text.length : 0,
      lines_detected: parsed.rows.length,
      total_seq: parsed.rows.length,
      skipped_lines: [],
      summary,
      parse_report: parsed.parse_report,
      warning: parsed.parse_report.status !== 'ok'
        ? parsed.parse_report.warnings[0] || 'Rows need review.'
        : null,
    });
  }

  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      error: 'missing_text',
      message: 'No readable text or table rows were provided.',
    });
  }

    const looksLikeAccountStatement =
    /ACCOUNT\s+STATEMENT/i.test(`${filename || ''} ${text || ''}`) ||
    (
      /POSTING\s+DATE/i.test(text || '') &&
      /VALUE\s+DATE/i.test(text || '') &&
      /DEBIT\s+AMOUNT/i.test(text || '') &&
      /CREDIT\s+AMOUNT/i.test(text || '') &&
      /BALANCE/i.test(text || '')
    );

  if (looksLikeAccountStatement) {
    const rows = [];

    const parse_report = makeParseReport({
      filename,
      parser: 'account_statement_requires_table_rows',
      rows,
      candidateCount: 0,
      qualityScope: 'safe_account_statement_guard',
      qualityNote: 'Account statement detected but no pdfplumber tableRows were provided. Fallback card_text parser was blocked to prevent balance values being counted as transaction amounts.',
    });

    parse_report.status = 'failed';
    parse_report.warnings = [
      'Account statement detected, but pdfplumber returned no table rows. This file was not parsed to avoid false income/expense totals.'
    ];

    return res.status(200).json({
      backend_version: BACKEND_VERSION,
      transactions: [],
      count: 0,
      filename: filename || null,
      parser: 'account_statement_requires_table_rows',
      deterministic: false,
      text_chars: text.length,
      lines_detected: 0,
      total_seq: 0,
      skipped_lines: [],
      summary: summarizeTransactions([]),
      parse_report,
      warning: parse_report.warnings[0],
    });
  }

  const csvRows = parseCsvLike(text);
  const cardRows = parseCardText(text);

  const rows = dedupePreserveOrder(
    (csvRows.length >= cardRows.length ? csvRows : cardRows)
  );

  const parser = csvRows.length >= cardRows.length ? 'csv_like' : 'card_text';

  const parse_report = makeParseReport({
    filename,
    parser,
    rows,
    candidateCount: rows.length,
    qualityScope: 'fallback_text_parser',
    qualityNote: 'Fallback parser used because no pdfplumber tableRows were provided.',
  });

  return res.status(200).json({
    backend_version: BACKEND_VERSION,
    transactions: rows,
    count: rows.length,
    filename: filename || null,
    parser,
    deterministic: Boolean(parser),
    text_chars: text.length,
    lines_detected: rows.length,
    total_seq: rows.length,
    skipped_lines: [],
    summary: summarizeTransactions(rows),
    parse_report,
    warning: rows.length ? null : 'No transactions found.',
  });
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

  try {
    const action = req.body?.action;

    if (action === 'extract') {
      return await handleExtract(req, res);
    }

    return res.status(400).json({
      error: 'bad_action',
      message: 'Unknown action. Expected extract.',
    });
  } catch (err) {
    console.error('Handler error:', err);

    return res.status(500).json({
      error: 'unexpected',
      message: err.message || 'Unexpected server error',
    });
  }
}
