# Codex runtime logs and request monitoring

Codex runtime requests use the same CPA log and monitoring paths as native Codex
requests. The runtime switch does not select a separate CPAMP collector, database,
log parser or download endpoint. CPA must publish the provider as `codex` and retain
the shared credential's identity. The executor remains `CodexRuntimeExecutor` so
diagnostics accurately identify how the request was executed.

| Existing surface | Existing source | Compatibility requirement |
| --- | --- | --- |
| Logs page | CPA `/v0/management/logs` | Preserve the request ID, credential/session/turn context, status, latency, model columns and optional node. |
| Download request log | CPA `/v0/management/request-log-by-id/:id` | Use the same request ID shown in logs and request monitoring. Forward the original request, response and error content. |
| Error logs | CPA `/v0/management/request-error-logs` and its file download route | Preserve file names, contents and attachment headers. |
| Request monitoring | Existing CPA usage queue, local SQLite and `/v0/management/monitoring/analytics` | Preserve provider/credential grouping, model and request IDs, execution type, status, latency/TTFT, reasoning/service tier, trace/session metadata, existing token fields and sanitized failure summary. |

The Logs page displays CPA logs through the management API. Manager Server's own
process stdout remains its operational log; CPAMP does not duplicate inference
payloads into that stdout. Raw error bodies remain local to existing storage and
authenticated log downloads; request-monitoring JSON retains its existing
sanitized-summary behavior.

Regression coverage checks native and runtime executor metadata with streaming
and non-streaming success/failure records, the credential/provider filter, the
monitoring API and frontend adapters, Gin request correlation, and unmodified
request/error log downloads. These tests do not add or replace statistics
collection. CPA and Codex provide the real upstream logging hooks.

## Independent CPAMP deployment

The Codex mode page exposes only the mode switch, official browser authorization
and full callback URL submission, authorization results, and existing account
switches or reauthorization. All requests use CPA management endpoints. CPA owns
discovery, account binding and connections; no worker address, secret, model or
credential-file configuration is exposed by CPAMP. Existing credential identifiers
are CPA Auth.ID values, including any relative path within auths, and are sent
unchanged. The page displays CPA's account labels and does not rename, copy or
edit credential files. New authorization sends an empty object to CPA; explicit
reauthorization sends only the selected account ID.

The runtime branch publishes:

- `ghcr.io/power12317/cpamp-codex-runtime:dev`
- `ghcr.io/power12317/cpamp-codex-runtime:sha-<full-commit>`

Both Linux amd64 and arm64 are included. This development image has a separate
package and workflow. The production name `cpa-manager-plus` is reserved for
`main`; non-main manual runs of the production workflow are skipped.
Use the immutable SHA tag or manifest digest when pinning a deployment.

Use the existing standalone Compose file with the desired published image:

```sh
CPAMP_IMAGE=ghcr.io/power12317/cpamp-codex-runtime:dev \
  docker compose -f docker-compose.image.yml up -d --pull always
```

This starts CPAMP only. Configure the CPA base URL and CPA Management Key in the
existing setup/instance UI; CPAMP communicates with CPA, and CPA communicates
with Codex workers. A CPA URL must be reachable from the CPAMP container.

| Setting | Value |
| --- | --- |
| Published port | `18317:18317` (the file also accepts `CPAMP_PORT` and `CPAMP_BIND_ADDRESS`) |
| `HTTP_ADDR` | `0.0.0.0:18317` |
| `USAGE_DATA_DIR` | `/data` |
| `USAGE_DB_PATH` | `/data/usage.sqlite` |
| `CPA_MANAGER_DATA_KEY_PATH` | `/data/data.key` |
| Persistent volume | `cpa-manager-plus-data:/data`, retaining SQLite and `data.key` together |
| `CPA_MANAGER_ADMIN_KEY` | Optional; empty on first boot generates a key and prints it once |
| Panel | `http://<host>:18317/management.html` |
| Health | `http://<host>:18317/health` |

No Codex port, Codex token file, shared CPA credential directory or Docker socket
needs to be mounted into CPAMP. The existing collector defaults remain unchanged;
the CPA usage queue must have one consumer and retention must exceed the polling
interval. Keep the existing saved CPA connection when upgrading a CPAMP volume.
