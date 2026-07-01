# Example confidential term set for scripts/leak-gate.sh.
#
# Copy this to ~/.config/aios-nda/leak-gate-terms.sh (or point $AIOS_LEAK_TERMS_FILE at it)
# and fill in the identifiers your NDA / confidentiality agreement protects. Keep the real
# file OUT of the repo — that's the whole point: a public repo must never enumerate the
# protected names. For CI enforcement, base64 the filled-in file into the $AIOS_LEAK_TERMS_B64
# repo secret.
#
# Each variable is a grep -E alternation:
#   STRONG   — substring match, case-insensitive. Distinctive client/firm/product codenames.
#   WORDS    — whole-word match only. Short/ambiguous names that would false-positive as
#              substrings (e.g. a first name that is also a common word).
#   PATTERNS — structured business data (ticket / change-order / invoice / amount formats).
#
# The values below are PLACEHOLDERS — replace them.

STRONG='acme-corp|globex-industries|initech|umbrella-co|wonka-group'
WORDS='Initech|Globex|Umbrella'
PATTERNS='TICKET-[0-9]+|CO-[0-9]+|INV-[0-9]+|€[0-9]|EUR[[:space:]]*[0-9]'
