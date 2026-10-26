package collector

import (
	"context"
	"time"

	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type Service struct {
	manager *collectorpkg.Manager
	control *Control
}

func New(manager *collectorpkg.Manager) *Service {
	return &Service{manager: manager}
}

func (s *Service) Start(ctx context.Context, cfg store.ManagerConfig) error {
	return s.StartRuntime(ctx, RuntimeConfigFromManagerConfig(cfg))
}

func (s *Service) StartRuntime(ctx context.Context, cfg collectorpkg.RuntimeConfig) error {
	if s.control != nil {
		s.control.mu.Lock()
		defer s.control.mu.Unlock()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.control.pending[s] = pendingRuntime{ctx: ctx, cfg: cfg}
		if !s.control.enabled {
			return nil
		}
	}
	s.manager.Start(ctx, cfg)
	return nil
}

func (s *Service) Stop(ctx context.Context) error {
	if s.control != nil {
		s.control.mu.Lock()
		defer s.control.mu.Unlock()
		delete(s.control.pending, s)
	}
	return s.stopAndWait(ctx)
}

func (s *Service) stopAndWait(ctx context.Context) error {
	if err := s.manager.StopAndWait(ctx); err != nil {
		return err
	}
	// A transport may publish its final startup status concurrently with the
	// cancellation. Set stopped again after its goroutine has fully exited.
	s.manager.Stop()
	return nil
}

func (s *Service) Restart(ctx context.Context, cfg store.ManagerConfig) error {
	if err := s.Stop(ctx); err != nil {
		return err
	}
	return s.Start(ctx, cfg)
}

func (s *Service) Status() collectorpkg.Status {
	return s.manager.Status()
}

func RuntimeConfigFromManagerConfig(cfg store.ManagerConfig) collectorpkg.RuntimeConfig {
	return collectorpkg.RuntimeConfig{
		CPAUpstreamURL: cfg.CPAConnection.CPABaseURL,
		ManagementKey:  cfg.CPAConnection.ManagementKey,
		CollectorMode:  cfg.Collector.CollectorMode,
		Queue:          cfg.Collector.Queue,
		PopSide:        cfg.Collector.PopSide,
		BatchSize:      cfg.Collector.BatchSize,
		PollInterval:   time.Duration(cfg.Collector.PollIntervalMS) * time.Millisecond,
		TLSSkipVerify:  cfg.Collector.TLSSkipVerify,
	}
}

func RuntimeConfigFromManagerConfigWithFallback(managerCfg store.ManagerConfig, base config.Config) collectorpkg.RuntimeConfig {
	pollInterval := time.Duration(managerCfg.Collector.PollIntervalMS) * time.Millisecond
	if pollInterval <= 0 {
		pollInterval = base.PollInterval
	}
	batchSize := managerCfg.Collector.BatchSize
	if batchSize <= 0 {
		batchSize = base.BatchSize
	}
	return collectorpkg.RuntimeConfig{
		CPAUpstreamURL: managerCfg.CPAConnection.CPABaseURL,
		ManagementKey:  managerCfg.CPAConnection.ManagementKey,
		CollectorMode:  valueOr(managerCfg.Collector.CollectorMode, base.CollectorMode),
		Queue:          valueOr(managerCfg.Collector.Queue, base.Queue),
		PopSide:        valueOr(managerCfg.Collector.PopSide, base.PopSide),
		BatchSize:      batchSize,
		PollInterval:   pollInterval,
		TLSSkipVerify:  managerCfg.Collector.TLSSkipVerify,
	}
}

func ManagerCollectorEnabled(managerCfg store.ManagerConfig) bool {
	return managerCfg.Collector.Enabled == nil || *managerCfg.Collector.Enabled
}

func valueOr(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
