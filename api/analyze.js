// WYZ API - Generic Statement Analyzer
// v9:
// - Account statements: Debit/Credit/Balance table shape.
// - Balance is NEVER used as transaction amount.
// - Balance is used only for row validation/checksum where possible.
// - Credit card statements: row-based parser using Amount + CR marker where present.
// - Extraction first, classification second.
// - Internal transfers/card settlements are excluded from P/L.
// - Claude is only used for optional insight generation, never for extraction.
// - v9 fix: strip HH:MM:SS timestamps from account statement records before
//   number extraction to prevent timestamp digit bleed into amounts.

const MODEL = 'claude-haiku-4-5-20251001';
const INSIGHT_MAX_TOKENS = 450;
const INSIGHT_TIMEOUT_MS = 18000;
const MAX_TOTAL_CHARS = 900000;
const REJECT_ABOVE_CHARS = 1400000;

const BACKEND_VERSION = 'strict-account-table-v11-ai-account-parser';

// Prompt sent to Claude Haiku to parse ADCB Islamic account statement rows.
// The raw text from these PDFs has spatial extraction artefacts: timestamps
// bleed into numbers, column order is scrambled, amounts are sometimes 10x wrong.
// Claude reads the semantic meaning of each row rather than relying on position.
const ACCOUNT_PARSE_PROMPT = `You are parsing rows from an ADCB Islamic bank account statement (UAE).
Each row was extracted from a PDF by a spatial text sorter and may contain:
- Two dates (posting date and value date) in DD/MM/YYYY format
- A timestamp like 03:39:59 that is NOT part of the transaction amount
- A description and reference number
- A debit amount, a credit amount (one will be zero), and a running balance
- Trailing reference codes or continuation text

The PDF extraction is corrupted: amounts sometimes have a phantom '0' inserted before the decimal point (e.g. "43320.93" means 4332.93, "92780.93" means 9278.93, "302740.2" means 30274.2). The balance column also suffers the same corruption. Timestamps like "03:39:59" are NOT amounts.

For each row, identify:
1. The posting date (first date, YYYY-MM-DD format)
2. Whether it is DR (debit, money out) or CR (credit, money in) — look at the description semantics: SALARY/CHEQUE DEPOSIT/B/O/MBTRF B/O/dividend = CR; ATM WDL/PUR/MBTRF AED TRF OUT/Installment Recovery/CREDIT CARD PAYMNT/FOREIGN TRANSACTION FEE/SEND MONEY = DR
3. The transaction amount (not the balance) — correct phantom zeros: if a decimal number has a '0' immediately before the decimal point AND the result makes more sense as a transaction amount, remove it
4. The description (exclude dates, timestamps, reference numbers, and amounts)

Return ONLY a JSON array, one object per input row, in the same order:
[{"date":"YYYY-MM-DD","direction":"DR"|"CR","amount":number,"description":"string"},...]

If a row cannot be parsed, include it as null in the array. No explanation.`;

// Parse ADCB account statement records using Claude Haiku.
// Records are the assembled text lines (one per transaction) from extractAccountRecords.
// Returns an array of parsed row objects matching the makeTxn signature.
async function parseAccountTableWithAI(records, apiKey, timeoutMs = 50000) {
  if (!records.length || !apiKey) return [];

  // Batch records into chunks to stay within token limits (~40 rows per call)
  const CHUNK = 40;
  const allRows = [];

  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    // Send as numbered list so Claude can return results in order
    const userContent = chunk.map((r, idx) => `${idx + 1}. ${r}`).join('\n');

    let raw;
    try {
      raw = await callClaude({
        prompt: ACCOUNT_PARSE_PROMPT,
        userContent,
        apiKey,
        maxTokens: 2000,
        timeoutMs,
      });
    } catch (err) {
      console.error('AI account parse error:', err.message);
      // On failure push nulls so the chunk is accounted for
      for (let j = 0; j < chunk.length; j++) allRows.push(null);
      continue;
    }

    // Parse the JSON array response
    let parsed = null;
    try {
      const clean = String(raw).replace(/```json|```/g, '').trim();
      const s = clean.indexOf('[');
      const e = clean.lastIndexOf(']');
      if (s >= 0 && e > s) parsed = JSON.parse(clean.slice(s, e + 1));
    } catch {
      parsed = null;
    }

    if (!Array.isArray(parsed)) {
      for (let j = 0; j < chunk.length; j++) allRows.push(null);
      continue;
    }

    // Map each parsed result to a transaction object
    for (let j = 0; j < chunk.length; j++) {
      const p = parsed[j];
      if (!p || typeof p !== 'object') { allRows.push(null); continue; }

      const txn = makeTxn({
        date:           p.date || null,
        merchant:       p.description || 'Unknown',
        amount:         Number(p.amount) || 0,
        direction:      p.direction === 'CR' ? 'CR' : 'DR',
        currency:       'AED',
        parser:         'account_table_ai',
        statement_type: 'bank_account',
        raw:            chunk[j],
      });

      allRows.push(txn || null);
    }
  }

  return allRows.filter(Boolean);
}

