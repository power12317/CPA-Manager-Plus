package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	clustercontroller "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/controller/cluster"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/processlock"
	sqliterepo "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/repository/sqlite"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/dashboard"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	monitoringsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/worker"
)

// EnableCluster adds the control plane without altering the legacy instance.
// Call Start on the returned service only once the HTTP listener is serving.
func (s *Server) EnableCluster(protector *security.Protector) *clustersvc.Service {
	legacy := &instanceRuntime{server: s, handler: s.handler, legacy: true}
	factory := func(ctx context.Context, id string) (clustersvc.Runtime, error) {
		cfg := s.appCtx.Config
		cfg.DataDir = filepath.Join(filepath.Dir(cfg.DBPath), "instances", id)
		cfg.DBPath = filepath.Join(cfg.DataDir, "usage.sqlite")
		// Archive jobs and manifests belong to the same instance as its database.
		cfg.UsageArchiveDir = filepath.Join(cfg.DataDir, "usage-archives")
		cfg.CPAUpstreamURL = ""
		cfg.ManagementKey = ""
		lock, err := processlock.Acquire(cfg.DBPath)
		if err != nil {
			return nil, err
		}
		db, err := store.Open(lock.DatabasePath(), protector)
		if err != nil {
			_ = lock.Close()
			return nil, err
		}
		fail := func(err error) (clustersvc.Runtime, error) { _ = db.Close(); _ = lock.Close(); return nil, err }
		credential, ok, err := s.appCtx.Store.LoadAdminCredential(ctx)
		if err != nil {
			return fail(err)
		}
		if ok {
			if err := db.SaveAdminCredential(ctx, credential); err != nil {
				return fail(err)
			}
		}
		manager := collector.NewManager(cfg, db)
		child := New(cfg, db, manager)
		// Authenticate every request against the central credential, including
		// after an administrator rotates it. Never accept a CPA key here.
		child.appCtx.AdminAuthService = s.appCtx.AdminAuthService
		return &instanceRuntime{server: child, handler: child.handler, closeLock: lock.Close}, nil
	}
	service := clustersvc.New(s.appCtx.Store.Settings, factory, legacy)
	s.handler = &clustercontroller.Handler{Service: service, Auth: s.appCtx.AdminAuthService, Next: s.handler}
	return service
}

type instanceRuntime struct {
	server     *Server
	handler    http.Handler
	legacy     bool
	closeLock  func() error
	mu         sync.RWMutex
	cancel     context.CancelFunc
	runCtx     context.Context
	startup    sync.WaitGroup
	inspection *worker.CodexInspectionWorker
	wal        *sqliterepo.WALMaintenance
	retention  *worker.UsageArchiveRetentionWorker
	migration  *worker.UsageCacheAccountingMigrationWorker
}

func (r *instanceRuntime) Connection(ctx context.Context) (model.ManagerCPAConnectionConfig, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.connection(ctx)
}

func (r *instanceRuntime) connection(ctx context.Context) (model.ManagerCPAConnectionConfig, error) {
	cfg, _, _, err := r.server.appCtx.ManagerConfigService.ResolveManagerConfigWithSource(ctx)
	return cfg.CPAConnection, err
}

func (r *instanceRuntime) Configure(ctx context.Context, connection model.ManagerCPAConnectionConfig) error {
	r.mu.RLock()
	app := r.server.appCtx
	r.mu.RUnlock()
	cfg, err := clustersvc.PrepareConnection(ctx, app.ManagerConfigService, connection)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := app.Store.SaveManagerConfigAndSetup(ctx, cfg, managerconfig.SetupFromManagerConfig(cfg)); err != nil {
		return err
	}
	if r.cancel != nil || r.legacy {
		if managerconfig.ManagerCollectorEnabled(cfg) {
			runCtx := r.runCtx
			if runCtx == nil {
				runCtx = context.Background()
			}
			return app.CollectorService.Start(runCtx, cfg)
		}
		return app.CollectorService.Stop(ctx)
	}
	return nil
}

