# Contributing to CPA Manager Plus

Thanks for contributing to this maintained fork. `main` is the stable release
branch and the repository default branch. Feature, fix, documentation, and
maintenance work can be integrated directly into this fork's `main` branch.

## Branch and Pull Request Flow

1. Clone `https://github.com/power12317/CPA-Manager-Plus.git`.
2. Create a focused feature or fix branch from `main`.
3. Open the pull request against `power12317/CPA-Manager-Plus:main`, or push
   directly to `main` when you are the repository maintainer.
4. Address review feedback and keep the branch current with this fork's
   `main`.

```bash
git clone https://github.com/power12317/CPA-Manager-Plus.git
cd CPA-Manager-Plus
git switch -c fix/short-description main

# Before requesting review, update your branch as appropriate for your team.
git fetch origin
git rebase origin/main
```

## Before Opening a Pull Request

- Read the pull request template and complete every applicable section.
- Keep each pull request focused; do not combine unrelated features and fixes.
- Include tests for changed behavior and run the checks relevant to your scope.
- Add screenshots or recordings for visible UI changes.
- Preserve both CPA Panel and Full Docker semantics when your change affects
  authentication, setup, proxying, collection, or monitoring.
- Never commit secrets, admin keys, CPA Management Keys, SQLite data, generated
  runtime files, or local configuration.

## Local Verification

Use the narrowest checks that cover your change, then run broader checks when
the change crosses frontend, Manager Server, packaging, or runtime boundaries.

| Area | Command |
| --- | --- |
| Frontend type and lint | `npm run type-check` and `npm run lint` |
| Frontend and repository tests | `npm run test` |
| Frontend bundle | `npm run build` |
| Manager Server | `npm run manager-server:test` |
| Concurrent backend behavior | `cd apps/manager-server && go test -race ./...` |

CI runs the applicable checks on pull requests to `main`. Passing CI does not
replace mode-specific manual verification where the pull request template
requires it.

## Maintainer Release

After the fork's `main` checks pass, create release tags only from the verified
`main` commit. The Docker workflow publishes the fork image from that branch.
