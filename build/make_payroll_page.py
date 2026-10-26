"""Regenerate netlify/lib/payroll-page.mjs from build/payroll/payroll.html.

The crew pay sheets page is served by netlify/functions/payroll.mjs (behind a
password), never as a static file, so its HTML lives in a JS module. Edit
build/payroll/payroll.html, then run:  python3 build/make_payroll_page.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
src = (ROOT / "build" / "payroll" / "payroll.html").read_text(encoding="utf-8")
out = ROOT / "netlify" / "lib" / "payroll-page.mjs"
out.write_text(
    "// Crew pay sheets page, served at /payroll (password-protected by\n"
    "// netlify/functions/payroll.mjs). GENERATED from build/payroll/payroll.html by\n"
    "// build/make_payroll_page.py: edit the HTML there, not this file.\n"
    "export const PAYROLL_HTML = " + json.dumps(src, ensure_ascii=False) + ";\n",
    encoding="utf-8",
)
print(f"wrote {out.relative_to(ROOT)} ({len(src):,} chars)")