func (r *instanceRuntime) ClearConnection(ctx context.Context) error {
	if !r.legacy {
		return nil
	}
	r.mu.RLock()
	app := r.server.appCtx
	r.mu.RUnlock()
	cfg, _, _, err := app.ManagerConfigService.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		return err
	}
	cfg.CPAConnection = model.ManagerCPAConnectionConfig{}
	enabled := false
	cfg.Collector.Enabled = &enabled
	_, err = app.ManagerConfigService.Update(ctx, cfg)
	return err
}

func (r *instanceRuntime) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if !clustercontroller.GuardConnectionUpdate(w, req, r.connection) {
		return
	}
	r.handler.ServeHTTP(w, req)
}

func (r *instanceRuntime) Credentials(ctx context.Context) ([]map[string]any, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	connection, err := r.connection(ctx)
	if err != nil {
		return nil, err
	}
	return clustersvc.FetchCredentials(ctx, connection)
}

func (r *instanceRuntime) Online(ctx context.Context) bool {
	connection, err := r.Connection(ctx)
	return err == nil && connection.CPABaseURL != "" && cpa.ValidateManagementAPI(ctx, connection.CPABaseURL, connection.ManagementKey) == nil
}

func (r *instanceRuntime) Summary(ctx context.Context, params dashboard.SummaryParams) (dashboard.SummaryResponse, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.server.appCtx.DashboardService.Summary(ctx, params)
}

func (r *instanceRuntime) FederationHints(ctx context.Context, req *http.Request, body []byte) (any, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var input monitoringsvc.Request
	if strings.HasSuffix(req.URL.Path, "/dashboard/summary") {
		input.FromMS, _ = strconv.ParseInt(req.URL.Query().Get("today_start_ms"), 10, 64)
		input.ToMS, _ = strconv.ParseInt(req.URL.Query().Get("now_ms"), 10, 64)
	} else {
		if err := json.Unmarshal(body, &input); err != nil {
			return nil, err
		}
	}
	if input.ToMS <= 0 {
		input.ToMS = time.Now().UnixMilli()
	}
	return r.server.appCtx.MonitoringService.FederationSamples(ctx, input)
}

