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
    #
    # Also match t("foo." + bar) — the static
    # prefix is the part BEFORE the string
    # concatenation. We extract the static
    # string-literal segment only, and skip the
    # dynamic part. This pattern is used e.g.
    # in the customer statement page for
    # `t("statement.type_" + line.type)` —
    # the scanner used to capture the bare
    # "statement.type_" prefix, which is not a
    # key in the locale file (the real keys are
    # "statement.type_invoice", ".type_credit",
    # ".type_payment"). The test previously
    # failed on this. The fix: extract both the
    # full quoted key AND any prefix-concat
    # pattern. The full pattern is what the
    # t() function will look up at runtime
    # (the key is "statement.type_invoice"
    # when line.type === "invoice"), so the
    # key check is "is there a key matching
    # this static prefix?" — handled below by
    # adding both the full key and the prefix
    # to the check set.
    key_pat = re.compile(r"""\bt\(\s*['"]([^'"`]+)['"]""")
    prefix_pat = re.compile(
        r"""\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]\s*\+"""
    )

    keys = set()
    prefixes = set()  # for t("foo." + var) — verify the prefix exists
    for p in files:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                # Find all t() calls on this line.
                # For each match, decide whether the
                # captured string is a full key (the
                # common case) or a static prefix of
                # a concatenation pattern. We mark
                # prefix positions via the prefix_pat
                # matcher, then skip those positions
                # in the key_pat pass.
                prefix_spans = []
                for m in prefix_pat.finditer(line):
                    prefix_spans.append(m.span(1))
                    prefixes.add(m.group(1))
                for m in key_pat.finditer(line):
                    span = m.span(1)
                    if any(s <= span[0] and span[1] <= e
                           for s, e in prefix_spans):
                        continue
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
    # Also check that each prefix-concat pattern
    # (`t("foo." + var)`) has at least one matching
    # key in each locale. The leaf value comes from
    # the dynamic part at runtime, so we can't
    # enumerate every possible value. Example:
    # `t("statement.type_" + line.type)` — the
    # prefix is "statement.type_" and we expect
    # keys like "statement.type_invoice" to exist
    # as siblings of "statement.type_". We walk the
    # tree to the prefix's PARENT node, then check
    # that at least one child key starts with the
    # prefix segment. The "parent walk" approach
    # is needed because the prefix itself is NOT
    # a key — only the dynamic-suffix variants are.
    def has_prefix(tree, prefix):
        parts = prefix.split(".")
        if not parts:
            return True
        # Walk to the parent of the prefix.
        cur = tree
        for seg in parts[:-1]:
            if not isinstance(cur, dict) or seg not in cur:
                return False
            cur = cur[seg]
        # Now check that cur (the parent) has at
        # least one child starting with
        # parts[-1]. The child is either a string
        # (the t() lookup returns it) or a dict
        # (a nested namespace, also valid).
        last = parts[-1]
        if not isinstance(cur, dict):
            return False
        for child_key, child_val in cur.items():
            if child_key.startswith(last):
                # The child exists. If it's a leaf
                # string, the t() lookup at runtime
                # will return it. If it's a dict,
                # the caller is doing nested access
                # and we accept that.
                if not isinstance(child_val, dict):
                    return True
                if child_val:  # non-empty dict
                    return True
        return False
    for p in sorted(prefixes):
        for loc in locales:
            if not has_prefix(trees[loc], p):
                missing[loc].append(f"{p}*  (prefix from t(\"{p}\" + var))")

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
