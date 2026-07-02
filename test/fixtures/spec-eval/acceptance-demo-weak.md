# Add a comms digest export

## Why

The operator wants a single command that exports a rolled-up digest of recent comms activity, so
they can share a quick readout without opening five tools. This matters because the readout is the
thing people actually ask for.

## Acceptance

- The export works well and is fast.
- The digest looks good and reads nicely.

## Reuse & integration

This reuses `src/operator-loop/digest.ts` for the fold, and then formats the rolled-up result and
pushes the digest to the brain so everyone can see it.