func (r *instanceRuntime) Start(parent context.Context) {
	if r.legacy {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		return
	}
	if r.inspection != nil {
		previous := r.server.appCtx
		manager := collector.NewManager(previous.Config, previous.Store)
		r.server = New(previous.Config, previous.Store, manager)
		r.server.appCtx.AdminAuthService = previous.AdminAuthService
		r.handler = r.server.handler
	}
	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel
	r.runCtx = ctx
	app := r.server.appCtx
	if wal, err := sqliterepo.NewWALMaintenance(app.Config.DBPath); err != nil {
		log.Printf("[instance] configure WAL maintenance: %v", err)
	} else {
		r.wal = wal
		app.DatabaseMaintenance = wal
		wal.Start(ctx)
	}
	settings := app.AccountProcessingPolicyService.RuntimeSettings(ctx)
	quota := worker.NewRateLimitAutoDisableWorkerWithMutationCoordinator(app.Store, app.AuthFileMutationCoordinator, collector.RuntimeConfig{})
	actions := worker.NewAccountActionCandidateWorkerWithMutationCoordinator(app.Store, app.AuthFileMutationCoordinator, settings.AccountActionsAutoDisable)
	automation := worker.NewAutomationRuntime(app.AccountProcessingPolicyService, app.Collector, quota, actions)
	app.AutomationRuntimeService = automation
	history := worker.NewAccountHistoryRollupWorker(app.Store)
	pricing := worker.NewUsagePricingRollupWorker(app.Store)
	var hourly *worker.UsageHourlyAggregateWorker
	if app.Config.DashboardHourlyRollupEnabled {
		hourly = worker.NewUsageHourlyAggregateWorker(app.Store)
	}
	r.retention = nil
	if app.Config.UsageArchiveRetentionEnabled && app.Config.UsageArchiveRetentionDays > 0 && app.Config.DashboardHourlyRollupEnabled {
		r.retention = worker.NewUsageArchiveRetentionWorker(app.UsageService, app.Config.UsageArchiveRetentionDays)
	}
	retention := r.retention
	r.migration = nil
	app.ModelPriceService.SetPricesChangedNotifier(pricing.Wake)
	app.UsageService.SetEventsInsertedNotifier(func() {
		history.Wake()
		pricing.Wake()
		if hourly != nil {
			hourly.Wake()
		}
	})
	r.inspection = worker.NewCodexInspectionWorker(app.Store, app.CodexInspectionService)
	inspection := r.inspection
	r.startup.Add(1)
	go func() {
		defer r.startup.Done()
		log.Printf("[instance] starting workers database=%s", app.Config.DBPath)
		if err := app.UsageService.StartArchiveJobs(ctx); err != nil && ctx.Err() == nil {
			log.Printf("[instance] start archive jobs: %v", err)
		}
		if err := app.Store.RunDerivedStartupMaintenance(ctx); err != nil && ctx.Err() == nil {
			log.Printf("[instance] derived startup maintenance: %v", err)
		}
		if ctx.Err() != nil {
			return
		}
		if err := app.CodexInspectionService.Recover(ctx); err != nil {
			log.Printf("[instance] recover inspection: %v", err)
		}
		if err := app.UsageService.StartImportSessionCleanup(ctx); err != nil {
			log.Printf("[instance] import cleanup: %v", err)
		}
		automation.Start(ctx)
		app.Collector.SetUsageEventHandler(worker.NewUsageEventFanout(automation.UsageEventHandler(), history, pricing, hourly))
		inspection.Start(ctx)
		history.Start(ctx)
		pricing.Start(ctx)
		if hourly != nil {
			hourly.Start(ctx)
		}
		app.Store.StartDerivedMaintenance(ctx)
		worker.NewCollectorWorker(app.Config, app.Store, app.CollectorService).Start(ctx)
		worker.NewLegacyQuotaSnapshotMigrationWorker(app.Store).Start(ctx)
		r.migration = worker.NewUsageCacheAccountingMigrationWorker(app.Store, func() {
			history.Wake()
			pricing.Wake()
			if hourly != nil {
				hourly.Wake()
			}
			if err := worker.WaitForUsageResponseMetadataBackfill(ctx, app.Store); err != nil {
				if ctx.Err() == nil {
					log.Printf("[instance] usage response metadata backfill: %v", err)
				}
				return
			}
			retention.Start(ctx)
		})
		r.migration.Start(ctx)
	}()
}

func (r *instanceRuntime) Stop(ctx context.Context) error {
	if r.legacy {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel == nil {
		return nil
	}
	r.cancel()
	done := make(chan struct{})
	go func() { r.startup.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	}
	if r.inspection != nil {
		if err := r.inspection.StopAndWait(ctx); err != nil {
			return err
		}
	}
	if err := r.migration.StopAndWait(ctx); err != nil {
		return err
	}
	if err := r.retention.StopAndWait(ctx); err != nil {
		return err
	}
	if err := r.server.appCtx.UsageService.WaitArchiveJobs(ctx); err != nil {
		return err
	}
	if err := r.server.appCtx.CollectorService.Stop(ctx); err != nil {
		return err
	}
	if err := r.server.appCtx.Collector.StopAndWait(ctx); err != nil {
		return err
	}
	if r.wal != nil {
		if err := r.wal.Close(); err != nil {
			return err
		}
		r.wal = nil
	}
	r.cancel = nil
	r.runCtx = nil
	return nil
}

func (r *instanceRuntime) Close() error {
	if r.legacy {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := r.Stop(ctx); err != nil {
		return err
	}
	err := r.server.appCtx.Store.Close()
	if r.closeLock != nil {
		return errors.Join(err, r.closeLock())
	}
	return err
}

func (r *instanceRuntime) DeleteData() error {
	if r.legacy {
		return nil
	}
	return os.RemoveAll(filepath.Dir(r.server.appCtx.Config.DBPath))
}
