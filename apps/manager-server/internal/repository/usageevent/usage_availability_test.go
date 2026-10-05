package usageevent

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestUnknownUsageSurvivesPersistenceWithoutRawJSON(t *testing.T) {
	db, err := sqliterepo.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := New(db)
	event, err := usage.NormalizeRaw([]byte(`{"timestamp":"2026-10-04T10:00:00Z","provider":"codex","model":"gpt-6.1-sol","endpoint":"POST /v1/responses","usage_unavailable":true,"tokens":null,"token_breakdown":null,"latency_ms":800,"failed":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if event.ResponseMetadata == nil || !event.ResponseMetadata.UsageUnavailable {
		t.Fatal("lost unavailable marker")
	}
	event.RawJSON = ""
	if _, err = repo.InsertBatch(context.Background(), []usage.Event{event}); err != nil {
		t.Fatal(err)
	}
	events, err := repo.ListRecent(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ResponseMetadata == nil || !events[0].ResponseMetadata.UsageUnavailable {
		t.Fatalf("events = %#v", events)
	}
	payload := usage.BuildPayload(events)
	if payload.TotalRequests != 1 || payload.SuccessCount != 1 || payload.UsageUnavailableRequests != 1 {
		t.Fatalf("counts = %#v", payload)
	}
	detail := payload.APIs["POST /v1/responses"].Models["gpt-6.1-sol"].Details[0]
	encoded, err := json.Marshal(detail)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err = json.Unmarshal(encoded, &record); err != nil {
		t.Fatal(err)
	}
	if record["usage_unavailable"] != true || record["tokens"] != nil || record["token_breakdown"] != nil || record["latency_ms"] != float64(800) || record["failed"] != false {
		t.Fatalf("detail = %s", encoded)
	}
	var stream bytes.Buffer
	if err = repo.WriteCompatibleUsage(context.Background(), &stream, 10); err != nil {
		t.Fatal(err)
	}
	var streamed usage.Payload
	if err = json.Unmarshal(stream.Bytes(), &streamed); err != nil {
		t.Fatal(err)
	}
	if streamed.UsageUnavailableRequests != 1 || streamed.TotalRequests != 1 {
		t.Fatalf("stream counts = %s", stream.String())
	}
	if !bytes.Contains(stream.Bytes(), []byte(`"tokens":null`)) || !bytes.Contains(stream.Bytes(), []byte(`"usage_unavailable":true`)) {
		t.Fatalf("stream = %s", stream.String())
	}
	var exported bytes.Buffer
	if err = repo.WriteExportJSONL(context.Background(), &exported, 10); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(exported.Bytes(), []byte(`"total_tokens":null`)) || !bytes.Contains(exported.Bytes(), []byte(`"usage_unavailable":true`)) {
		t.Fatalf("export = %s", exported.String())
	}
	// Compatible payloads can be ingested again without turning unknown usage into zero.
	imported, err := usage.NormalizeRaw(encoded)
	if err != nil || imported.ResponseMetadata == nil || !imported.ResponseMetadata.UsageUnavailable {
		t.Fatalf("round trip = %#v, %v", imported, err)
	}
}
