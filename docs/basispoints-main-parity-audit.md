# Basispoints branch parity audit — 2026-09-25

## Cause

The Basispoints panel was built from the older `codex/websocket-har-alignment`
checkout (`929c39fd`), without first incorporating this fork's newer `main`.
The published `basispoints/v2026.09.25-2` panel therefore omitted existing
features. Before repair, `HEAD...origin/main` contained 3 branch-only commits
and 173 main-only commits (including merges). The common ancestor was
`61c2df0507e6cb376ccbbeaf86dbc8b16e666915`.

## Repair and scope

Merge fork main `3453e7ab` into `codex/basispoints-integration`. Keep both
main's ticket/device tests and the branch's transport-switch tests at the one
textual conflict in `useVisualConfig.test.ts`.

The functional source diff against that main commit is additive: the Basispoints
and upstream WebSocket switches, their YAML/API/i18n/demo support and tests,
and the dedicated Docker publishing workflow. No main source file or functional
code is deleted. Three outdated ticket descriptions in each of four locales are
also corrected: validation follows CPA policy, the panel does not choose ticket
lengths, and an empty harvesting proxy uses the backend's default connection.
Main's Manager Server code and existing migrations remain identical.

Restored functionality includes:

| Area | Main functionality retained |
| --- | --- |
| Codex turn-state configuration | Probe enablement, fail-closed policy, model list, dedicated proxy, TTL, refresh lead time, probe interval, attempt timeout, shared YAML draft/save, instance-scoped capability checks |
| Credential ticket status | Per-model readiness/missing/blocked states, expiry countdown, account list/detail integration, refresh and scoped state handling |
| Device identity | Independently configured device convergence alongside identity confusion and device stabilization |
| Request monitoring | Codex request metadata and model/source presentation |
| Panel hosting | CPA-hosted login/runtime and Full Docker behavior |
| Devin | OAuth, quota, credential handling and multi-instance routing |
| Model pricing | Runtime model sync/attention, editable pricing rules and preservation of manual prices |
| Credentials and sessions | Mutation/reconciliation improvements, session persistence and storage compatibility fixes |
| Usage history | Sanitized persistence, credential history isolation, Mac history baseline and online migration/index fixes |

The companion CPA repair removes an unintended coupling in
`EffectiveTurnStateTicket`: enabling Basispoints must not override the
independent `codex.turn-state-ticket.enabled` setting. Native probe settings
and harvested status remain available while model generation uses Basispoints.
Model names, actual reasoning values and the original suffix parser are unchanged.

## Regression checks

- YAML round trips toggle Basispoints and upstream WebSocket without altering
  ticket settings or device identity; editing ticket timing preserves both switches.
- Existing ticket card, account status/countdown, scoped capability and device
  convergence tests run with the restored main suite.
- CPA tests cover effective settings, management GET/PATCH persistence and an
  actual fake-upstream probe across Basispoints toggles.
- Manager verification includes the existing 100,001-row interruption/resume
  and listener-availability test plus the 100,000-row Mac history baseline test.
- Release via a new immutable `basispoints/v2026.09.25-3` tag; retain `-1` and
  `-2` as historical snapshots.

The user's original CPAMP checkout and its uncommitted files are outside this
repair worktree and are preserved.

## Verification results

- Type check and lint pass (five existing lint warnings, zero errors).
- 252 frontend test files / 3,839 tests and 16 repository test files / 260 tests pass.
- Manager Server ordinary and race suites pass, including the existing scale,
  interrupted migration, restart/resume and startup availability coverage.
- CPA full tests, required server build and targeted config/management/harvester
  race tests pass. The original suffix parser is unchanged from `30809fd7`.
- The single-file production bundle builds and passes demo-isolation checks.
- Browser verification against an isolated CPA instance confirms CPA Panel login,
  both transport switches, ticket settings, and a synthetic credential's ready
  countdown/missing status. A real configuration save changes the probe interval
  without overwriting the independent switches; management readback confirms
  ticket probing and readiness remain enabled with Basispoints enabled.
- Browser checks use a disabled synthetic credential; no real OAuth account is used.

The initial unrestricted parallel test run hit timeout-only failures in four
frontend tests and one Manager price-source fallback test. Reducing worker/package
concurrency passes the complete suites without changing tests or timeout thresholds.