const NUM_SRC = String.raw`-?\(?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|-?\(?\d+(?:\.\d+)?\)?|\.\d+`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function normalizeSpaces(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\uFFFE/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/\uFFFC/g, '')
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

  // Strip standalone HH:MM:SS and HH:MM time tokens that appear in ADCB Islamic account
  // statements. These sit between date columns and amount columns and their digits bleed
  // into adjacent numbers during pdf.js spatial extraction. Strip them here as a second
  // line of defence (the frontend also strips them during extraction).
  t = t.replace(/\b(\d{1,2}:\d{2}:\d{2})\b/g, ' ');

  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

function parseAmount(v) {
  if (v == null) return 0;

  let raw = String(v).trim();

  // Handle balance values like ".56".
  if (/^\.\d+$/.test(raw)) raw = `0${raw}`;

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

function isoFromAnyDate(s) {
  const raw = String(s || '').trim();

  let m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);

  // Default to DD/MM/YYYY for UAE-style statements.
  // If second part cannot be a month, assume MM/DD/YYYY.
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

function looksLikeCreditCardStatement(text) {
  const s = String(text || '').toUpperCase();

  return (
    /CREDIT\s+CARD\s+STATEMENT/.test(s) ||
    /STATEMENT\s+OF\s+ACCOUNT\s+-\s+CREDIT\s+CARD/.test(s) ||
    /CARD\s+NUMBER/.test(s)
  ) && /TRANSACTION\s+DATE/.test(s) && /AMOUNT/.test(s);
}

function isInternalTransferLike(t) {
  const m = String(t.merchant || '').toUpperCase();

  // Credit-card settlements/payments.
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

  // Self/family/person-to-person transfers.
  if (
    /\bTRF\s*OUT\s*TO\s+BASIL\s+ABRAHAM\b/.test(m) ||
    /\bTRF\s*OUT\s*TO\s+BASIL\b/.test(m) ||
    /\bTRF\s*OUT\s*TO\s+SEENA\s+BASIL\b/.test(m) ||
    /\bTRF\s*OUT\s*TO\s+SEENA\b/.test(m) ||
    /\bB\/O\s+BASIL\s+ABRAHAM\b/.test(m) ||
    /\bB\/O\s+BASIL\b/.test(m) ||
    /\bB\/O\s+SEENA\s+BASIL\b/.test(m) ||
    /\bB\/O\s+SEENA\b/.test(m) ||
    /\bSEND\s+MONEY\s+VIA\s+AANI\b/.test(m)
  ) {
    return true;
  }

  // Uncertain incoming credits: ignore first; user can manually move to Income after review.
  if (
    /\bB\/O\s+ALLIANCE\s+INSURANCE\b/.test(m) ||
    /\bALLIANCE\s+INSURANCE\b/.test(m)
  ) {
    return true;
  }

  // ADCB Islamic account: recurring account-to-account debit entries that appear
  // as long numeric account number descriptions (11200001...). These are internal
  // financing/instalment debits and should not count as expenses in P&L.
  // They carry corrupted amounts due to PDF extraction, so excluding them entirely
  // is safer than surfacing wrong figures.
  if (/^\d{25,}$/.test(m.replace(/\s/g, ''))) {
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
      statement_type: 'generic',
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

function fixAccountAmountOcr(s) {
  return String(s || '')
    .replace(/\b[Il]OO\b/g, '100')
    .replace(/\b[Il]00\b/g, '100')
    .replace(/\bO\.OO\b/gi, '0.00')
    .replace(/\bO\.00\b/gi, '0.00')
    .replace(/\b0\.OO\b/gi, '0.00')
    .replace(/\b\.([0-9]{1,2})(?=\s|$)/g, '0.$1');
}

function splitAccountDescriptionAndReference(body) {
  const text = normalizeSpaces(body);

  if (!text) {
    return {
      description: '',
      reference: null,
    };
  }

  // Salary rows:
  let m = text.match(/^(SALARY)\s+(.+)$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  // PHUB reference rows.
  m = text.match(/^(.*?)\s+(PHUB[0-9A-Z]+(?:\s+[0-9A-Z]+)*)$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  // Cheque rows.
  m = text.match(/^(I\/W\s+CLEARING\s+CHEQUE.+?)\s+(\d{4,})$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  // Purchases with card/reference tail.
  m = text.match(/^(.*?\b3342)\s+(\d{5,}(?:\s+[A-Z0-9]+)*)$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  // ATM withdrawal rows with long reference.
  m = text.match(/^(ATM\s+WDL.+?\bAE)\s+([A-Z0-9\s]{8,})$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  // Send Money via Aani rows.
  m = text.match(/^(Send\s+Money\s+via\s+Aani.+?)\s+((?:P2P|PHUB)[A-Z0-9\s]+)$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  // MBTRF/B/O rows with trailing numeric bank reference.
  m = text.match(/^(.*?\b(?:B\/O|TRF\s+OUT\s+TO)\b.*?)\s+(\d{8,})$/i);
  if (m) {
    return {
      description: normalizeSpaces(m[1]),
      reference: normalizeSpaces(m[2]),
    };
  }

  // Pure long-number rows.
  m = text.match(/^(\d{12,})\s+(.+)$/i);
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
      records.push(current.join(' '));
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

function extractNumsWithPosition(rest) {
  const amountRe = new RegExp(`(^|\\s)(${NUM_SRC})(?=\\s|$)`, 'g');
  const nums = [];

  for (const m of rest.matchAll(amountRe)) {
    const prefix = m[1] || '';
    const value = m[2];
    const start = m.index + prefix.length;
    const end = start + value.length;

    nums.push({
      value,
      amount: parseAmount(value),
      start,
      end,
    });
  }

  return nums;
}

// Remove a phantom '0' digit that pdf.js spatial extraction inserts immediately
// before the decimal point in ADCB Islamic account statement amounts.
// The corruption is a literal character insertion: "4332.93" becomes "43320.93",
// "9278.93" becomes "92780.93", "34.84" becomes "340.84".
// Condition: the number must have 2+ integer digits before the phantom '0',
// and the decimal part must be non-zero (integers like 4900 are unaffected).
function removePhantomZero(n) {
  // Use full precision string to avoid float rounding artefacts
  const s = n.toFixed(10).replace(/\.?0+$/, '');
  const m = s.match(/^(\d{2,})0\.(\d+)$/);
  if (m && parseInt(m[2], 10) > 0) return parseFloat(m[1] + '.' + m[2]);
  return n;
}

// Description patterns that force direction in ADCB account statements.
// SALARY and CHEQUE DEPOSIT rows always have credit=nonzero, debit=0,
// but their sequence/cheque reference numbers appear before "00.00" in the
// extracted text, which fools the zero-anchor logic into treating them as DR rows.
// B/O (beneficiary-of) entries are always credits regardless of leading digits.
const ACCT_FORCE_CR = /\b(SALARY|CHEQUE\s+DEPOSIT|B\/O\s)/i;
const ACCT_FORCE_DR = /^(ATM\s+WDL|PUR\s|FOREIGN\s+TRANSACTION|SEND\s+MONEY\s+VIA\s+AANI|I\/W\s+CLEARING\s+CHEQUE)/i;

function parseAccountRecord(rec0) {
  const datePat = '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';

  // Strip HH:MM:SS and HH:MM time tokens before any processing.
  // ADCB Islamic account statement PDFs embed a timestamp column (e.g. 03:39:59)
  // in each row. pdf.js spatial extraction merges these into the same text line as
  // the amount columns. Stripping them here is the second line of defence after
  // the frontend filter.
  const rec = normalizeSpaces(fixAccountAmountOcr(
    String(rec0 || '').replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
  ));

  if (!rec) return null;

  const dateMatches = [...rec.matchAll(new RegExp(datePat, 'g'))];
  if (!dateMatches.length) return null;

  const postingDateIso = isoFromAnyDate(dateMatches[0][0]);
  if (!postingDateIso) return null;

  let rest = rec.slice(dateMatches[0].index + dateMatches[0][0].length).trim();

  // Remove value date if present (second date token at the start of rest).
  const secondDate = rest.match(new RegExp(`^(${datePat})\\b`));
  if (secondDate) {
    rest = rest.slice(secondDate[0].length).trim();
  }

  // Use zero-marker anchoring instead of last-3-numbers.
  // The ADCB account statement columns are: Description | Ref | Debit | Credit | Balance
  // The zero marker (00.00) is always the empty column (Credit=0 for DR, Debit=0 for CR).
  // Numbers before zero = debit (for DR rows); numbers after zero = credit then balance (for CR).
  // Trailing reference codes after the balance are filtered out by the is_ref check below.
  const zeroMarker = rest.match(/(?<![.\d])(0+\.00)(?![.\d])/);
  if (!zeroMarker) return null;

  const zeroIdx  = zeroMarker.index;
  const afterIdx = zeroIdx + zeroMarker[0].length;
  const beforeStr = rest.slice(0, zeroIdx).trim();
  const afterStr  = rest.slice(afterIdx).trim();

  // Extract standalone non-reference numbers from a string.
  // Bank reference numbers are large integers (>= 1,000,000); filter them out.
  function extractAmountNums(s) {
    const amountRe = new RegExp(`(^|\\s)(${NUM_SRC})(?=\\s|$)`, 'g');
    const out = [];
    for (const m of s.matchAll(amountRe)) {
      const v = parseAmount(m[2]);
      const isRef = v >= 1_000_000 && Number.isInteger(v);
      if (!isRef) out.push({ raw: m[2], amount: v, start: m.index + m[1].length });
    }
    return out;
  }

  const beforeNums = extractAmountNums(beforeStr);
  const afterNums  = extractAmountNums(afterStr);

  // Determine direction using description pattern overrides first,
  // then fall back to zero-anchor position logic.
  const forceCR = ACCT_FORCE_CR.test(beforeStr);
  const forceDR = ACCT_FORCE_DR.test(beforeStr);

  let amount, direction, body, balanceRaw;

  if (forceCR || (!forceDR && beforeNums.length === 0)) {
    // CR row: amount is first non-ref number after zero
    if (afterNums.length === 0) return null;
    amount    = removePhantomZero(afterNums[0].amount);
    direction = 'CR';
    body      = beforeStr;
    balanceRaw = afterNums.length > 1 ? removePhantomZero(afterNums[1].amount) : null;
  } else {
    // DR row: amount is last non-ref number before zero
    if (beforeNums.length === 0) return null;
    const debitToken = beforeNums[beforeNums.length - 1];
    amount    = removePhantomZero(debitToken.amount);
    direction = 'DR';
    const pos = beforeStr.lastIndexOf(debitToken.raw, debitToken.start + debitToken.raw.length);
    body      = normalizeSpaces(beforeStr.slice(0, pos >= 0 ? pos : beforeStr.length));
    balanceRaw = afterNums.length > 0 ? removePhantomZero(afterNums[0].amount) : null;
  }

  if (!amount || amount <= 0) return null;

  const split = splitAccountDescriptionAndReference(body);
  if (!split.description || split.description.length < 2) return null;

  return {
    date: postingDateIso,
    merchant: split.description,
    reference: split.reference,
    amount: Math.round(amount * 100) / 100,
    direction,
    debit:   direction === 'DR' ? Math.round(amount * 100) / 100 : 0,
    credit:  direction === 'CR' ? Math.round(amount * 100) / 100 : 0,
    balance: balanceRaw != null ? Math.round(balanceRaw * 100) / 100 : null,
    raw: rec,
    validation: {
      balance_check: 'pending',
      balance_used_as_amount: false,
    },
  };
}

function validateRunningBalances(parsed) {
  if (!parsed.length) return parsed;

  const tolerance = 0.05;

  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];

    if (!cur.validation) cur.validation = {};

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

    const expectedOlderBalance =
      Number(cur.balance) + Number(cur.debit || 0) - Number(cur.credit || 0);

    const diff = Math.abs(expectedOlderBalance - Number(nextOlder.balance));

    if (diff <= tolerance) {
      cur.validation.balance_check = 'passed_reverse_order';
      cur.validation.balance_diff = Math.round(diff * 100) / 100;
    } else {
      const expectedCurrentBalance =
        Number(nextOlder.balance) - Number(cur.debit || 0) + Number(cur.credit || 0);

      const diff2 = Math.abs(expectedCurrentBalance - Number(cur.balance));

      if (diff2 <= tolerance) {
        cur.validation.balance_check = 'passed_forward_order';
        cur.validation.balance_diff = Math.round(diff2 * 100) / 100;
      } else {
        cur.validation.balance_check = 'failed';
        cur.validation.balance_diff = Math.round(Math.min(diff, diff2) * 100) / 100;
      }
    }
  }

  return parsed;
}

function parseAccountTable(text) {
  const records = extractAccountRecords(text);
  const parsed = [];

  for (const rec of records) {
    const row = parseAccountRecord(rec);
    if (row) parsed.push(row);
  }

  validateRunningBalances(parsed);

  const rows = parsed.map(r => makeTxn({
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
  }));

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

function dedupePreserveOrder(items) {
  const seen = new Map();
  const out = [];

  for (const t of items) {
    if (!t) continue;

    const key = `${t.date}|${t.direction}|${Number(t.amount).toFixed(2)}|${String(t.merchant).toUpperCase()}|${String(t.reference || '').toUpperCase()}`;
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

  return {
    text: lines.slice(start, end).join('\n'),
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

  if (tableRegion.found && tableCandidate.count < Math.max(1, rows.length * 0.5)) {
    candidate = fullCandidate;
    qualityScope = 'full_text_fallback';
    qualityNote = 'Detected table region undercounted rows due to PDF extraction order, so full text candidate count was used.';
  }

  const extracted = rows.length;
  const rejected = Math.max(0, candidate.count - extracted);

  const validationSummary = {
    balance_passed: rows.filter(r => r.validation && String(r.validation.balance_check || '').startsWith('passed')).length,
    balance_failed: rows.filter(r => r.validation && r.validation.balance_check === 'failed').length,
    balance_not_checked: rows.filter(r => r.validation && ['pending', 'not_checked', 'edge_row', 'missing_balance'].includes(r.validation.balance_check)).length,
    balance_used_as_amount: rows.filter(r => r.validation && r.validation.balance_used_as_amount === true).length,
  };

  let confidence = 0;

  if (extracted > 0) {
    confidence = candidate.count > 0
      ? Math.min(0.99, extracted / Math.max(extracted, candidate.count))
      : 0.85;

    if (/generic|signed|csv/i.test(parser || '')) {
      confidence = Math.max(0.62, confidence - 0.08);
    }

    if (validationSummary.balance_failed > 0) {
      confidence = Math.max(0.55, confidence - 0.15);
    }
  }

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
    warnings.push(`Extracted ${extracted} transaction rows against ${candidate.count} estimated transaction-table candidate rows. Review recommended.`);
  }

  if (validationSummary.balance_failed > 0) {
    warnings.push(`${validationSummary.balance_failed} account-statement row(s) failed running-balance validation.`);
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
    validation_summary: validationSummary,
    parser_scores: (candidates || []).map(c => ({
      parser: c.name,
      rows: c.rows.length,
      score: Math.round(scoreParse(c.rows, cleaned) * 1000) / 1000,
    })),
    sample_candidate_rows: candidate.samples,
    warnings,
  };
}

async function deterministicExtract(text, filename = null, apiKey = null) {
  const cleaned = cleanStatementText(text);
  const isBankAccount = looksLikeBankAccountStatement(cleaned);
  const isCreditCard = looksLikeCreditCardStatement(cleaned);

  // For bank account statements: use the AI-powered parser which can handle
  // the ADCB Islamic PDF spatial extraction artefacts that defeat regex approaches.
  // Fall back to the deterministic account_table parser if AI is unavailable.
  let accountRows = [];
  if (isBankAccount) {
    if (apiKey) {
      const records = extractAccountRecords(cleaned);
      accountRows = await parseAccountTableWithAI(records, apiKey);
    }
    // Fall back to deterministic parser if AI returned nothing
    if (accountRows.length === 0) {
      accountRows = parseAccountTable(cleaned);
    }
  }

  const cardRows = parseTwoDateCard(cleaned);

  const candidates = [
    { name: 'csv_like', rows: parseCsvLike(cleaned) },
    { name: 'tagged_single_date', rows: parseTaggedSingleDate(cleaned) },
    { name: 'two_date_card', rows: cardRows },
    { name: 'account_table', rows: accountRows },
    { name: 'signed_amount', rows: parseSignedAmountRows(cleaned) },
    { name: 'payslip', rows: parsePayslip(cleaned) },
  ];

  let best = null;

  if (isBankAccount && accountRows.length > 0) {
    best = { name: 'account_table', rows: accountRows };
  } else if (isCreditCard && cardRows.length > 0) {
    best = { name: 'two_date_card', rows: cardRows };
  }

  if (!best) {
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
    warning: isBankAccount && accountRows.length === 0
      ? 'Bank account statement detected but no rows extracted. AI parser unavailable or returned no results.'
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

async function handleExtract(req, res, apiKey) {
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

  const { parser, rows, cleaned, parse_report } = await deterministicExtract(input, filename, apiKey);
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
      return await handleExtract(req, res, apiKey);
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
