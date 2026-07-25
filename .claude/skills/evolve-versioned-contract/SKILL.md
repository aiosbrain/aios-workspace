---
name: evolve-versioned-contract
description: Change a versioned API, event, transcript, persisted record, schema, or wire contract. Use when compatibility, migrations, producers, consumers, validators, fixtures, or rollback and read behavior must be designed and sequenced.
---

# Evolve a versioned contract

1. Identify the canonical contract version and compatibility promises.
2. Enumerate every producer, consumer, schema, runtime validator, generated type, fixture,
   migration, adapter, persisted reader/writer, and document that participates.
3. Choose and state additive versioning, migration, dual-read/write, or deliberate breakage. Stop
   when product ownership must choose the compatibility policy.
4. Sequence contract or schema first, then types and validators, adapters and migrations,
   producers, consumers, tests, generated output, and docs.
5. Specify old/new positive and negative fixtures plus unknown-field, downgrade, rollback, replay,
   and partial-deployment behavior.
6. Verify deployed readers can tolerate the chosen rollout order and that recovery does not depend
   on discarded data.
7. Return a compatibility matrix and ordered implementation and verification plan.

Do not accept a schema-only change as complete or import unrelated domain privacy rules.
