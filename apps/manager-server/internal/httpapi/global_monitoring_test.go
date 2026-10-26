package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/worker"
)

func monitoringSignal(t *testing.T, ctx context.Context, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func finishMonitoringStartup(t *testing.T, ctx context.Context, runtime *instanceRuntime) {
	t.Helper()
	done := make(chan struct{})
	go func() { runtime.startup.Wait(); close(done) }()
	monitoringSignal(t, ctx, done)
}

func TestGlobalMonitoringRootlessClusterLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	started, ended := make(chan struct{}, 32), make(chan struct{}, 32)
	var offline atomic.Bool
	var configRequests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/management/config":
			configRequests.Add(1)
			if offline.Load() {
				w.WriteHeader(503)
				return
			}
			fmt.Fprint(w, `{"usage-statistics-enabled":true,"redis-usage-queue-retention-seconds":60}`)
		case "/v0/management/usage-queue":
			started <- struct{}{}
			<-r.Context().Done()
			ended <- struct{}{}
		default:
			fmt.Fprint(w, `{"status":"ok"}`)
		}
	}))
	defer upstream.Close()
	cfg := testutil.NewConfig(t)
	cfg.CollectorMode = "http"
	db := testutil.NewStore(t, cfg)
	protector, err := security.NewProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	root := New(cfg, db, collector.NewManager(cfg, db))
	cluster := root.EnableCluster(protector)
	cluster.Start(ctx)
	t.Cleanup(func() {
		_ = cluster.Close(context.Background())
		_ = root.appCtx.CollectorService.Stop(context.Background())
	})
	input := clustersvc.Input{Name: "A", BaseURL: upstream.URL, ManagementKey: "key", Enabled: true}
	id, err := cluster.Save(ctx, "", input)
	if err != nil {
		t.Fatal(err)
	}
	rt, err := cluster.Runtime(id)
	if err != nil {
		t.Fatal(err)
	}
	child := rt.(*instanceRuntime)
	finishMonitoringStartup(t, ctx, child)
	// New connections retain their original auto mode and 500ms defaults.
	monitoringSignal(t, ctx, started)
	get := func() managerconfig.Response {
		response := testutil.Request(t, root.Handler(), "GET", "/usage-service/config", "", testutil.AdminKey)
		testutil.RequireStatus(t, response, 200)
		var result managerconfig.Response
		testutil.DecodeJSON(t, response, &result)
		return result
	}
	save := func(enabled bool) {
		response := testutil.Request(t, root.Handler(), "PUT", "/usage-service/config", fmt.Sprintf(`{"config":{"collector":{"enabled":%t}}}`, enabled), testutil.AdminKey)
		testutil.RequireStatus(t, response, 200)
		value := get()
		if value.Config.Collector.Enabled == nil || *value.Config.Collector.Enabled != enabled {
			t.Fatalf("saved/display value=%+v", value)
		}
	}
	initial := get()
	if initial.Config.CPAConnection.CPABaseURL != "" || initial.RequestMonitoringAvailable == nil || !*initial.RequestMonitoringAvailable || !*initial.Config.Collector.Enabled {
		t.Fatalf("registered CPA not available to global control: %+v", initial)
	}
	testutil.RequireStatus(t, testutil.Request(t, root.Handler(), "PUT", "/usage-service/config", `{"config":{"collector":{"enabled":false}}}`, "wrong"), 401)
	save(false)
	monitoringSignal(t, ctx, ended)
	if child.server.appCtx.CollectorService.Status().Collector != "stopped" {
		t.Fatal("child continued after saved global false")
	}
	local, _, _, err := child.server.appCtx.ManagerConfigService.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !managerconfig.ManagerCollectorEnabled(local) || local.Collector.PollIntervalMS != 500 || local.Collector.BatchSize != 100 || local.Collector.CollectorMode != "auto" {
		t.Fatalf("instance settings changed: %+v", local.Collector)
	}
	// Per-instance config saves and registry reconnects cannot reopen the gate.
	_, err = child.server.appCtx.ManagerConfigService.Update(ctx, local)
	if err != nil {
		t.Fatal(err)
	}
	input.ManagementKey = "replacement-key"
	if _, err := cluster.Save(ctx, id, input); err != nil {
		t.Fatal(err)
	}
	if child.server.appCtx.CollectorService.Status().Collector != "stopped" {
		t.Fatal("save/reconnect bypassed global false")
	}
	input.Enabled = false
	if _, err := cluster.Save(ctx, id, input); err != nil {
		t.Fatal(err)
	}
	input.Enabled = true
	if _, err := cluster.Save(ctx, id, input); err != nil {
		t.Fatal(err)
	}
	finishMonitoringStartup(t, ctx, child)
	if child.server.appCtx.CollectorService.Status().Collector != "stopped" {
		t.Fatal("instance restart bypassed global false")
	}
	// No online probes/config reads may be required by global enable/disable.
	offline.Store(true)
	before := configRequests.Load()
	save(true)
	monitoringSignal(t, ctx, started)
	if configRequests.Load() != before {
		t.Fatal("global control probed an offline configured instance")
	}
	save(false)
	monitoringSignal(t, ctx, ended)
	// Preserve an explicit local false through global enable.
	offline.Store(false)
	local, _, _, _ = child.server.appCtx.ManagerConfigService.ResolveManagerConfigWithSource(ctx)
	disabled := false
	local.Collector.Enabled = &disabled
	if _, err := child.server.appCtx.ManagerConfigService.Update(ctx, local); err != nil {
		t.Fatal(err)
	}
	save(true)
	if child.server.appCtx.CollectorService.Status().Collector != "stopped" {
		t.Fatal("global enable overrode explicit instance false")
	}
	local, _, _, _ = child.server.appCtx.ManagerConfigService.ResolveManagerConfigWithSource(ctx)
	if managerconfig.ManagerCollectorEnabled(local) {
		t.Fatal("local false was rewritten")
	}
	save(false)
	if err := cluster.Close(ctx); err != nil {
		t.Fatal(err)
	}
	// Restart the program with a saved global false and then add another CPA.
	restarted := New(cfg, db, collector.NewManager(cfg, db))
	nextCluster := restarted.EnableCluster(protector)
	nextCluster.Start(ctx)
	defer nextCluster.Close(context.Background())
	// Save waits for registry startup, so a second entry is added deterministically.
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v0/management/usage-queue" {
			t.Error("new instance consumed while global false")
		}
		fmt.Fprint(w, `{"usage-statistics-enabled":true}`)
	}))
	defer other.Close()
	newID, err := nextCluster.Save(ctx, "", clustersvc.Input{Name: "B", BaseURL: other.URL, ManagementKey: "key-B", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, instanceID := range []string{id, newID} {
		runtime, err := nextCluster.Runtime(instanceID)
		if err != nil {
			t.Fatal(err)
		}
		r := runtime.(*instanceRuntime)
		finishMonitoringStartup(t, ctx, r)
		if r.server.appCtx.CollectorService.Status().Collector != "stopped" {
			t.Fatal("program restart or new instance bypassed saved false")
		}
	}
	if rootConfig, _, err := db.LoadManagerConfig(ctx); err != nil || managerconfig.ManagerCollectorEnabled(rootConfig) || rootConfig.CPAConnection.CPABaseURL != "" {
		t.Fatal("root setting/connection ownership changed")
	}
	if setup, ok, err := db.LoadSetup(ctx); err != nil || ok {
		t.Fatalf("unexpected root binding: %+v %v %v", setup, ok, err)
	}
}

func TestGlobalMonitoringEnvironmentStartupAndRootOffline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cfg := testutil.NewConfig(t)
	cfg.CPAUpstreamURL, cfg.ManagementKey, cfg.CollectorMode = "http://127.0.0.1:1", "test", "http"
	db := testutil.NewStore(t, cfg)
	disabled := false
	if err := db.SaveManagerConfig(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{Enabled: &disabled}}); err != nil {
		t.Fatal(err)
	}
	root := New(cfg, db, collector.NewManager(cfg, db))
	protector, _ := security.NewProtector(make([]byte, 32))
	cluster := root.EnableCluster(protector)
	cluster.Start(ctx)
	defer cluster.Close(ctx)
	defer root.appCtx.CollectorService.Stop(ctx)
	worker.NewCollectorWorker(cfg, db, root.appCtx.CollectorService).Start(ctx)
	if root.appCtx.CollectorService.Status().Collector != "stopped" {
		t.Fatal("environment startup bypassed saved false")
	}
	// An unchanged root binding need not be online to control collection.
	for _, enabled := range []bool{true, false} {
		submitted := model.ManagerConfig{Collector: model.ManagerCollectorConfig{Enabled: &enabled}}
		if _, err := root.appCtx.ManagerConfigService.Update(ctx, submitted); err != nil {
			t.Fatalf("offline root prevented global control: %v", err)
		}
	}
	if root.appCtx.CollectorService.Status().Collector != "stopped" {
		t.Fatal("offline root collector did not stop")
	}
	changed := model.ManagerConfig{CPAConnection: model.ManagerCPAConnectionConfig{CPABaseURL: "http://127.0.0.1:2"}}
	if _, err := root.appCtx.ManagerConfigService.Update(ctx, changed); err == nil {
		t.Fatal("environment connection ownership bypassed")
	}
}

