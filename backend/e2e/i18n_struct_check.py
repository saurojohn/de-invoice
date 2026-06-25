#!/usr/bin/env python3
"""
e2e 46 — i18n structural completeness checker.

For each top-level + nested key in any of
de/en/zh/messages/*.json, verify the same
key exists in all three files. Catches the
"added a new namespace in one locale but
forgot the others" bug.
"""
import json
import os
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: i18n_struct_check.py <frontend_dir>", file=sys.stderr)
        sys.exit(2)
    frontend_dir = sys.argv[1]
    os.chdir(frontend_dir)

    def collect_keys(tree, prefix=""):
        out = set()
        if isinstance(tree, dict):
            for k, v in tree.items():
                path = f"{prefix}.{k}" if prefix else k
                if isinstance(v, dict):
                    out |= collect_keys(v, path)
                else:
                    out.add(path)
        return out

    keys_by_loc = {}
    for loc in ["de", "en", "zh"]:
        with open(f"messages/{loc}.json", "r", encoding="utf-8") as f:
            tree = json.load(f)
        keys_by_loc[loc] = collect_keys(tree)

    all_keys = set()
    for s in keys_by_loc.values():
        all_keys |= s

    incomplete = []
    for k in sorted(all_keys):
        missing = [loc for loc in ["de", "en", "zh"] if k not in keys_by_loc[loc]]
        if missing:
            incomplete.append((k, missing))

    if incomplete:
        for k, miss in incomplete:
            print(f"  Key '{k}' missing in: {','.join(miss)}", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
