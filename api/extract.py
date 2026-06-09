from http.server import BaseHTTPRequestHandler
from io import BytesIO
from email.parser import BytesParser
from email.policy import default
import json
import re
import traceback
import pdfplumber


VERSION = "pdfplumber-extract-v19d-table-plus-text-fallback"


def cors_headers(handler):
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")


def send_json(handler, status, payload):
    handler.send_response(status)
    cors_headers(handler)
    handler.send_header("Content-Type", "application/json")
    handler.end_headers()
    handler.wfile.write(json.dumps(payload).encode("utf-8"))


def clean_cell(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\n", " ")).strip()


def amountish(value):
    value = clean_cell(value)
    if not value:
        return ""
    value = re.sub(r"[^\d.,\-()]", "", value)
    return value.strip()


def parse_amount(value):
    value = amountish(value)
    if not value:
        return 0.0

    value = value.replace(",", "")
    value = value.replace("(", "").replace(")", "")

    try:
        return abs(float(value))
    except Exception:
        return 0.0


def is_zero_amount(value):
    return abs(parse_amount(value)) < 0.005


def is_date(value):
    value = clean_cell(value)
    return bool(
        re.match(r"^\d{1,2}[/-]\d{1,2}[/-]\d{4}$", value)
        or re.match(r"^\d{4}[/-]\d{1,2}[/-]\d{1,2}$", value)
    )


def normalize_header(value):
    value = clean_cell(value).lower()
    value = value.replace("/", " ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def find_account_header(row):
    joined = " ".join(normalize_header(c) for c in row)

    required = [
        "posting date",
        "value date",
        "description",
        "debit amount",
        "credit amount",
        "balance",
    ]

    if not all(x in joined for x in required):
        return None

    mapping = {
        "postingDate": None,
        "valueDate": None,
        "description": None,
        "reference": None,
        "debit": None,
        "credit": None,
        "balance": None,
    }

    for i, cell in enumerate(row):
        h = normalize_header(cell)

        if "posting" in h and "date" in h:
            mapping["postingDate"] = i
        elif "value" in h and "date" in h:
            mapping["valueDate"] = i
        elif "description" in h:
            mapping["description"] = i
        elif "ref" in h or "cheque" in h or "check" in h:
            mapping["reference"] = i
        elif "debit" in h:
            mapping["debit"] = i
        elif "credit" in h:
            mapping["credit"] = i
        elif "balance" in h:
            mapping["balance"] = i

    if mapping["postingDate"] is None and len(row) >= 7:
        mapping = {
            "postingDate": 0,
            "valueDate": 1,
            "description": 2,
            "reference": 3,
            "debit": 4,
            "credit": 5,
            "balance": 6,
        }

    if mapping["postingDate"] is None or mapping["debit"] is None or mapping["credit"] is None:
        return None

    return mapping


def get_cell(row, index):
    if index is None:
        return ""
    if index < 0 or index >= len(row):
        return ""
    return clean_cell(row[index])


def parse_account_table(table, page_no):
    output = []
    header_map = None
    header_index = None

    for i, row in enumerate(table or []):
        row = row or []
        found = find_account_header(row)

        if found:
            header_map = found
            header_index = i
            break

    if not header_map:
        return []

    current = None

    for row in table[header_index + 1:]:
        row = row or []

        posting = get_cell(row, header_map["postingDate"])
        value_date = get_cell(row, header_map["valueDate"])
        description = get_cell(row, header_map["description"])
        reference = get_cell(row, header_map["reference"])
        debit = amountish(get_cell(row, header_map["debit"]))
        credit = amountish(get_cell(row, header_map["credit"]))
        balance = amountish(get_cell(row, header_map["balance"]))

        raw = " ".join(clean_cell(c) for c in row if clean_cell(c))
        upper_raw = raw.upper()

        if not raw:
            continue
        if "OPENING BALANCE" in upper_raw or "CLOSING BALANCE" in upper_raw:
            continue
        if "TOTAL" in upper_raw and not is_date(posting):
            continue
        if "END OF STATEMENT" in upper_raw:
            continue

        if is_date(posting):
            if current:
                output.append(current)

            current = {
                "source": "pdfplumber_table",
                "page": page_no,
                "postingDate": posting,
                "valueDate": value_date,
                "description": description,
                "reference": reference,
                "debit": debit,
                "credit": credit,
                "balance": balance,
                "raw": raw,
            }
        elif current:
            if description:
                current["description"] = clean_cell(current.get("description", "") + " " + description)
            if reference:
                current["reference"] = clean_cell(current.get("reference", "") + " " + reference)
            if debit and not current.get("debit"):
                current["debit"] = debit
            if credit and not current.get("credit"):
                current["credit"] = credit
            if balance and not current.get("balance"):
                current["balance"] = balance
            current["raw"] = clean_cell(current.get("raw", "") + " " + raw)

    if current:
        output.append(current)

    return [
        r for r in output
        if is_date(r.get("postingDate"))
        and r.get("description")
        and (r.get("debit") or r.get("credit"))
    ]


def strip_time_tokens(s):
    return re.sub(r"\b\d{1,2}:\d{2}(?::\d{2})?\b", " ", str(s or ""))


def date_pattern():
    return r"(?:\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})"


def record_start_re():
    return re.compile(r"^" + date_pattern() + r"(?:\s+" + date_pattern() + r")?\b")


def clean_line_for_record(line):
    line = strip_time_tokens(line)
    line = clean_cell(line)
    return line


def is_noise_text_line(line):
    u = line.upper()

    return (
        not line
        or "POSTING DATE" in u
        or "VALUE DATE" in u
        or "DEBIT AMOUNT" in u
        or "CREDIT AMOUNT" in u
        or "OPENING BALANCE" in u
        or "CLOSING BALANCE" in u
        or "ACCOUNT STATEMENT" in u
        or "ACCOUNT NUMBER" in u
        or "LICENSED BY THE CENTRAL BANK" in u
        or "END OF STATEMENT" in u
    )


def extract_text_records(text):
    lines = [
        clean_line_for_record(x)
        for x in str(text or "").splitlines()
    ]

    records = []
    current = []

    start_re = record_start_re()

    def flush():
        nonlocal current
        if current:
            rec = clean_cell(" ".join(current))
            if rec:
                records.append(rec)
            current = []

    for line in lines:
        if is_noise_text_line(line):
            continue

        if start_re.match(line):
            flush()
            current.append(line)
        elif current:
            current.append(line)

    flush()
    return records


def amount_tokens_with_positions(s):
    token_re = re.compile(r"(?<![\w])(\(?-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?|\(?-?\d+(?:\.\d+)?\)?)(?![\w])")
    out = []

    for m in token_re.finditer(s):
        raw = m.group(1)
        val = parse_amount(raw)

        if val < 0:
            continue

        out.append({
            "raw": raw,
            "value": val,
            "start": m.start(1),
            "end": m.end(1),
        })

    return out


def token_is_reference_noise(tok):
    raw = str(tok.get("raw", ""))
    digits = re.sub(r"\D", "", raw)

    if not digits:
        return False

    # Long integer IDs and tiny trailing split references are usually not money columns.
    if "." not in raw and "," not in raw:
        if len(digits) >= 7:
            return True
        if len(digits) <= 4 and tok.get("value", 0) > 0:
            return True

    return False


def classify_row_hint(text):
    u = text.upper()

    if (
        "SALARY" in u
        or "B/O" in u
        or "CHEQUE DEPOSIT" in u
        or "DIVIDEND" in u
        or "APOLLO FLIGHT" in u
        or "UNION HOLDING" in u
    ):
        return "CR"

    if (
        u.startswith("PUR ")
        or u.startswith("ATM WDL")
        or u.startswith("FOREIGN TRANSACTION")
        or u.startswith("SEND MONEY")
        or u.startswith("I/W CLEARING")
        or "CREDIT CARD PAYMNT" in u
        or "CREDIT CARD PAYMENT" in u
        or "MBTRF" in u
        or "TRF OUT" in u
        or "INSTALLMENT RECOVERY" in u
        or "INSTALMENT RECOVERY" in u
        or re.search(r"\b112000017920", u)
    ):
        return "DR"

    return "UNKNOWN"


def score_amount_triple(rest, tokens, i):
    a = tokens[i]
    b = tokens[i + 1]
    c = tokens[i + 2]

    a_zero = is_zero_amount(a["raw"])
    b_zero = is_zero_amount(b["raw"])

    if a_zero == b_zero:
        return None

    if c["value"] <= 0:
        return None

    debit = a["raw"] if not a_zero else "0.00"
    credit = b["raw"] if not b_zero else "0.00"
    balance = c["raw"]
    direction = "DR" if not a_zero else "CR"

    hint = classify_row_hint(rest)

    score = 0

    trailing = tokens[i + 3:]
    trailing_noise = all(token_is_reference_noise(t) for t in trailing)

    # Normal case: the triple ends the row.
    if not trailing:
        score += 20

    # Important account-statement case:
    # amount | 0.00 | balance | tiny trailing reference
    # Example: 1639 | 0.00 | 10170.6 | 0881
    # This must beat the later wrong triple: 0.00 | 10170.6 | 0881.
    elif len(trailing) <= 2 and trailing_noise:
        score += 24

        if direction == "DR" and b_zero and ("." in c["raw"] or "," in c["raw"]):
            score += 18

        if direction == "CR" and a_zero and ("." in c["raw"] or "," in c["raw"]):
            score += 8

    else:
        score -= 20 + len(trailing) * 5

    if hint == direction:
        score += 20
    elif hint != "UNKNOWN":
        score -= 25

    # Prefer balances with decimals, but do not require them.
    if "." in balance or "," in balance:
        score += 6

    # Strongly avoid treating a tiny trailing reference as a balance.
    if token_is_reference_noise(c):
        if c["value"] < 1000:
            score -= 40
        else:
            score -= 10

    # Avoid amount fields that look like long references.
    if token_is_reference_noise(a) and not a_zero:
        score -= 20
    if token_is_reference_noise(b) and not b_zero:
        score -= 20

    return {
        "score": score,
        "debit": debit,
        "credit": credit,
        "balance": balance,
        "direction": direction,
        "amount_start": a["start"] if direction == "DR" else b["start"],
        "triple_start": a["start"],
        "triple_end": c["end"],
    }


def choose_best_amount_triple(rest):
    tokens = amount_tokens_with_positions(rest)

    if len(tokens) < 3:
        return None

    candidates = []

    for i in range(0, len(tokens) - 2):
        candidate = score_amount_triple(rest, tokens, i)
        if candidate is not None:
            candidates.append(candidate)

    if not candidates:
        return None

    candidates.sort(key=lambda x: x["score"], reverse=True)

    best = candidates[0]

    if best["score"] < -5:
        return None

    return best


def parse_text_record_to_row(record, page_no):
    rec = clean_cell(strip_time_tokens(record))

    date_re = re.compile(date_pattern())
    dates = list(date_re.finditer(rec))

    if not dates:
        return None

    posting = dates[0].group(0)
    value_date = ""

    rest_start = dates[0].end()

    if len(dates) > 1 and dates[1].start() <= rest_start + 3:
        value_date = dates[1].group(0)
        rest_start = dates[1].end()

    rest = clean_cell(rec[rest_start:])

    if not rest:
        return None

    triple = choose_best_amount_triple(rest)

    if not triple:
        return None

    left = clean_cell(rest[:triple["amount_start"]])

    # Split description/reference approximately. This is display-only; amount logic is already recovered.
    description = left
    reference = ""

    m = re.match(r"^(SALARY)\s+(.+)$", left, re.I)
    if m:
        description = clean_cell(m.group(1))
        reference = clean_cell(m.group(2))
    else:
        m = re.match(r"^(.*?)(\bPHUB[A-Z0-9 ]+)$", left, re.I)
        if m:
            description = clean_cell(m.group(1))
            reference = clean_cell(m.group(2))

    if not description:
        description = left or "Unknown"

    return {
        "source": "pdfplumber_text_fallback",
        "page": page_no,
        "postingDate": posting,
        "valueDate": value_date,
        "description": description,
        "reference": reference,
        "debit": amountish(triple["debit"]),
        "credit": amountish(triple["credit"]),
        "balance": amountish(triple["balance"]),
        "raw": rec,
    }


def extract_text_fallback_rows(pdf):
    rows = []
    diagnostics = []

    for page_no, page in enumerate(pdf.pages, start=1):
        try:
            text = page.extract_text(x_tolerance=2, y_tolerance=3) or ""
        except Exception as exc:
            diagnostics.append({
                "page": page_no,
                "strategy": "text_fallback",
                "error": str(exc),
            })
            continue

        records = extract_text_records(text)

        for rec in records:
            row = parse_text_record_to_row(rec, page_no)
            if row:
                rows.append(row)

    return rows, diagnostics


def extract_pdf_tables(pdf_bytes):
    all_rows = []
    diagnostics = []

    settings_list = [
        {
            "vertical_strategy": "lines",
            "horizontal_strategy": "lines",
            "intersection_tolerance": 5,
            "snap_tolerance": 3,
            "join_tolerance": 3,
            "edge_min_length": 3,
            "min_words_vertical": 2,
            "min_words_horizontal": 1,
            "text_tolerance": 3,
        },
        {
            "vertical_strategy": "text",
            "horizontal_strategy": "text",
            "intersection_tolerance": 5,
            "snap_tolerance": 3,
            "join_tolerance": 3,
            "edge_min_length": 3,
            "min_words_vertical": 2,
            "min_words_horizontal": 1,
            "text_tolerance": 3,
        },
    ]

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            best_rows = []

            for settings in settings_list:
                try:
                    tables = page.extract_tables(table_settings=settings) or []
                except Exception as exc:
                    diagnostics.append({
                        "page": page_no,
                        "strategy": settings.get("vertical_strategy"),
                        "error": str(exc),
                    })
                    continue

                page_rows = []
                for table in tables:
                    page_rows.extend(parse_account_table(table, page_no))

                if len(page_rows) > len(best_rows):
                    best_rows = page_rows

            all_rows.extend(best_rows)

        if not all_rows:
            fallback_rows, fallback_diag = extract_text_fallback_rows(pdf)
            diagnostics.extend(fallback_diag)
            all_rows = fallback_rows

    return all_rows, diagnostics


def extract_file_from_multipart(headers, body):
    content_type = headers.get("Content-Type", "")

    if "multipart/form-data" not in content_type:
        raise ValueError("Expected multipart/form-data upload.")

    pseudo_message = (
        f"Content-Type: {content_type}\r\n"
        "MIME-Version: 1.0\r\n"
        "\r\n"
    ).encode("utf-8") + body

    msg = BytesParser(policy=default).parsebytes(pseudo_message)

    if not msg.is_multipart():
        raise ValueError("Upload body was not multipart.")

    for part in msg.iter_parts():
        disposition = part.get("Content-Disposition", "")

        if 'name="file"' in disposition:
            payload = part.get_payload(decode=True)

            if not payload:
                raise ValueError("Uploaded file was empty.")

            return payload

    raise ValueError("No multipart field named file was found.")


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        send_json(self, 200, {"ok": True, "extractor_version": VERSION})

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))

            if content_length <= 0:
                return send_json(self, 400, {
                    "error": "empty_request",
                    "message": "No request body received.",
                    "extractor_version": VERSION,
                })

            body = self.rfile.read(content_length)
            pdf_bytes = extract_file_from_multipart(self.headers, body)

            rows, diagnostics = extract_pdf_tables(pdf_bytes)

            return send_json(self, 200, {
                "extractor_version": VERSION,
                "tableRows": rows,
                "rowCount": len(rows),
                "diagnostics": diagnostics,
            })

        except Exception as exc:
            return send_json(self, 500, {
                "error": "extract_failed",
                "message": str(exc),
                "trace": traceback.format_exc()[-2500:],
                "extractor_version": VERSION,
            })