func TestGlobalMonitoringRequiresARegisteredConnectionToEnable(t *testing.T) {
	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	root := New(cfg, db, collector.NewManager(cfg, db))
	protector, _ := security.NewProtector(make([]byte, 32))
	cluster := root.EnableCluster(protector)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cluster.Start(ctx)
	defer cluster.Close(context.Background())
	enabled := true
	_, err := root.appCtx.ManagerConfigService.Update(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{Enabled: &enabled}})
	if err == nil {
		t.Fatal("enabled without any configured CPA")
	}
	// The response is still the original true default, not a fabricated false.
	value, err := root.appCtx.ManagerConfigService.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(value)
	if value.RequestMonitoringAvailable == nil || *value.RequestMonitoringAvailable || !*value.Config.Collector.Enabled {
		t.Fatalf("unavailable differs from disabled: %s", encoded)
	}
}

func TestGlobalMonitoringRootChangesRetainValidation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var validations, usageEnable atomic.Int32
	var usagePublished atomic.Bool
	published := make(chan struct{}, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/management/config":
			validations.Add(1)
			fmt.Fprintf(w, `{"usage-statistics-enabled":%t,"redis-usage-queue-retention-seconds":60}`, usagePublished.Load())
		case "/v0/management/usage-statistics-enabled":
			var payload struct {
				Value bool `json:"value"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || !payload.Value || r.Method != http.MethodPut || r.Header.Get("Authorization") != "Bearer key" {
				t.Error("invalid CPA usage publication request")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			usageEnable.Add(1)
			usagePublished.Store(true)
			published <- struct{}{}
			fmt.Fprint(w, `{"status":"ok"}`)
		case "/v0/management/usage-queue":
			fmt.Fprint(w, `[]`)
		default:
			fmt.Fprint(w, `{}`)
		}
	}))
	defer upstream.Close()
	cfg := testutil.NewConfig(t)
	cfg.CollectorMode = "http"
	db := testutil.NewStore(t, cfg)
	initial := model.ManagerConfig{CPAConnection: model.ManagerCPAConnectionConfig{CPABaseURL: upstream.URL, ManagementKey: "key"}, Collector: model.ManagerCollectorConfig{Enabled: managerconfig.BoolPtr(false), CollectorMode: "http", PollIntervalMS: 500, BatchSize: 100}}
	if err := db.SaveManagerConfig(ctx, initial); err != nil {
		t.Fatal(err)
	}
	root := New(cfg, db, collector.NewManager(cfg, db))
	protector, _ := security.NewProtector(make([]byte, 32))
	cluster := root.EnableCluster(protector)
	cluster.Start(ctx)
	defer cluster.Close(context.Background())
	defer root.appCtx.CollectorService.Stop(context.Background())
	svc := root.appCtx.ManagerConfigService
	before, err := svc.Get(ctx)
	if err != nil || before.CPAUsage == nil || before.CPAUsage.UsageStatisticsEnabled || managerconfig.ManagerCollectorEnabled(initial) {
		t.Fatalf("expected saved monitoring and root CPA publication to start disabled: %+v %v", before, err)
	}
	initialReads := validations.Load()
	if _, err := svc.Update(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{Enabled: managerconfig.BoolPtr(true)}}); err != nil {
		t.Fatal(err)
	}
	monitoringSignal(t, ctx, published)
	if validations.Load() != initialReads || usageEnable.Load() != 1 || !usagePublished.Load() {
		t.Fatal("pure toggle must restore root CPA publication without online validation")
	}
	after, err := svc.Get(ctx)
	if err != nil || after.CPAUsage == nil || !after.CPAUsage.UsageStatisticsEnabled || after.Config.Collector.Enabled == nil || !*after.Config.Collector.Enabled {
		t.Fatalf("saved enable or root CPA publication did not read back true: %+v %v", after, err)
	}
	t.Log("pure global false-to-true restored root CPA usage publication from false to true without validation probes")
	// Changing collection parameters still validates retention and enables CPA publication.
	readsBeforeEdit := validations.Load()
	if _, err := svc.Update(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{BatchSize: 101}}); err != nil {
		t.Fatal(err)
	}
	if validations.Load() <= readsBeforeEdit || usageEnable.Load() != 2 {
		t.Fatal("real collector edit skipped original CPA validation/publication")
	}
	if _, err := svc.Update(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{PollIntervalMS: 61000}}); err == nil {
		t.Fatal("invalid collection interval accepted")
	}
	current, _, _, _ := svc.ResolveManagerConfigWithSource(ctx)
	if current.Collector.PollIntervalMS != 500 {
		t.Fatal("invalid collector parameters persisted")
	}
	if _, err := svc.Update(ctx, model.ManagerConfig{CPAConnection: model.ManagerCPAConnectionConfig{CPABaseURL: "http://127.0.0.1:1"}}); err == nil {
		t.Fatal("unverified replacement binding accepted")
	}
	// A standalone pre-cluster single-instance service retains its old validation.
	legacy := New(cfg, db, collector.NewManager(cfg, db))
	defer legacy.appCtx.CollectorService.Stop(context.Background())
	readsBeforeStop := validations.Load()
	if _, err := legacy.appCtx.ManagerConfigService.Update(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{Enabled: managerconfig.BoolPtr(false)}}); err != nil {
		t.Fatal(err)
	}
	if validations.Load() <= readsBeforeStop {
		t.Fatal("legacy single-instance validation was removed")
	}
}

func TestGlobalMonitoringRootPublicationDoesNotBlockInstances(t *testing.T) {
	for _, publicationStatus := range []int{http.StatusOK, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(publicationStatus), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			publicationStarted, publicationFinished := make(chan struct{}), make(chan struct{})
			rootConfigRead := make(chan struct{}, 4)
			releasePublication := make(chan struct{})
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(releasePublication) }) }
			var rootConfigReads atomic.Int32
			var usagePublished atomic.Bool
			rootCPA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v0/management/config":
					rootConfigReads.Add(1)
					fmt.Fprintf(w, `{"usage-statistics-enabled":%t,"redis-usage-queue-retention-seconds":60}`, usagePublished.Load())
					rootConfigRead <- struct{}{}
				case "/v0/management/usage-statistics-enabled":
					defer close(publicationFinished)
					close(publicationStarted)
					select {
					case <-releasePublication:
						usagePublished.Store(publicationStatus == http.StatusOK)
						w.WriteHeader(publicationStatus)
						fmt.Fprint(w, `{"status":"completed"}`)
					case <-r.Context().Done():
					}
				case "/v0/management/usage-queue":
					<-r.Context().Done()
				default:
					fmt.Fprint(w, `{}`)
				}
			}))
			defer rootCPA.Close()
			defer release()
			childStarted, childStopped := make(chan struct{}, 2), make(chan struct{}, 2)
			childCPA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v0/management/config":
					fmt.Fprint(w, `{"usage-statistics-enabled":true,"redis-usage-queue-retention-seconds":60}`)
				case "/v0/management/usage-queue":
					childStarted <- struct{}{}
					<-r.Context().Done()
					childStopped <- struct{}{}
				default:
					fmt.Fprint(w, `{"status":"ok"}`)
				}
			}))
			defer childCPA.Close()
			cfg := testutil.NewConfig(t)
			cfg.CollectorMode = "http"
			db := testutil.NewStore(t, cfg)
			initial := model.ManagerConfig{
				CPAConnection: model.ManagerCPAConnectionConfig{CPABaseURL: rootCPA.URL, ManagementKey: "root-key"},
				Collector:     model.ManagerCollectorConfig{Enabled: managerconfig.BoolPtr(false), CollectorMode: "http", PollIntervalMS: 500, BatchSize: 100},
			}
			if err := db.SaveManagerConfig(ctx, initial); err != nil {
				t.Fatal(err)
			}
			root := New(cfg, db, collector.NewManager(cfg, db))
			protector, _ := security.NewProtector(make([]byte, 32))
			cluster := root.EnableCluster(protector)
			cluster.Start(ctx)
			defer cluster.Close(context.Background())
			defer root.appCtx.CollectorService.Stop(context.Background())
			id, err := cluster.Save(ctx, "", clustersvc.Input{Name: "child", BaseURL: childCPA.URL, ManagementKey: "child-key", Enabled: true})
			if err != nil {
				t.Fatal(err)
			}
			runtime, err := cluster.Runtime(id)
			if err != nil {
				t.Fatal(err)
			}
			child := runtime.(*instanceRuntime)
			finishMonitoringStartup(t, ctx, child)
			// Creating an instance lists existing entries and schedules the old
			// root health probe. Fence it before measuring global-control traffic.
			monitoringSignal(t, ctx, rootConfigRead)
			configReadsBeforeEnable := rootConfigReads.Load()
			saved := make(chan error, 1)
			go func() {
				_, err := root.appCtx.ManagerConfigService.Update(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{Enabled: managerconfig.BoolPtr(true)}})
				saved <- err
			}()
			monitoringSignal(t, ctx, publicationStarted)
			// Keep root publication blocked while verifying save and child consumption.
			select {
			case err := <-saved:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("root publication blocked global save")
			}
			monitoringSignal(t, ctx, childStarted)
			persisted, _, err := db.LoadManagerConfig(ctx)
			childStatus := child.server.appCtx.CollectorService.Status()
			if err != nil || !managerconfig.ManagerCollectorEnabled(persisted) || childStatus.Collector != "running" || rootConfigReads.Load() != configReadsBeforeEnable {
				t.Fatalf("root publication blocked independent child: config=%+v child=%+v rootConfigReads=%d err=%v", persisted.Collector, childStatus, rootConfigReads.Load(), err)
			}
			release()
			monitoringSignal(t, ctx, publicationFinished)
			if usagePublished.Load() != (publicationStatus == http.StatusOK) {
				t.Fatal("root publication result did not match the CPA response")
			}
			if _, err := root.appCtx.ManagerConfigService.Update(ctx, model.ManagerConfig{Collector: model.ManagerCollectorConfig{Enabled: managerconfig.BoolPtr(false)}}); err != nil {
				t.Fatal(err)
			}
			monitoringSignal(t, ctx, childStopped)
			t.Logf("global save and child queue consumption completed while root publication was blocked; root returned HTTP %d", publicationStatus)
		})
	}
}
