# SIWC integration and replacement boundary

SIWC binding is available from the existing Codex card on the OAuth login page.
It targets an existing file-backed Codex credential that CPA explicitly marks
`siwc_bind_supported`. The credential Configuration tab offers **Use SIWC** and
the adjacent **Use SIWC for Codex clients** switch through existing Save/Reset.
Changing either switch saves `use_siwc` and `allow_codex_client_siwc` together via
`PATCH /v8/management/credentials/fields`, then reads the full credential JSON
from the captured instance to verify both values before reporting success.
Failed or mismatched readback retains the unsaved draft. Neither switch clears
the binding or automatically changes the instance's Codex runtime mode.

`allow_codex_client_siwc` is a credential boolean; missing, deleted or null means
true. Its draft is read from the complete credential JSON, not list summaries.
When true, native Codex clients follow `use_siwc` like other clients. When false,
CPA forces native Codex clients to regular OAuth without affecting other clients.
`use_siwc: false` always selects regular OAuth. CPA owns this routing policy;
the panel only edits the credential settings. The client permission can be saved
while Use SIWC is off, so disabling SIWC does not discard the user's preference.

The implementation follows the independent official panel at
`714de0760a3ce86094b178fb46f834d34bc4a2a5`. The direct CPAMP upstream at
`794ef828023960ccad0a2e9848293aee0880d688` has no SIWC implementation yet.

Requests use official `/v8/management`: `POST /oauth/siwc/bind`,
`POST /oauth/callback`, `GET /oauth/status`, `DELETE /oauth/session`,
`GET /credentials`, and `PATCH /credentials/fields`. The complete callback
retains the issued `client_id`. Every operation captures its CPA and credential;
late starts are cancelled on the original connection. A successful OAuth status
is followed by credential readback before the UI reports a verified binding.
Aggregate v8 requests are rejected; an aggregate credential resolves to its
server-issued single-instance identity before a request is sent.

Ordinary v0 OAuth and other existing APIs remain in place. Manager uses its
existing saved CPA key, credential identity verification and mutation locks for
v8 credential writes. This is shared infrastructure, not a second HTTP client.

## Mandatory replacement on upstream adoption

On each future direct-upstream sync, inspect whether it includes the complete
SIWC binding, issued-client-id callback, status/cancel, eligibility, credential
flags (including equivalent native Codex client selection) and UI. Once complete,
replace this temporary implementation with upstream
and delete its obsolete code in that same integration:

- `apps/web/src/features/oauth/siwc/`: binding dialog, draft toggle presentation,
  lifecycle model, SCSS and dedicated tests.
- `apps/web/src/services/api/siwc.ts` and its dedicated tests.
- Temporary imports in `OAuthPage`, `AccountConfigurationTab` and the credential
  configuration hook; replace them with upstream wiring.
- The temporary `siwc` locale namespace and this replacement document once the
  official equivalents are in place.
- Duplicate credential field normalization/types, including `use_siwc` and
  `allow_codex_client_siwc` draft/default/save/readback behavior, their tests and
  translations, and any obsolete fallback.

Keep one binding entry and one credential model. Retain necessary shared scoped
v8 transport, Manager authentication, ownership checks and cross-instance
regressions. Do not preserve a second legacy entry, add a permanent feature flag,
or clear user tokens, bindings, devices or tickets during replacement.
