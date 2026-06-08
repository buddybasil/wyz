from http.server import BaseHTTPRequestHandler
from io import BytesIO
from email.parser import BytesParser
from email.policy import default
import json
import re
import traceback
import pdfplumber


VERSION = "pdfplumber-extract-v19b-no-cgi"


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
                "source": "pdfplumber",
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
