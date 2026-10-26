package collector

import (
	"context"
	"errors"
	"sync"

	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
)

type pendingRuntime struct {
	ctx context.Context
	cfg collectorpkg.RuntimeConfig
}

// Control is an in-memory admission boundary shared by all instance collectors.
// Its value comes from the root's existing collector.enabled setting. Pending
// runtimes preserve instance configuration while global collection is disabled.
type Control struct {
	mu      sync.Mutex
	enabled bool
	pending map[*Service]pendingRuntime
}

func NewControl(enabled bool) *Control {
	return &Control{enabled: enabled, pending: make(map[*Service]pendingRuntime)}
}

func (c *Control) SetEnabled(ctx context.Context, enabled bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if enabled && c.enabled {
		return nil
	}
	c.enabled = enabled
	if enabled {
		for service, runtime := range c.pending {
			if runtime.ctx.Err() == nil {
				service.manager.Start(runtime.ctx, runtime.cfg)
			}
		}
		return nil
	}
	// Cancel all consumers before waiting for any one transport to finish.
	for service := range c.pending {
		service.manager.Stop()
	}
	var result error
	for service := range c.pending {
		result = errors.Join(result, service.stopAndWait(ctx))
	}
	return result
}

// UseControl is called before publishing a newly constructed instance runtime.
func (s *Service) UseControl(control *Control) { s.control = control }
