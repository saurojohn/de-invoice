#!/usr/bin/env python3
"""
Tier 826 — messages with placeholders that a page shows unfilled.

Two forms were found on the pages:
  - t("key") without values, and no .replace() of the placeholder after it:
    „Mahnung senden ({count})", „{count} Rechnungen ausgewählt";
  - t("key") || "…{x}…".replace(…): the .replace() binds to the fallback
    string only — t() returns the message, the page showed
    „{count} Rechnungen bezahlt, {total} € angewendet".

Prints one line per finding ("UNFILLED file:line key missing" / "FALLBACK
file:line key"), then "TOTAL <n>".
"""
import glob
import io
import json
import os
import re
import sys

FE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "frontend")
# texts that show the tokens themselves, on purpose
ALLOW = {"invoiceTemplates.paymentTermsHint"}

de = json.load(io.open(os.path.join(FE, "messages", "de.json"), encoding="utf-8"))


def message(key):
    o = de
    for p in key.split("."):
        if not isinstance(o, dict) or p not in o:
            return None
        o = o[p]
    return o if isinstance(o, str) else None


CALL = re.compile(r'\b(?:t|tRef\.current)\("([A-Za-z0-9_.]+)"(\s*\))')
FALLBACK = re.compile(r'\b(?:t|tRef\.current)\("([A-Za-z0-9_.]+)"\)\s*\|\|\s*(["\'`])[^"\'`]*\{[A-Za-z]+\}[^"\'`]*\2\s*\.replace\(')
found = 0
files = sorted(glob.glob(os.path.join(FE, "src", "**", "*.tsx"), recursive=True) + glob.glob(os.path.join(FE, "src", "**", "*.ts"), recursive=True))
for f in files:
    s = io.open(f, encoding="utf-8").read()
    rel = os.path.relpath(f, FE)
    for m in CALL.finditer(s):
        key = m.group(1)
        msg = message(key)
        if not msg or key in ALLOW:
            continue
        need = set(re.findall(r"\{([A-Za-z]+)\}", msg))
        if not need:
            continue
        after = s[m.end():m.end() + 700]  # a chain of .replace() with comments between
        filled = set(re.findall(r"\.replace(?:All)?\(\s*[\"'`]\{([A-Za-z]+)\}", after))
        missing = need - filled
        if missing:
            found += 1
            print("UNFILLED %s:%d %s %s" % (rel, s[:m.start()].count("\n") + 1, key, ",".join(sorted(missing))))
    for m in FALLBACK.finditer(s):
        found += 1
        print("FALLBACK %s:%d %s" % (rel, s[:m.start()].count("\n") + 1, m.group(1)))
print("TOTAL %d" % found)
