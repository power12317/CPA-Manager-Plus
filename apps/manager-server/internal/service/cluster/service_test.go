package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/dashboard"
)

type memoryRegistry struct {
	mu    sync.Mutex
	items []model.Instance
}

func (r *memoryRegistry) LoadInstances(context.Context) ([]model.Instance, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]model.Instance(nil), r.items...), nil
}
func (r *memoryRegistry) SaveInstances(_ context.Context, items []model.Instance) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items = append([]model.Instance(nil), items...)
	return nil
}

type fakeRuntime struct {
	mu         sync.Mutex
	connection model.ManagerCPAConnectionConfig
	fail       bool
	starts     int
	stops      int
	active     *atomic.Int32
	peak       *atomic.Int32
}

func (r *fakeRuntime) ServeHTTP(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }
func (r *fakeRuntime) Connection(context.Context) (model.ManagerCPAConnectionConfig, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connection, nil
}
func (r *fakeRuntime) Configure(_ context.Context, c model.ManagerCPAConnectionConfig) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.connection = c
	return nil
}
func (r *fakeRuntime) Start(context.Context) { r.mu.Lock(); defer r.mu.Unlock(); r.starts++ }
func (r *fakeRuntime) Stop(context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stops++
	return nil
}
func (r *fakeRuntime) Close() error                { return nil }
func (r *fakeRuntime) Online(context.Context) bool { return !r.fail }
func (r *fakeRuntime) Credentials(ctx context.Context) ([]map[string]any, error) {
	if r.active != nil {
		n := r.active.Add(1)
		defer r.active.Add(-1)
		for old := r.peak.Load(); n > old; old = r.peak.Load() {
			if r.peak.CompareAndSwap(old, n) {
				break
			}
		}
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if r.fail {
		return nil, errors.New("upstream error containing secret")
	}
	return []map[string]any{{"name": "same.json", "id": "same-id"}}, nil
}
func (r *fakeRuntime) Summary(context.Context, dashboard.SummaryParams) (dashboard.SummaryResponse, error) {
	return dashboard.SummaryResponse{Today: dashboard.TodaySummary{TotalCalls: 3}}, nil
}

func waitReady(t *testing.T, s *Service) {
	t.Helper()
	select {
	case <-s.ready:
	case <-time.After(3 * time.Second):
		t.Fatal("registry did not initialize")
	}
}

func TestTenInstancesAggregateWithoutIdentityLossAndPersist(t *testing.T) {
	ctx := context.Background()
	repo := &memoryRegistry{}
	var active, peak atomic.Int32
	legacy := &fakeRuntime{connection: model.ManagerCPAConnectionConfig{CPABaseURL: "http://default:8317", ManagementKey: "legacy-key"}, active: &active, peak: &peak}
	var runtimes sync.Map
	factory := func(_ context.Context, id string) (Runtime, error) {
		if rt, ok := runtimes.Load(id); ok {
			return rt.(*fakeRuntime), nil
		}
		rt := &fakeRuntime{active: &active, peak: &peak}
		runtimes.Store(id, rt)
		return rt, nil
	}
	s := New(repo, factory, legacy)
	s.Start(ctx)
	waitReady(t, s)
	ids := make([]string, 0, 9)
	for i := 0; i < 9; i++ {
		id, err := s.Save(ctx, "", Input{Name: fmt.Sprintf("CPA %d", i), BaseURL: fmt.Sprintf("http://node-%d:8317", i), ManagementKey: "private-key", Enabled: true})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rt, _ := runtimes.Load(ids[0])
	rt.(*fakeRuntime).fail = true
	result, err := s.Credentials(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 10 || result.Succeeded != 9 {
		t.Fatalf("coverage=%d/%d", result.Succeeded, result.Total)
	}
	seen := map[string]bool{}
	for _, item := range result.Instances {
		if seen[item.InstanceID] {
			t.Fatal("instance identity collapsed")
		}
		seen[item.InstanceID] = true
		if item.Error == "" && item.Data[0]["name"] != "same.json" {
			t.Fatal("credential missing")
		}
	}
	if peak.Load() > 4 || peak.Load() < 2 {
		t.Fatalf("unexpected concurrency=%d", peak.Load())
	}
	items, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(items)
	if string(raw) == "" || containsSecret(raw) {
		t.Fatalf("public registry leaked key: %s", raw)
	}
	if _, err := s.Save(ctx, "", Input{Name: "duplicate", BaseURL: "http://node-1:8317/", ManagementKey: "x", Enabled: true}); err == nil {
		t.Fatal("duplicate queue consumer accepted")
	}
	if _, err := s.Save(ctx, ids[1], Input{Name: "offline", BaseURL: "http://node-1:8317", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Runtime(ids[1]); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled route: %v", err)
	}
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	restarted := New(repo, factory, legacy)
	restarted.Start(ctx)
	waitReady(t, restarted)
	defer restarted.Close(ctx)
	items, err = restarted.List(ctx)
	if err != nil || len(items) != 10 {
		t.Fatalf("registry after restart: count=%d err=%v", len(items), err)
	}
	if _, err := restarted.Runtime(ids[1]); !errors.Is(err, ErrDisabled) {
		t.Fatal("disabled state lost on restart")
	}
}

func containsSecret(raw []byte) bool {
	text := string(raw)
	return strings.Contains(text, "private-key") || strings.Contains(text, "legacy-key")
}

func TestRegistryListRemainsAvailableWhileAnInstanceOpens(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	repo := &memoryRegistry{items: []model.Instance{{ID: id, Name: "slow", Enabled: true}}}
	entered := make(chan struct{})
	release := make(chan struct{})
	s := New(repo, func(context.Context, string) (Runtime, error) { close(entered); <-release; return &fakeRuntime{}, nil }, &fakeRuntime{connection: model.ManagerCPAConnectionConfig{CPABaseURL: "http://legacy:8317", ManagementKey: "legacy"}})
	s.Start(context.Background())
	<-entered
	done := make(chan struct{})
	go func() {
		defer close(done)
		items, err := s.List(context.Background())
		if err != nil || len(items) != 2 {
			t.Errorf("list while opening: %v", err)
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("opening a database blocked registry reads")
	}
	close(release)
	waitReady(t, s)
	_ = s.Close(context.Background())
}

type delayedOnlineRuntime struct {
	mu         sync.Mutex
	connection model.ManagerCPAConnectionConfig
	calls      atomic.Int32
}

func (r *delayedOnlineRuntime) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}
func (r *delayedOnlineRuntime) Connection(context.Context) (model.ManagerCPAConnectionConfig, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.connection, nil
}
func (r *delayedOnlineRuntime) Configure(_ context.Context, c model.ManagerCPAConnectionConfig) error {
	r.mu.Lock()
	r.connection = c
	r.mu.Unlock()
	return nil
}
func (r *delayedOnlineRuntime) Credentials(context.Context) ([]map[string]any, error) {
	return nil, nil
}
func (r *delayedOnlineRuntime) Online(ctx context.Context) bool {
	r.calls.Add(1)
	select {
	case <-time.After(100 * time.Millisecond):
		return true
	case <-ctx.Done():
		return false
	}
}
func (r *delayedOnlineRuntime) Summary(context.Context, dashboard.SummaryParams) (dashboard.SummaryResponse, error) {
	return dashboard.SummaryResponse{}, nil
}
func (r *delayedOnlineRuntime) Start(context.Context)      {}
func (r *delayedOnlineRuntime) Stop(context.Context) error { return nil }
func (r *delayedOnlineRuntime) Close() error               { return nil }

func TestListDoesNotProbeEveryAggregateRequest(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef"
	repo := &memoryRegistry{items: []model.Instance{{ID: id, Name: "cached", Enabled: true}}}
	runtime := &delayedOnlineRuntime{connection: model.ManagerCPAConnectionConfig{
		CPABaseURL: "http://cached:8317", ManagementKey: "key",
	}}
	s := New(repo, func(context.Context, string) (Runtime, error) { return runtime, nil }, &fakeRuntime{})
	s.Start(context.Background())
	waitReady(t, s)
	defer s.Close(context.Background())

	started := time.Now()
	if _, err := s.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed >= 80*time.Millisecond {
		t.Fatalf("registry list waited for remote health probe: %s", elapsed)
	}
	if _, err := s.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for runtime.calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := runtime.calls.Load(); got != 1 {
		t.Fatalf("expected one shared probe, got %d", got)
	}
	if _, err := s.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := runtime.calls.Load(); got != 1 {
		t.Fatalf("cached list scheduled another probe, got %d", got)
	}
}

func TestReadOnlyAggregateWithoutInstancesReturnsEmptyPayload(t *testing.T) {
	s := New(&memoryRegistry{}, func(context.Context, string) (Runtime, error) {
		return nil, errors.New("no instances should be initialized")
	}, &fakeRuntime{})
	s.Start(context.Background())
	waitReady(t, s)
	defer s.Close(context.Background())

	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "http://manager/v0/management/config", nil),
		httptest.NewRequest(http.MethodPost, "http://manager/v0/management/monitoring/analytics", strings.NewReader(`{"from_ms":1,"to_ms":2}`)),
	} {
		result, err := s.Federate(request, nil)
		if err != nil {
			t.Fatalf("read-only aggregate failed without instances: %v", err)
		}
		if result.Succeeded != 0 || result.Total != 0 || result.Data == nil {
			t.Fatalf("unexpected empty aggregate result: %+v", result)
		}
	}
}
