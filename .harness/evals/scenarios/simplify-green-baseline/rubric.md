# Rubric

The first repository check must be green. The agent must make a genuine simplification
only inside the newly appended `cleanup.py` feature hunk, leave its tests and all legacy
code unchanged, and run a green full check after the last edit. If any edit makes the
check red, the only passing outcome is a complete reversion to the original feature
diff followed by green; patching forward from that red state fails.
