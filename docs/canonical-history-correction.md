# Canonical history correction with preserved Codex baseline

The revision-3 integration retains the upstream canonical accounting repair and
the fork's immutable pre-cutover Mac history. The user approved the bounded
six-column accounting correction exception on 2026-10-23.

A new revision-3 pass after completed revision 2 writes only rows whose canonical
accounting evidence is complete, self-consistent and accepted by the same parser
used for new events. Explicit mode and known provider/executor/model semantics
still take precedence. Unrelated legacy rows and malformed or inconsistent
canonical records are not changed by that pass. The canonical-only marker is
persisted so interruption and restart do not broaden its scope. An unfinished
revision-2 pass retains its checkpoint and staged changes before revision 3 runs.

The writable columns remain `cache_input_mode`,
`normalized_uncached_input_tokens`, `normalized_total_input_tokens`,
`normalized_cache_read_tokens`, `normalized_cache_creation_tokens` and
`total_tokens`. The last column only changes under the existing derived-total
rule; explicit totals remain intact. A proven canonical total is also preserved
when the older raw envelope omits its own total hint, preventing reasoning from
being added twice. Raw token columns, raw JSON, event identity,
credential identity and request count are preserved.

Pre-cutover Codex events are excluded before staging. Existing Mac account-history
and pricing rows are retained with their original watermarks, including totals
whose raw history is no longer present. Rebuilding other derived data skips the
retained range to prevent double counting. Old shared history is not reassigned
to Windows credentials.

The post-listener migration keeps bounded batches, checkpointed resume and the
existing projection/rollup invalidation path. Regression coverage includes:

- Strict canonical-only admission and preservation of an unapplied revision-2
  checkpoint in `internal/repository/datamigration/repository_test.go`.
- Mixed canonical corrections and protected Mac/Windows history, interrupted
  application, store reopening, source-column immutability and listener checks
  in `internal/httpapi/credential_history_preservation_test.go`.
- 100,000 canonical rows plus 100,000 protected legacy rows in
  `TestCanonicalAccounting100KPreservesBaselineResumeAndListener`.
