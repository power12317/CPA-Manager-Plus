package usage

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOailbNodeNormalizationAndImportCompatibility(t *testing.T) {
	for _, value := range []string{"unified-96", " UNIFIED-96 ", "a", strings.Repeat("a", 63), "", "chat.gateway.unified-96.api.openai.com", "eyJhbGci.eyJob3N0.signature", "a_b", "-node", "node-", "node\ninjected", strings.Repeat("a", 64)} {
		t.Run(value, func(t *testing.T) {
			want := ""
			if value == "unified-96" || value == " UNIFIED-96 " {
				want = "unified-96"
			}
			if value == "a" || value == strings.Repeat("a", 63) {
				want = value
			}
			for _, key := range []string{"oailb_node", "oailbNode"} {
				raw, _ := json.Marshal(map[string]any{"timestamp": "2026-09-26T12:00:00Z", "model": "gpt-test", key: value})
				event, err := NormalizeRaw(raw)
				if err != nil || event.OailbNode != want {
					t.Fatalf("normalize: node=%q err=%v", event.OailbNode, err)
				}
				prepared := PrepareSensitiveFieldsForPersistence(Event{OailbNode: value, RawJSON: string(raw)})
				var persisted map[string]any
				if err := json.Unmarshal([]byte(prepared.RawJSON), &persisted); err != nil {
					t.Fatal(err)
				}
				if prepared.OailbNode != want || persisted[key] != want {
					t.Fatalf("persistence retained invalid node: %+v", prepared)
				}
				for _, payload := range []any{event, BuildPayload([]Event{event})} {
					data, _ := json.Marshal(payload)
					result, err := ParseImportPayload(data)
					if err != nil || len(result.Events) != 1 || result.Events[0].OailbNode != want {
						t.Fatalf("round trip: %+v %v", result, err)
					}
				}
			}
		})
	}
}

func TestOailbNodeDoesNotChangeEventIdentityOrInferFromCookies(t *testing.T) {
	base := `{"timestamp":"2026-09-26T12:00:00Z","model":"gpt-test","input_tokens":1}`
	legacy, err := NormalizeRaw([]byte(base))
	if err != nil {
		t.Fatal(err)
	}
	withNode, err := NormalizeRaw([]byte(strings.TrimSuffix(base, "}") + `,"oailb_node":"unified-96"}`))
	if err != nil {
		t.Fatal(err)
	}
	if legacy.OailbNode != "" || legacy.EventHash != withNode.EventHash {
		t.Fatal("optional metadata changed request identity")
	}
	noNode, err := NormalizeRaw([]byte(strings.TrimSuffix(base, "}") + `,"response_headers":{"Set-Cookie":["__oailb=eyJhbGci.eyJob3N0.signature"]}}`))
	if err != nil || noNode.OailbNode != "" {
		t.Fatalf("must trust only reported request node: %+v %v", noNode, err)
	}
}
