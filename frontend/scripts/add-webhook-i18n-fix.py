#!/usr/bin/env python3
"""
Re-flatten the 'webhooks' i18n section in all 3 locales.
Reads WEBHOOKS from the original add script.
"""
import json
import re
from pathlib import Path

# Read the WEBHOOKS dict directly from the original script
src = Path("scripts/add-webhook-i18n.py").read_text()
# Extract the WEBHOOKS = { ... } block by string ops
match = re.search(r"WEBHOOKS\s*=\s*(\{.*?\n\})\n\n\ndef main", src, re.DOTALL)
if not match:
    raise SystemExit("Could not extract WEBHOOKS from add-webhook-i18n.py")
WEBHOOKS_SRC = match.group(1)
# Now eval the dict in a sandbox
ns = {"__builtins__": {}, "de": "de", "en": "en", "zh": "zh"}
# The script uses Python literals only — safe to eval
WEBHOOKS = eval(WEBHOOKS_SRC, ns)


def pick_locale(value, locale):
    """If value is a {de,en,zh} dict, pick the matching locale.
    If value is a nested dict whose leaves are {de,en,zh}, recurse.
    Otherwise return value as-is."""
    if not isinstance(value, dict):
        return value
    if locale in value and all(k in ("de", "en", "zh") for k in value.keys()):
        return value[locale]
    return {k: pick_locale(v, locale) for k, v in value.items()}


def main():
    for locale, fname in [("de", "de.json"), ("en", "en.json"), ("zh", "zh.json")]:
        path = f"messages/{fname}"
        with open(path) as f:
            data = json.load(f)
        new_section = pick_locale(WEBHOOKS["webhooks"], locale)
        data["webhooks"] = new_section
        with open(path, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # Count leaf keys
        n = sum(
            1
            for v in new_section.values()
            for _ in (v if isinstance(v, dict) else [v])
        )
        print(f"✓ {path} updated ({n} leaf keys)")


if __name__ == "__main__":
    main()
