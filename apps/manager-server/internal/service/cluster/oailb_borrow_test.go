package cluster

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
)

func TestOailbSettingsDoNotFollowRedirectsWithSourceSecrets(t *testing.T) {
	var received atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { received.Add(1); w.WriteHeader(200) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	var result map[string]any
	err := requestOailbSettings(context.Background(), model.ManagerCPAConnectionConfig{CPABaseURL: redirect.URL, ManagementKey: "target-secret"}, "PUT", map[string]string{"source-management-key": "source-secret"}, &result)
	if err != ErrBorrowUnavailable || received.Load() != 0 {
		t.Fatalf("redirect exposed credentials: received=%d err=%v", received.Load(), err)
	}
}
