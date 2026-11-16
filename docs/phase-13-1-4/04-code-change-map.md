# Code change map

- `src/plugin/section-geometry-recovery.ts` evaluates a single measured candidate using root, section transaction and semantic node markers. It returns a rollback for the one height change.
- `src/plugin/generation-controller.ts` integrates the candidate after initial native verification of v1 sections. The existing fresh verifier runs again and the change is rolled back unless the full pass succeeds on the same page.
- `tests/native-repair-recovery.test.ts` adds a deterministic 6 px fixture and guarded recovery checks.

No schema or storage migration. Legacy drafts keep their prior recovery behavior. Source rollback consists of reverting these additions; this does not require deleting a draft or native layer.
