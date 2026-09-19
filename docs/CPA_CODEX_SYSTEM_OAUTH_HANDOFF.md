# CPA Codex System OAuth Compatibility Handoff

This note describes the CPA-side contract that the management panel should consume.

## OAuth buttons

New CPA versions expose `GET /v0/management/codex-capabilities` and return:

```json
{"system_scoped_oauth":true}
```

When this capability is true, show two Codex actions:

- `开始 mac Codex 登录` → `/v0/management/codex-auth-url?is_webui=true&client_system=mac`
- `开始 Windows Codex 登录` → `/v0/management/codex-auth-url?is_webui=true&client_system=windows`

If the capability endpoint is unavailable or returns 404, treat CPA as an older version and keep the existing single `开始 Codex 登录` action without `client_system`.

For reauthorization, pass the target credential `auth_index` to `codex-auth-url`. CPA derives the target credential's system from that record, so the panel does not need to add a system column or system label to credential management.

## Credential filenames

macOS is the legacy/default system. Existing and new macOS credentials keep the existing filename. Only Windows credentials receive the `-windows` suffix. A missing `codex_client_system` field means macOS.

## Usage refresh

Continue using the existing management `api-call` request for `/backend-api/wham/usage` with the selected credential's `auth_index`. New CPA versions select the credential-scoped Cookie Jar and system-specific Codex User-Agent server-side. The panel may retain its legacy macOS User-Agent for compatibility with older CPA versions; new CPA overrides it for the selected credential.

Do not display or merge the two credentials in the panel. They remain two normal credential rows and are separated by their existing names and identities.
