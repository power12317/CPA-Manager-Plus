package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBasePathRetainedAndStrippedProxies(t *testing.T) {
	h := BasePath("/tools/cpamp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("X-Path", r.URL.Path); w.WriteHeader(200) }))
	for _, path := range []string{"/tools/cpamp/api/instances", "/api/instances"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || w.Header().Get("X-Path") != "/api/instances" {
			t.Fatalf("%s: %d %s", path, w.Code, w.Header().Get("X-Path"))
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/tools/cpamp", nil))
	if w.Code != 307 || w.Header().Get("Location") != "/tools/cpamp/" {
		t.Fatal("missing trailing slash redirect")
	}
}
