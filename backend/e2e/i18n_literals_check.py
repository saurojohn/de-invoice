#!/usr/bin/env python3
"""Tier 659 — German text written into the pages themselves.

usage: i18n_literals_check.py <frontend dir>

Prints one line:  <markup> <code> <used> <untranslated> <en> <zh> <keydiff>
  markup        German text nodes and attributes in the markup that are not
                looked up (must be 0)
  code          German string literals elsewhere in the code that are not looked
                up — toasts with interpolation, CSV headings, label maps (a
                ceiling the spec holds; it must not grow)
  used          texts passed to L("…")
  untranslated  of those, without an entry in both dictionaries (must be 0)
then the offending lines, prefixed MARKUP / CODE / MISSING.

A line that carries the comment  i18n-ok: <why>  is left alone — for German
text that is German on purpose (a sentence printed on the German invoice).
"""
import collections, glob, io, json, re, sys

fe = sys.argv[1].rstrip('/')
DE = re.compile(r"[äöüßÄÖÜ]|\b(?:und|oder|für|nicht|wird|werden|der|die|das|den|dem|eine|aus|auf|bei|mit|von|zum|zur|ist|sind|nur|auch|nach|Rechnung\w*|Kunde\w*|Speichern|Löschen|Bearbeiten|Abbrechen|Zurück|Keine\w*|Alle|Datum|Nummer|Betrag|Summe|Hinzufügen|Suchen|Erstellen|Umsatz\w*|Steuer\w*|Zahlung\w*|Fehler|Bitte)\b")
TEXT = re.compile(r">([^<>{}\n]*[A-Za-zÄÖÜäöü]{3}[^<>{}\n]*)<")
ATTR = re.compile(r"\b(?:placeholder|title|aria-label|alt|label)=\"([^\"]*)\"")
LINE = re.compile(r"[A-ZÄÖÜa-zäöü§0-9(⚠↳·—-][^<>{}=;]*")
LIT = re.compile(r"\"((?:[^\"\\\n]|\\.)*)\"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`")
USED = re.compile(r'\bL\(("(?:[^"\\]|\\.)*")\)')
files = sorted(glob.glob(fe + '/src/**/*.tsx', recursive=True) + glob.glob(fe + '/src/**/*.ts', recursive=True))
rel = lambda p: p[len(fe) + 1:]

def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), s, flags=re.S)
    return re.sub(r"(^|[^:\"'`\\])//[^\n]*", lambda m: m.group(1) + " " * (len(m.group(0)) - len(m.group(1))), s)

markup, code, used = [], [], set()
for p in files:
    src = io.open(p, encoding='utf-8').read()
    if p.endswith(('useI18n.ts', 'tax-form-text.tsx')): continue
    for m in USED.finditer(src): used.add(json.loads(m.group(1)))
    exempt = {i for i, line in enumerate(src.split('\n'), 1) if 'i18n-ok:' in line}
    if p.endswith('.tsx'):
        prev = ''
        for i, line in enumerate(src.split('\n'), 1):
            t = line.strip()
            if not t: continue
            if t.startswith(('//', '*', '/*', '{/*')): prev = '//'; continue
            if i in exempt: prev = t; continue
            # a text node on a line of its own
            if prev.endswith(('>', '}')) and not prev.endswith(('=>', '={')) and LINE.fullmatch(t) and DE.search(t) and not t.endswith((',', '(', '&&', '||', '?', ':')):
                markup.append('%s:%d %s' % (rel(p), i, t[:90]))
            for rx in (TEXT, ATTR):
                for m in rx.finditer(line):
                    v = m.group(1).strip()
                    if len(v) >= 3 and DE.search(v): markup.append('%s:%d %s' % (rel(p), i, v[:90]))
            prev = t
    s = strip_comments(src)
    for m in LIT.finditer(s):
        v = m.group(1) or m.group(2) or m.group(3) or ''
        if len(v) < 4 or not DE.search(v): continue
        if ' ' not in v and not re.search(r"[äöüßÄÖÜ]", v): continue
        before = s[max(0, m.start() - 160):m.start()]
        lstart = s.rfind('\n', 0, m.start()) + 1
        if s[lstart:m.start()].lstrip().startswith('import '): continue
        if re.search(r"(?:\bL|\bt|tRef\.current|formTextNow|tr)\(\s*$", before): continue
        if re.search(r"\)\s*\|\|\s*$", before) or re.search(r"(?:\bt|tRef\.current)\(\s*[\"'][\w.]+[\"']\s*,\s*$", before): continue
        if re.search(r"(?:console\.\w+\(|new Error\(|className=|data-testid=|testid=|\bkey=|\.startsWith\(|\.includes\(|\.test\(|===\s*|!==\s*|\bcase\s+|\blang=|text=|\bde:\s*|\blabel:\s*|href=|\.replace\(|\.split\(|indexOf\()\s*$", before): continue
        if re.search(r"(?:FormNote|FormLabel)\s+text=\{?\s*$", before): continue
        if s.count('\n', 0, m.start()) + 1 in exempt: continue
        code.append('%s:%d %s' % (rel(p), s.count('\n', 0, m.start()) + 1, ' '.join(v.split())[:90]))

en = json.load(io.open(fe + '/messages/literals/en.json', encoding='utf-8'))
zh = json.load(io.open(fe + '/messages/literals/zh.json', encoding='utf-8'))
missing = sorted(k for k in used if not en.get(k) or not zh.get(k))
print(len(markup), len(code), len(used), len(missing), len(en), len(zh), len(set(en) ^ set(zh)))
for x in markup: print('MARKUP', x)
for x in missing: print('MISSING', x)
for x in code: print('CODE', x)
