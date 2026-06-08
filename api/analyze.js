// WYZ API - Generic Statement Analyzer
// v16-zero-marker-balance-safe
//
// Core fixes:
// - Account statements are parsed deterministically first.
// - Account statement amount is taken ONLY from Debit Amount or Credit Amount.
// - Balance is never used as transaction amount.
// - Account parser uses the 0.00 marker, row kind, and balance validation.
// - AI is no longer the primary parser for account statements.
// - Credit card parser remains deterministic.
// - User still decides savings, family/personal transfers, uncertain credits, etc.

const BACKEND_VERSION = 'strict-account-table-v16-zero-marker-balance-safe';

const MODEL = 'claude-haiku-4-5-20251001';
const INSIGHT_MAX_TOKENS = 450;
const INSIGHT_TIMEOUT_MS = 18000;
const MAX_TOTAL_CHARS = 900000;
const REJECT_ABOVE_CHARS = 1400000;

const NUM_SRC = String.raw`-?\(?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|-?\(?\d+(?:\.\d+)?\)?|\.\d+`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizeSpaces(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/\uFFFC/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function cleanStatementText(text) {
  if (!text) return '';

  let t = String(text).replace(/\r/g, '\n');

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

function stripTimeTokens(s) {
  return String(s || '').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
}

function parseAmount(v) {
  if (v == null) return 0;

  let raw = String(v).trim();

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

function amountTokenRegex() {
  return new RegExp(`(?:${NUM_SRC})`, 'g');
}

function isNoiseLine(line) {
  const l = String(line || '').toLowerCase();

  return !line ||
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
    l.includes('cashlimit available') ||
    l.includes('time-to-settle') ||
    l.includes('licensed by the central bank') ||
    l.includes('commercial bank of dubai psc') ||
    l.includes('for feedback/complaints') ||
    l.includes('website:www.cbd.ae') ||
    l.includes('end of statement') ||
    /^\*{3,}/.test(line);
}

function looksLikeBankAccountStatement(text) {
  const s = String(text || '').toUpperCase();

  return (
    /ACCOUNT\s+STATEMENT/.test(s) ||
    /ACCOUNT\s+NUMBER/.test(s)
  ) &&
    /POSTING\s+DATE/.test(s) &&
    /VALUE\s+DATE/.test(s) &&
    /DEBIT\s+AMOUNT/.test(s) &&
    /CREDIT\s+AMOUNT/.test(s) &&
    /BALANCE/.test(s);
}

function looksLikeCreditCardStatement(text) {
  const s = String(text || '').toUpperCase();

  return (
    /CREDIT\s+CARD\s+STATEMENT/.test(s) ||
    /STATEMENT\s+OF\s+ACCOUNT\s+-\s+CREDIT\s+CARD/.test(s) ||
    /CARD\s+NUMBER/.test(s) ||
    /TRANSACTION\s+DATE\s+DESCRIPTION\s+CR\/DR\s+AMOUNT/.test(s)
  ) &&
    /TRANSACTION\s+DATE/.test(s) &&
    /AMOUNT/.test(s);
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

function compactRows(rows) {
  return rows.filter(Boolean);
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
      statement_type: 'csv',
      raw: line,
    }));
  }

  return compactRows(rows);
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
    const amount = parseAmount(m[4]);

    if (!dateIso || amount <= 0) continue;

    rows.push(makeTxn({
      date: dateIso,
      merchant: m[2],
      amount,
      direction: /^(CR|C|CREDIT)$/i.test(m[3]) ? 'CR' : 'DR',
      parser: 'tagged_single_date',
      statement_type: 'credit_card',
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
    if (/^\d{6}\*+\d+/.test(line)) continue;

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
    else if (/\b(payment received|paymentreceived|refund|reversal|cashback|credit adjustment)\b/i.test(desc)) direction = 'CR';

    rows.push(makeTxn({
      date: dateIso,
      merchant: desc,
      amount: signed.amount,
      direction,
      parser: 'two_date_card',
      statement_type: 'credit_card',
      raw: line,
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
      statement_type: 'generic',
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
      statement_type: 'payslip',
      raw: 'Net Pay',
    }),
  ]);
}

function fixAccountAmountOcr(s) {
  return String(s || '')
    .replace(/\b[Il]OO\b/g, '100')
    .replace(/\b[Il]00\b/g, '100')
    .replace(/\bO\.OO\b/gi, '0.00')
    .replace(/\bO\.00\b/gi, '0.00')
    .replace(/\b0\.OO\b/gi, '0.00')
    .replace(/\b(\d{1,6})[Oo]{2}\b/g, '$1.00')
    .replace(/\b\.([0-9]{1,2})(?=\s|$)/g, '0.$1');
}

function accountRecordStartRegex() {
  const datePat = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';

  return new RegExp(`^${datePat}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?(?:\\s+${datePat})?\\b`);
}

function extractAccountRecords(text) {
  const rawLines = String(text || '')
    .split(/\n+/)
    .map(normalizeSpaces)
    .filter(Boolean);

  const records = [];
  let current = [];
  const startRe = accountRecordStartRegex();

  function flush() {
    if (current.length) {
      const rec = normalizeSpaces(current.join(' '));
      if (rec) records.push(rec);
      current = [];
    }
  }

  for (const line of rawLines) {
    if (isNoiseLine(line)) continue;

    const startsRecord = startRe.test(line);

    if (startsRecord) {
      flush();
      current.push(line);
    } else if (current.length) {
      current.push(line);
    }
  }

  flush();

  return records;
}

function extractAmountTokens(s) {
  const amountRe = new RegExp(`(^|\\s)(${NUM_SRC})(?=\\s|$)`, 'g');
  const out = [];

  for (const m of String(s || '').matchAll(amountRe)) {
    const raw = m[2];
    const val = parseAmount(raw);

    if (!Number.isFinite(val)) continue;

    out.push({
      raw,
      amount: val,
      start: m.index + (m[1] || '').length,
      end: m.index + (m[1] || '').length + raw.length,
    });
  }

  return out;
}

function accountRowKind(text) {
  const s = String(text || '').toUpperCase();

  if (
    /\bSALARY\b/.test(s) ||
    /\bCHEQUE\s+DEPOSIT\b/.test(s) ||
    /\bB\/O\b/.test(s) ||
    /\bADX\s+DIVIDEND\b/.test(s) ||
    /\bDIVIDEND\b/.test(s) ||
    /\bAPOLLO\s+FLIGHT\b/.test(s) ||
    /\bUNION\s+HOLDING\b/.test(s)
  ) {
    return 'CR';
  }

  if (
    /^PUR\b/.test(s) ||
    /^ATM\s+WDL\b/.test(s) ||
    /^FOREIGN\s+TRANSACTION/.test(s) ||
    /^SEND\s+MONEY\s+VIA\s+AANI/.test(s) ||
    /^I\/W\s+CLEARING\s+CHEQUE/.test(s) ||
    /\bMBTRF\b/.test(s) ||
    /\bTRF\s+OUT\b/.test(s) ||
    /\bCREDIT\s+CARD\s+PAYMNT\b/.test(s) ||
    /\bCREDIT\s+CARD\s+PAYMENT\b/.test(s) ||
    /\bINSTALLMENT\s+RECOVERY\b/.test(s) ||
    /\bINSTALMENT\s+RECOVERY\b/.test(s)
  ) {
    return 'DR';
  }

  return 'UNKNOWN';
}

function isTinyReferenceTail(token) {
  const raw = String(token?.raw || '').replace(/[^\d]/g, '');

  return raw.length >= 3 && raw.length <= 5 && Number.isInteger(token.amount);
}

function isLongIntegerReference(token) {
  const raw = String(token?.raw || '').replace(/[^\d]/g, '');

  return raw.length >= 7 && Number.isInteger(token.amount);
}

function isReferenceToken(token) {
  return isTinyReferenceTail(token) || isLongIntegerReference(token);
}

function validMoneyToken(token) {
  if (!token) return false;
  if (!Number.isFinite(Number(token.amount))) return false;
  if (isReferenceToken(token)) return false;
  return true;
}

function nearestMoneyBefore(tokens, zeroToken) {
  const before = tokens
    .filter(t => t.end <= zeroToken.start)
    .filter(validMoneyToken);

  return before.length ? before[before.length - 1] : null;
}

function moneyAfter(tokens, zeroToken) {
  return tokens
    .filter(t => t.start >= zeroToken.end)
    .filter(validMoneyToken);
}

function findZeroMarker(tokens) {
  return tokens.find(t => parseAmount(t.raw) === 0 && /0+\.0+/.test(String(t.raw)));
}

function amountCandidates(n) {
  const v = Number(n) || 0;
  const out = [v];

  if (v >= 1000) out.push(v / 10);
  if (v >= 1000) out.push(v / 100);
  if (v >= 10000) out.push(v / 1000);

  return [...new Set(out.map(x => Math.round(x * 100) / 100))]
    .filter(x => x > 0);
}

function applyAmountToParsedRow(row, candidate) {
  const amt = Math.round(Number(candidate) * 100) / 100;

  row.amount = amt;

  if (row.direction === 'DR') {
    row.debit = amt;
    row.credit = 0;
  } else {
    row.credit = amt;
    row.debit = 0;
  }

  return row;
}

function splitAccountDescriptionAndReference(body) {
  const text = normalizeSpaces(body);

  if (!text) {
    return {
      description: '',
      reference: null,
    };
  }

  let m = text.match(/^(SALARY)\s+(.+)$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  m = text.match(/^(.*?)\s+(PHUB[0-9A-Z]+(?:\s+[0-9A-Z]+)*)$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  m = text.match(/^(I\/W\s+CLEARING\s+CHEQUE.+?)\s+(\d{4,})$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  m = text.match(/^(.*?\b3342)\s+(\d{4,})$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  m = text.match(/^(ATM\s+WDL.+?\bAE)\s+([A-Z0-9\s]{8,})$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  m = text.match(/^(Send\s+Money\s+via\s+Aani.+?)\s+((?:P2P|PHUB)[A-Z0-9\s]+)$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  m = text.match(/^(.*?\b(?:B\/O|TRF\s+OUT\s+TO)\b.*?)\s+(\d{8,})$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  return {
    description: text,
    reference: null,
  };
}

function parseAccountRecordDeterministic(rec0) {
  const datePat = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';

  const rec = normalizeSpaces(fixAccountAmountOcr(stripTimeTokens(rec0)));
  if (!rec) return null;

  const dateMatches = [...rec.matchAll(new RegExp(datePat, 'g'))];
  if (!dateMatches.length) return null;

  const postingDateIso = isoFromAnyDate(dateMatches[0][0]);
  if (!postingDateIso) return null;

  let rest = rec.slice(dateMatches[0].index + dateMatches[0][0].length).trim();

  const secondDate = rest.match(new RegExp(`^(${datePat})\\b`));
  if (secondDate) {
    rest = rest.slice(secondDate[0].length).trim();
  }

  const tokens = extractAmountTokens(rest);
  const zero = findZeroMarker(tokens);

  if (!zero) return null;

  const kind = accountRowKind(rest);

  let direction = null;
  let amountToken = null;
  let balanceToken = null;

  if (kind === 'DR') {
    direction = 'DR';

    amountToken = nearestMoneyBefore(tokens, zero);

    const after = moneyAfter(tokens, zero);
    balanceToken = after[0] || null;
  } else if (kind === 'CR') {
    direction = 'CR';

    const after = moneyAfter(tokens, zero);
    amountToken = after[0] || null;
    balanceToken = after[1] || null;
  } else {
    const before = nearestMoneyBefore(tokens, zero);
    const after = moneyAfter(tokens, zero);

    if (before && after.length) {
      direction = 'DR';
      amountToken = before;
      balanceToken = after[0] || null;
    } else if (!before && after.length >= 1) {
      direction = 'CR';
      amountToken = after[0] || null;
      balanceToken = after[1] || null;
    } else {
      return null;
    }
  }

  if (!amountToken || !direction) return null;

  let amount = parseAmount(amountToken.raw);
  if (!amount || amount <= 0) return null;

  const balance = balanceToken ? parseAmount(balanceToken.raw) : null;

  let body = normalizeSpaces(rest.slice(0, amountToken.start));
  body = normalizeSpaces(body.replace(/\b0+\.0+\b\s*$/g, ''));

  const split = splitAccountDescriptionAndReference(body);

  if (!split.description || split.description.length < 2) return null;

  const row = {
    date: postingDateIso,
    merchant: split.description,
    reference: split.reference,
    amount: Math.round(amount * 100) / 100,
    direction,
    debit: direction === 'DR' ? Math.round(amount * 100) / 100 : 0,
    credit: direction === 'CR' ? Math.round(amount * 100) / 100 : 0,
    balance: balance != null ? Math.round(balance * 100) / 100 : null,
    raw: rec,
    validation: {
      balance_check: 'not_checked',
      balance_used_as_amount: false,
      amount_source: direction === 'DR' ? 'debit_zero_marker' : 'credit_zero_marker',
      row_kind: kind,
      amount_raw: amountToken.raw,
      balance_raw: balanceToken ? balanceToken.raw : null,
    },
  };

  if (
    row.direction === 'CR' &&
    /^(PUR|ATM\s+WDL|FOREIGN\s+TRANSACTION|INSTALLMENT|INSTALMENT)/i.test(row.merchant)
  ) {
    row.validation.balance_check = 'suspected_balance_leak';
    row.validation.exclude_from_pl = true;
  }

  return row;
}

function validateRunningBalances(parsed) {
  if (!parsed.length) return parsed;

  const tolerance = 0.05;

  function checkDiff(cur, nextOlder, amountOverride = null) {
    const debit = cur.direction === 'DR'
      ? Number(amountOverride ?? cur.debit ?? cur.amount ?? 0)
      : 0;

    const credit = cur.direction === 'CR'
      ? Number(amountOverride ?? cur.credit ?? cur.amount ?? 0)
      : 0;

    const expectedOlderBalance =
      Number(cur.balance) + debit - credit;

    return Math.abs(expectedOlderBalance - Number(nextOlder.balance));
  }

  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];

    if (!cur.validation) cur.validation = {};

    if (cur.validation.balance_check === 'suspected_balance_leak') {
      cur.validation.exclude_from_pl = true;
      continue;
    }

    cur.validation.balance_check = 'not_checked';

    if (cur.balance == null || !Number.isFinite(Number(cur.balance))) {
      cur.validation.balance_check = 'missing_balance';
      continue;
    }

    const nextOlder = parsed[i + 1];

    if (!nextOlder || nextOlder.balance == null || !Number.isFinite(Number(nextOlder.balance))) {
      cur.validation.balance_check = 'edge_row';
      continue;
    }

    const baseDiff = checkDiff(cur, nextOlder);

    if (baseDiff <= tolerance) {
      cur.validation.balance_check = 'passed_reverse_order';
      cur.validation.balance_diff = Math.round(baseDiff * 100) / 100;
      continue;
    }

    let best = {
      amount: Number(cur.amount),
      diff: baseDiff,
    };

    for (const candidate of amountCandidates(cur.amount)) {
      const d = checkDiff(cur, nextOlder, candidate);

      if (d < best.diff) {
        best = {
          amount: candidate,
          diff: d,
        };
      }
    }

    if (best.diff <= tolerance && best.amount !== Number(cur.amount)) {
      applyAmountToParsedRow(cur, best.amount);
      cur.validation.balance_check = 'passed_after_scale_fix';
      cur.validation.scale_fixed_amount = best.amount;
      cur.validation.balance_diff = Math.round(best.diff * 100) / 100;
      continue;
    }

    const debit = Number(cur.debit || 0);
    const credit = Number(cur.credit || 0);

    const expectedCurrentBalance =
      Number(nextOlder.balance) - debit + credit;

    const diff2 = Math.abs(expectedCurrentBalance - Number(cur.balance));

    if (diff2 <= tolerance) {
      cur.validation.balance_check = 'passed_forward_order';
      cur.validation.balance_diff = Math.round(diff2 * 100) / 100;
      continue;
    }

    cur.validation.balance_check = 'failed';
    cur.validation.balance_diff = Math.round(Math.min(baseDiff, diff2) * 100) / 100;

    if (
      Number(cur.amount) >= 10000 &&
      !/\bSALARY\b/i.test(cur.merchant)
    ) {
      cur.validation.exclude_from_pl = true;
    }
  }

  return parsed;
}

function parseAccountTableDeterministic(text) {
  const records = extractAccountRecords(text);
  const parsed = [];

  for (const rec of records) {
    const row = parseAccountRecordDeterministic(rec);
    if (row) parsed.push(row);
  }

  validateRunningBalances(parsed);

  const rows = parsed.map(r => {
    const txn = makeTxn({
      date: r.date,
      merchant: r.merchant,
      reference: r.reference,
      amount: r.amount,
      direction: r.direction,
      parser: 'account_table',
      statement_type: 'bank_account',
      raw: r.raw,
      debit: r.debit,
      credit: r.credit,
      balance: r.balance,
      validation: r.validation,
    });

    if (txn && r.validation && r.validation.exclude_from_pl) {
      txn.cat = 'internal_transfer';
      txn.sub = 'parser_review_excluded';
      txn.type = 'review_excluded';
      txn.excluded_from_pl = true;
      txn.note = 'Excluded because account parser detected possible balance/scale corruption.';
    }

    return txn;
  });

  return {
    rows: compactRows(rows),
    records,
  };
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

function countCandidateRowsLoose(text) {
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
    const hasMoneyWords = /\b(DR|CR|DEBIT|CREDIT|WITHDRAWAL|DEPOSIT|PAID\s*OUT|PAID\s*IN|BALANCE)\b/i.test(line);

    if (hasDate && (money.length >= 1 || hasMoneyWords)) {
      count++;
      if (samples.length < 8) samples.push(line.slice(0, 240));
    }
  }

  return {
    count,
    samples,
  };
}

function makeParseReport({ filename, parser, rows, cleaned, candidates, accountRecordCount = null, warning = null }) {
  const extracted = rows.length;

  let candidateCount;
  let qualityScope;
  let qualityNote;

  if (parser === 'account_table' && accountRecordCount != null) {
    candidateCount = accountRecordCount;
    qualityScope = 'account_table_records';
    qualityNote = 'Candidate rows are account-table records detected from Posting Date rows. Balance is validation only.';
  } else if (parser === 'two_date_card' || parser === 'tagged_single_date') {
    candidateCount = extracted;
    qualityScope = 'parser_confirmed_transaction_rows';
    qualityNote = 'Candidate rows are parser-confirmed card transaction rows, excluding statement summaries, balances, headers and footers.';
  } else {
    const loose = countCandidateRowsLoose(cleaned);
    candidateCount = Math.max(extracted, loose.count);
    qualityScope = 'loose_full_text_fallback';
    qualityNote = 'Candidate rows estimated from loose date/amount patterns. Review recommended if this is low.';
  }

  const confidence = extracted > 0
    ? Math.min(0.99, extracted / Math.max(1, candidateCount))
    : 0;

  const validationSummary = {
    balance_passed: rows.filter(r => r.validation && String(r.validation.balance_check || '').startsWith('passed')).length,
    balance_failed: rows.filter(r => r.validation && r.validation.balance_check === 'failed').length,
    balance_ai_parsed: rows.filter(r => r.validation && r.validation.balance_check === 'ai_parsed').length,
    balance_not_checked: rows.filter(r => r.validation && ['pending', 'not_checked', 'edge_row', 'missing_balance', 'suspected_balance_leak'].includes(r.validation.balance_check)).length,
    balance_used_as_amount: rows.filter(r => r.validation && r.validation.balance_used_as_amount === true).length,
  };

  const status = extracted === 0
    ? 'failed'
    : confidence >= 0.95 && validationSummary.balance_failed === 0
      ? 'ok'
      : 'review';

  const warnings = [];

  if (warning) warnings.push(warning);

  if (extracted === 0) {
    warnings.push('No transaction rows were extracted. This format may need OCR or another parser.');
  } else if (status !== 'ok') {
    warnings.push(`Extracted ${extracted} transaction rows against ${candidateCount} parser-estimated transaction rows. Review recommended.`);
  }

  if (validationSummary.balance_failed > 0) {
    warnings.push(`${validationSummary.balance_failed} account-statement row(s) failed running-balance validation.`);
  }

  return {
    filename: filename || null,
    parser: parser || null,
    status,
    confidence: Math.round(confidence * 100) / 100,
    candidate_date_rows: candidateCount,
    transactions_extracted: extracted,
    rejected_rows_estimate: Math.max(0, candidateCount - extracted),
    quality_scope: qualityScope,
    quality_note: qualityNote,
    table_region_detected: true,
    validation_summary: validationSummary,
    parser_scores: (candidates || []).map(c => ({
      parser: c.name,
      rows: c.rows.length,
      score: c.rows.length,
    })),
    sample_candidate_rows: [],
    warnings,
  };
}

async function deterministicExtract(text, filename = null) {
  const cleaned = cleanStatementText(text);
  const isBankAccount = looksLikeBankAccountStatement(cleaned);
  const isCreditCard = looksLikeCreditCardStatement(cleaned);

  let accountResult = {
    rows: [],
    records: [],
  };

  if (isBankAccount) {
    accountResult = parseAccountTableDeterministic(cleaned);
  }

  const taggedRows = parseTaggedSingleDate(cleaned);
  const twoDateRows = parseTwoDateCard(cleaned);

  const candidates = [
    { name: 'csv_like', rows: parseCsvLike(cleaned) },
    { name: 'tagged_single_date', rows: taggedRows },
    { name: 'two_date_card', rows: twoDateRows },
    { name: 'account_table', rows: accountResult.rows },
    { name: 'signed_amount', rows: parseSignedAmountRows(cleaned) },
    { name: 'payslip', rows: parsePayslip(cleaned) },
  ];

  let best = null;
  let warning = null;

  if (isBankAccount) {
    best = {
      name: 'account_table',
      rows: accountResult.rows,
    };

    if (accountResult.records.length && accountResult.rows.length < accountResult.records.length) {
      warning = `Bank account table detected ${accountResult.records.length} candidate rows but extracted ${accountResult.rows.length}.`;
    }
  } else if (isCreditCard && twoDateRows.length > 0) {
    best = {
      name: 'two_date_card',
      rows: twoDateRows,
    };
  } else if (taggedRows.length > 0) {
    best = {
      name: 'tagged_single_date',
      rows: taggedRows,
    };
  } else {
    candidates.sort((a, b) => b.rows.length - a.rows.length);
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
    accountRecordCount: isBankAccount ? accountResult.records.length : null,
    warning,
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

    if (t.cat === 'income') totals.income += amt;
    else if (t.cat === 'savings_investments') totals.savings_investments += amt;
    else if (t.cat === 'internal_transfer') totals.internal_transfer += amt;
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

  const { parser, rows, cleaned, parse_report } = await deterministicExtract(input, filename);
  const summary = summarizeTransactions(rows);

  const response = {
    backend_version: BACKEND_VERSION,
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
