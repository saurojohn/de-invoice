#!/usr/bin/env python3
"""
e2e 46 — i18n key completeness checker.

Run as: python3 i18n_check.py <frontend_dir>

Walks src/**/*.{ts,tsx} for t("foo.bar") and
t('foo.bar') call sites, then for each of
de/en/zh/messages/*.json walks the JSON tree
to verify the key exists.

Exits 0 if everything is consistent, 1
otherwise. Writes a structured report to
stderr so the bash wrapper can present it
readably.
"""
import json
import os
import re
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: i18n_check.py <frontend_dir>", file=sys.stderr)
        sys.exit(2)
    frontend_dir = sys.argv[1]
    os.chdir(frontend_dir)

    src_root = "src"
    locales = ["de", "en", "zh"]
    files = []
    for root, _, names in os.walk(src_root):
        for n in names:
            if n.endswith((".tsx", ".ts")):
                p = os.path.join(root, n)
                if "useI18n.ts" in p:
                    continue
                files.append(p)

    # Match t("foo.bar") and t('foo.bar').
    # t(`template ${var}`) is NOT supported
    # (we don't try to evaluate templates).
    key_pat = re.compile(r"""\bt\(\s*['"]([^'"`]+)['"]""")

    keys = set()
    for p in files:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                for m in key_pat.finditer(line):
                    keys.add(m.group(1))

    # Load each locale's tree
    trees = {}
    for loc in locales:
        with open(f"messages/{loc}.json", "r", encoding="utf-8") as f:
            trees[loc] = json.load(f)

    def has(tree, key):
        cur = tree
        for seg in key.split("."):
            if not isinstance(cur, dict) or seg not in cur:
                return False
            cur = cur[seg]
        return True

    missing = {loc: [] for loc in locales}
    for k in sorted(keys):
        for loc in locales:
            if not has(trees[loc], k):
                missing[loc].append(k)

    total = 0
    for loc in locales:
        total += len(missing[loc])
        if missing[loc]:
            print(f"  Missing in {loc}.json ({len(missing[loc])}):", file=sys.stderr)
            for k in missing[loc]:
                print(f"    - {k}", file=sys.stderr)
    sys.exit(0 if total == 0 else 1)


if __name__ == "__main__":
    main()
