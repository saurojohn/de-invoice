#!/usr/bin/env python3
"""
Tier 846 — a probe of odd values on the write endpoints: which requests answer 5xx?

Every field of some 50 write requests is replaced, one at a time, by 34 odd
values (null, "", huge and tiny numbers, wrong types, dates that do not
exist, long and strange strings), a field is left out, and the body is sent
as a list or a plain value. A 4xx is the right answer to such a request; a
5xx is a bug (the first run, 16.11.2026: 32 combinations).

It registers a company of its own and writes some 9 000 requests into it.
Only against a throwaway backend:

    API=http://localhost:3011 python3 backend/scripts/probe-odd-values.py

It refuses to run without API, and against a host that is not this machine.
"""
import json, os, sys, time, copy, urllib.request, urllib.error, datetime
API = os.environ.get("API", "").rstrip("/")
if not API or not any(API.startswith(p) for p in ("http://localhost:", "http://127.0.0.1:")):
    sys.exit("REFUSED: set API to a throwaway backend on this machine, e.g. API=http://localhost:3011")
def call(method, path, body=None, h=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"Content-Type": "application/json", **(h or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 599, repr(e)
tag = f"fuzz-{int(time.time())}"
st, b = call("POST", "/api/v1/auth/register", {"email": f"{tag}@example.test", "password": "Fuzz-probe-1", "companyName": f"{tag} GmbH"})
d = json.loads(b); U = d["user"]["id"]; C = d["user"].get("companyId") or d["company"]["id"]
H = {"x-user-id": U, "x-company-id": C}; q = f"companyId={C}"
call("PUT", f"/api/v1/companies/{C}?{q}", {"taxId": "21/815/08150", "vatId": "DE123456789", "address": {"street": "A 1", "city": "Berlin", "postalCode": "10115", "country": "DE"}}, H)
today = datetime.date.today().isoformat()
st, b = call("POST", f"/api/v1/customers?{q}", {"name": "K", "type": "business", "address": {"street": "S 1", "postalCode": "10115", "city": "Berlin", "country": "DE"}}, H); K = json.loads(b)["id"]
st, b = call("POST", f"/api/v1/products?{q}", {"name": "P", "sku": f"SKU-{tag}", "basePrice": 10, "vatRate": 0.19, "unit": "Stk"}, H); PR = (json.loads(b) or {}).get("id")
st, b = call("POST", f"/api/v1/invoices?{q}", {"customerId": K, "issueDate": today, "items": [{"description": "x", "quantity": 1, "unit": "Stk", "unitPrice": 100, "vatRate": 0.19}]}, H); INV = json.loads(b)["id"]
call("PUT", f"/api/v1/invoices/{INV}/status?{q}", {"status": "sent"}, H)
def mk(method, path, body):
    st, b = call(method, path, body, H)
    try: return json.loads(b)
    except Exception: return {}
CU2 = mk("POST", f"/api/v1/customers?{q}", {"name": "K2", "type": "business", "address": {"street": "S 1", "postalCode": "10115", "city": "Berlin", "country": "DE"}}).get("id")
DRAFT = mk("POST", f"/api/v1/invoices?{q}", {"customerId": K, "issueDate": today, "items": [{"description": "x", "quantity": 1, "unit": "Stk", "unitPrice": 100, "vatRate": 0.19}]}).get("id")
EXP = mk("POST", f"/api/v1/expenses?{q}", {"description": "Büro", "invoiceDate": today, "netAmount": 100, "vatRate": 0.19, "vatAmount": 19, "grossAmount": 119, "category": "Büro"}).get("id")
SUP = mk("POST", f"/api/v1/suppliers?{q}", {"name": "L2"}).get("id")
CASH = mk("POST", f"/api/v1/cashbook/entries?{q}", {"businessDate": today, "type": "einnahme", "description": "T", "amount": 50, "vatRate": 0.19}).get("id")
REC = mk("POST", f"/api/v1/recurring-invoices?{q}", {"customerId": K, "name": "W2", "interval": "monthly", "dayOfMonth": 1, "startDate": today, "items": [{"description": "W", "quantity": 1, "unit": "Monat", "unitPrice": 100, "vatRate": 0.19}]}).get("id")
INV2 = mk("POST", f"/api/v1/invoices?{q}", {"customerId": K, "issueDate": today, "items": [{"description": "x", "quantity": 2, "unit": "Stk", "unitPrice": 500, "vatRate": 0.19}]}).get("id")
call("PUT", f"/api/v1/invoices/{INV2}/status?{q}", {"status": "sent"}, H)
def issued(net):
    i = mk("POST", f"/api/v1/invoices?{q}", {"customerId": CU2, "issueDate": today, "items": [{"description": "x", "quantity": 2, "unit": "Stk", "unitPrice": net, "vatRate": 0.19}]}).get("id")
    call("PUT", f"/api/v1/invoices/{i}/status?{q}", {"status": "sent"}, H); return i
INV3 = issued(500); INV4 = issued(100000)
QU = mk("POST", f"/api/v1/invoices?{q}", {"type": "QU", "customerId": K, "issueDate": today, "items": [{"description": "x", "quantity": 3, "unit": "Stk", "unitPrice": 100, "vatRate": 0.19}]}).get("id")
TE = mk("POST", f"/api/v1/time-entries?{q}", {"customerId": K, "date": today, "minutes": 60, "description": "A", "hourlyRate": 80}).get("id")
BASE = {
  "customer": ("POST", f"/api/v1/customers?{q}", {"name": "Kunde", "type": "business", "vatId": "", "paymentTerms": 14, "address": {"street": "S 1", "postalCode": "10115", "city": "Berlin", "country": "DE"}, "contact": {"email": "a@b.example", "name": "N", "phone": "1"}}),
  "product": ("POST", f"/api/v1/products?{q}", {"name": "Produkt", "sku": "S", "basePrice": 10, "vatRate": 0.19, "unit": "Stk", "description": "d", "stockQuantity": 5, "lowStockThreshold": 1, "trackInventory": True}),
  "invoice": ("POST", f"/api/v1/invoices?{q}", {"customerId": K, "issueDate": today, "dueDate": today, "deliveryDate": today, "currency": "EUR", "notes": "n", "discountPercent": 0, "skontoPercent": 2, "skontoDays": 10, "items": [{"description": "x", "quantity": 1, "unit": "Stk", "unitPrice": 100, "vatRate": 0.19, "productId": PR}]}),
  "quote": ("POST", f"/api/v1/invoices?{q}", {"type": "QU", "customerId": K, "issueDate": today, "items": [{"description": "x", "quantity": 1, "unit": "Stk", "unitPrice": 100, "vatRate": 0.19}]}),
  "payment": ("POST", f"/api/v1/invoices/{INV}/payments?{q}", {"amount": 1, "paymentDate": today, "paymentMethod": "bank_transfer", "reference": "r", "notes": "n"}),
  "expense": ("POST", f"/api/v1/expenses?{q}", {"description": "Büro", "invoiceDate": today, "invoiceNumber": "R1", "netAmount": 100, "vatRate": 0.19, "vatAmount": 19, "grossAmount": 119, "category": "Büro", "paidAt": today}),
  "cash": ("POST", f"/api/v1/cashbook/entries?{q}", {"businessDate": today, "type": "einnahme", "description": "Tageslosung", "amount": 119, "vatRate": 0.19}),
  "recurring": ("POST", f"/api/v1/recurring-invoices?{q}", {"customerId": K, "name": "W", "interval": "monthly", "dayOfMonth": 1, "startDate": today, "items": [{"description": "W", "quantity": 1, "unit": "Monat", "unitPrice": 100, "vatRate": 0.19}]}),
  "supplier": ("POST", f"/api/v1/suppliers?{q}", {"name": "Lieferant", "bankInfo": {"iban": "DE89370400440532013000", "bic": "COBADEFFXXX", "accountHolder": "L"}, "paymentTerms": 14, "vatId": "", "address": {"street": "S 1", "postalCode": "10115", "city": "Berlin", "country": "DE"}}),
  "asset": ("POST", f"/api/v1/assets?{q}", {"type": "EDV", "bezeichnung": "Laptop", "anschaffungsDatum": today, "anschaffungsKosten": 1200, "nutzungsdauerMonate": 36, "restwert": 0, "afaMethode": "linear", "notiz": "n"}),
  "time": ("POST", f"/api/v1/time-entries?{q}", {"customerId": K, "date": today, "minutes": 90, "description": "Arbeit", "hourlyRate": 80, "billable": True}),
  "company": ("PUT", f"/api/v1/companies/{C}?{q}", {"name": f"{tag} GmbH", "defaultPaymentDays": 14, "phone": "1", "email": "a@b.example", "website": "https://x.example"}),
  "customer.put": ("PUT", f"/api/v1/customers/{CU2}?{q}", {"name": "Kunde", "type": "business", "creditLimit": 1000, "defaultHourlyRate": 80, "paymentTerms": 14, "address": {"street": "S 1", "postalCode": "10115", "city": "Berlin", "country": "DE"}}),
  "product.put": ("PUT", f"/api/v1/products/{PR}?{q}", {"name": "P", "basePrice": 10, "purchasePrice": 5, "vatRate": 0.19, "unit": "Stk", "stockQuantity": 5, "lowStockThreshold": 1, "trackInventory": True, "active": True}),
  "invoice.put": ("PUT", f"/api/v1/invoices/{DRAFT}?{q}", {"notes": "n", "dueDate": today, "currency": "USD", "exchangeRate": 1.1, "discountPercent": 5, "discountAmount": 0, "skontoPercent": 2, "skontoDays": 10, "items": [{"description": "x", "quantity": 1, "unit": "Stk", "unitPrice": 100, "vatRate": 0.19}]}),
  "expense.put": ("PUT", f"/api/v1/expenses/{EXP}?{q}", {"description": "Büro", "invoiceDate": today, "netAmount": 100, "vatRate": 0.19, "vatAmount": 19, "grossAmount": 119, "category": "Büro", "paidAt": today, "notes": "n"}),
  "supplier.put": ("PUT", f"/api/v1/suppliers/{SUP}?{q}", {"name": "L", "paymentTerms": 14, "bankInfo": {"iban": "DE89370400440532013000"}}),
  "cash.put": ("PUT", f"/api/v1/cashbook/entries/{CASH}?{q}", {"description": "T2", "amount": 60, "vatRate": 0.07}),
  "cash.close": ("POST", f"/api/v1/cashbook/close-day?{q}", {"date": today, "physicalCount": 229, "differenzNote": "n"}),
  "recurring.put": ("PUT", f"/api/v1/recurring-invoices/{REC}?{q}", {"name": "W3", "interval": "monthly", "intervalCount": 1, "dayOfMonth": 5, "startDate": today, "endDate": today, "pausedUntil": today, "items": [{"description": "W", "quantity": 1, "unit": "Monat", "unitPrice": 100, "vatRate": 0.19}]}),
  "creditnote": ("POST", f"/api/v1/invoices/{INV4}/credit-note?{q}", {"reason": "Teil", "amount": 1}),
  "creditnote.lines": ("POST", f"/api/v1/invoices/{INV4}/credit-note?{q}", {"reason": "Teil", "lines": [{"description": "x", "quantity": 1, "unitPrice": 1, "vatRate": 0.19}]}),
  "convert": ("POST", f"/api/v1/invoices/{QU}/convert?{q}", {"to": "OC"}),
  "fees": ("PUT", f"/api/v1/reminders/mahnungen/fees-config?{q}", {"verzugszinsPct": 9, "mahngebuehr": {"first": 0, "second": 2.5, "final": 5}}),
  "dunning": ("PUT", f"/api/v1/reminders/dunning-config?{q}", {"level1Days": 1, "level2Days": 7, "level3Days": 14, "level1Fee": 0, "level2Fee": 2.5, "level3Fee": 5}),
  "autosettings": ("PUT", f"/api/v1/reminders/auto-settings?{q}", {"autoReminderEnabled": True}),
  "credit.adjust": ("POST", f"/api/v1/customers/{K}/credit-adjust?{q}", {"amount": 10, "description": "Kulanz"}),
  "allocate": ("POST", f"/api/v1/customers/{K}/allocate-payment?{q}", {"amount": 10, "paymentDate": today, "paymentMethod": "bank_transfer", "reference": "r"}),
  "plan": ("POST", f"/api/v1/installment-plans/from-invoice?{q}", {"invoiceId": INV3, "installmentCount": 3, "firstDueDate": today, "intervalDays": 30, "notes": "n"}),
  "voucher": ("POST", f"/api/v1/accounting/vouchers?{q}", {"companyId": C, "date": today, "description": "Umbuchung", "status": "draft", "lines": [{"description": "a", "debit": 100, "credit": 0}, {"description": "b", "debit": 0, "credit": 100}]}),
  "asset": ("POST", f"/api/v1/assets?{q}", {"type": "GWG", "bezeichnung": "Laptop", "anschaffungsDatum": today, "anschaffungsKosten": 1200, "nutzungsdauerMonate": 36, "restwert": 0, "afaMethode": "linear", "notiz": "n"}),
  "time.put": ("PUT", f"/api/v1/time-entries/{TE}?{q}", {"date": today, "minutes": 30, "description": "B", "hourlyRate": 90, "billable": False}),
  "filing": ("PUT", f"/api/v1/ustva/filing-settings?{q}", {"rhythm": "monthly", "dauerfrist": True}),
  "taxsettings": ("PUT", f"/api/v1/accounting/gewst/settings?{q}", {"year": 2026, "hebesatz": 400}),
  "kind": ("PUT", f"/api/v1/accounting/anlage-kind/settings?{q}", {"year": 2026, "kinder": [{"name": "A", "birthDate": "2015-05-05", "kindergeldEligible": True}]}),
  "zusammen": ("PUT", f"/api/v1/accounting/zusammenveranlagung?{q}", {"zusammenveranlagung": True}),
  "payment.big": ("POST", f"/api/v1/invoices/{INV4}/payments?{q}", {"amount": 1, "paymentDate": today, "paymentMethod": "cash", "reference": "r"}),
}
NASTY = [None, "", " ", 0, -1, 1e308, -1e308, 1e-9, 99999999999999999999, 0.1 + 0.2, "abc", "1e5", "NaN", "Infinity", True, [], {}, [None], {"a": 1},
         "x" * 5000, "😀" * 50, "\u0000", "'; DROP TABLE x;--", "<script>alert(1)</script>", "0000-00-00", "9999-12-31", "2026-02-31", "31.12.2026", "2026-13-01", "1970-01-01T00:00:00Z", "-0", "１２３", " 12 ", "1,5"]
def paths(o, p=()):
    if isinstance(o, dict):
        for k, v in o.items(): yield from paths(v, p + (k,))
    elif isinstance(o, list):
        yield p
        for i, v in enumerate(o): yield from paths(v, p + (i,))
    else: yield p
def setp(o, p, v):
    for k in p[:-1]: o = o[k]
    o[p[-1]] = v
bad = []; n = 0
for name, (m, path, body) in BASE.items():
    st, b = call(m, path, body, H)
    print(f"{name}: baseline {st}", "" if st < 400 else b[:200]); sys.stdout.flush()
    for p in list(paths(body)):
        for v in NASTY:
            x = copy.deepcopy(body); setp(x, p, v); n += 1
            st, b = call(m, path, x, H)
            if st >= 500: bad.append((name, ".".join(map(str, p)), repr(v)[:40], st, b[:160]))
    # missing fields and extra root shapes
    for k in list(body):
        x = copy.deepcopy(body); del x[k]; n += 1
        st, b = call(m, path, x, H)
        if st >= 500: bad.append((name, k, "<missing>", st, b[:160]))
    for x in ([], "str", 5, None, {"items": "x"}):
        st, b = call(m, path, x, H); n += 1
        if st >= 500: bad.append((name, "<root>", repr(x), st, b[:160]))
print(f"\n{n} requests, {len(bad)} answered 5xx")
seen = set()
for r in bad:
    print(" | ".join(map(str, r[:4])))
sys.exit(1 if bad else 0)
