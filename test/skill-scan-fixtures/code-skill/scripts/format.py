#!/usr/bin/env python3
"""Benign formatter: read a JSON list from stdin, print one item per line.

Pure stdin/stdout helper — exercises the scanner's "elevated" path
(code present, no high-severity signals).
"""
import json
import sys


def main():
    items = json.load(sys.stdin)
    for i, item in enumerate(items, 1):
        print(f"{i}. {item}")


if __name__ == "__main__":
    main()
