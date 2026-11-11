---
name: Multimedia timestamp interoperability
description: Non-obvious FFprobe time-string restrictions and source-offset handling.
---

Pass decimal-formatted time strings to FFprobe interval parsing, not JavaScript's implicit number formatting.

**Why:** Audio encoder delay can make a container start time negative. Adding/subtracting that offset near zero produces tiny floating-point residues that JavaScript formats in scientific notation; FFprobe rejects that notation as a duration even though the value is valid.

**How to apply:** Preserve source offsets and actual decoded frame PTS. Format subprocess time intervals explicitly as decimals, and include negative-start media in regression coverage. Never fix this by dropping start offsets or reporting the requested timestamp as if it were decoded evidence.
