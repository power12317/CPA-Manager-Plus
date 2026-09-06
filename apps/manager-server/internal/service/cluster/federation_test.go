package cluster

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

type jsonRuntime struct {
	fakeRuntime
	payload string
	code    int
}

func TestExportAllPreservesBothSourcesAndHandlesEmptySource(t *testing.T) {
	for _, empty := range []bool{false, true} {
		t.Run(map[bool]string{false: "both sources", true: "empty source"}[empty], func(t *testing.T) {
			id := "0123456789abcdef0123456789abcdef"
			legacy := &jsonRuntime{payload: "{\"auth_index\":\"1\",\"total_tokens\":7}\n"}
			child := &jsonRuntime{payload: "{\"auth_index\":\"1\",\"total_tokens\":11}\n"}
			if empty {
				child.payload = ""
			}
			repo := &memoryRegistry{items: []model.Instance{{ID: id, Name: "上海", Enabled: true}}}
			s := New(repo, func(context.Context, string) (Runtime, error) { return child, nil }, legacy)
			s.Start(context.Background())
			waitReady(t, s)
			defer s.Close(context.Background())
			file, err := s.ExportAll(httptest.NewRequest("GET", "/usage/export", nil))
			if err != nil {
				t.Fatal(err)
			}
			name := file.Name()
			defer file.Close()
			decoder := json.NewDecoder(file)
			var rows []map[string]any
			for {
				var row map[string]any
				if err := decoder.Decode(&row); err == io.EOF {
					break
				} else if err != nil {
					t.Fatal(err)
				}
				rows = append(rows, row)
			}
			want := 2
			if empty {
				want = 1
			}
			if len(rows) != want || rows[0]["auth_index"] != qualified("default", "1") {
				t.Fatalf("incorrect export: %#v", rows)
			}
			if !empty && (rows[1]["auth_index"] != qualified(id, "1") || rows[1]["total_tokens"] != float64(11)) {
				t.Fatalf("second source lost: %#v", rows)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(name); !os.IsNotExist(err) {
				t.Fatalf("temporary export was not removed: %v", err)
			}
		})
	}
}

func (r *jsonRuntime) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if r.code > 0 {
		w.WriteHeader(r.code)
	}
	_, _ = w.Write([]byte(r.payload))
}

func TestFederationPartialFailureAndEncodedCredentialIdentity(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	legacy := &jsonRuntime{payload: `{"events":7}`}
	child := &jsonRuntime{payload: `{"error":"offline"}`, code: 503}
	repo := &memoryRegistry{items: []model.Instance{{ID: id, Name: "上海", Enabled: true}}}
	s := New(repo, func(context.Context, string) (Runtime, error) { return child, nil }, legacy)
	s.Start(context.Background())
	waitReady(t, s)
	defer s.Close(context.Background())
	req := httptest.NewRequest("GET", "/status", nil)
	result, err := s.Federate(req, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 2 || result.Succeeded != 1 || len(result.Failures) != 1 || result.Failures[0] != "上海" {
		t.Fatalf("failure coverage missing: %#v", result)
	}
	req = httptest.NewRequest("DELETE", "/v0/management/auth-files?name="+url.QueryEscape(qualified(id, "same")), nil)
	identity := []map[string]any{{"name": "[上海] same.json", "runtimeId": qualified(id, "same"), "authIndex": qualified(id, "1")}}
	raw, _ := json.Marshal(identity)
	req.Header.Set("X-CPAMP-Auth-File-Delete-Identities", url.QueryEscape(string(raw)))
	req.Header.Set("X-CPAMP-Auth-File-Physical-Name", url.QueryEscape("[上海] same.json"))
	req.Header.Set("X-CPAMP-Auth-File-Physical-Name-Encoding", "uri")
	origins, err := s.RequestOrigins(req, nil)
	if err != nil || len(origins) != 1 || origins[0] != id {
		t.Fatalf("bad origin resolution: %v %v", origins, err)
	}
	scoped, err := s.ScopedRequest(req, nil, id)
	if err != nil {
		t.Fatal(err)
	}
	if scoped.URL.Query().Get("name") != "same" || scoped.Header.Get("X-CPAMP-Auth-File-Physical-Name") != "same.json" {
		t.Fatalf("physical source was not restored: %#v", scoped.Header)
	}
	decoded, _ := url.QueryUnescape(scoped.Header.Get("X-CPAMP-Auth-File-Delete-Identities"))
	if strings.Contains(decoded, machinePrefix) || strings.Contains(decoded, "上海") {
		t.Fatalf("qualified identity reached CPA: %s", decoded)
	}
}
