#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


PRICING = '''from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")
TAX = Decimal("0.07")


def price_with_discount(price: str, code: str) -> Decimal:
    amount = Decimal(price)
    if code == "SAVE10":
        discounted = (amount * Decimal("0.90")).quantize(CENT, rounding=ROUND_HALF_UP)
        return (discounted * (Decimal("1") + TAX)).quantize(CENT, rounding=ROUND_HALF_UP)
    return (amount * (Decimal("1") + TAX)).quantize(CENT, rounding=ROUND_HALF_UP)
'''

TESTS = '''import unittest
from decimal import Decimal

from pricing import price_with_discount


class PricingTests(unittest.TestCase):
    def test_no_discount(self):
        self.assertEqual(price_with_discount("10.00", "NONE"), Decimal("10.70"))

    def test_save10_common_total(self):
        self.assertEqual(price_with_discount("10.00", "SAVE10"), Decimal("9.63"))
'''

CHECK = '''#!/usr/bin/env python3
import json
import os
import subprocess
import sys

result = subprocess.run([sys.executable, "-m", "unittest", "-q"])
trace = os.environ.get("HARNESS_TRACE_FILE")
if trace:
    with open(trace, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"record_type":"check","command":"python3 check.py","status":result.returncode}) + "\\n")
raise SystemExit(result.returncode)
'''


def main() -> None:
    root = Path.cwd()
    (root / "pricing.py").write_text(PRICING)
    (root / "test_pricing.py").write_text(TESTS)
    (root / "check.py").write_text(CHECK)
    (root / "TASK.md").write_text(
        "SAVE10 is applied to the tax-inclusive total. Compute and round tax first, "
        "then apply 10% and round the final amount to cents. The current code reverses those steps.\n"
    )


if __name__ == "__main__":
    main()
