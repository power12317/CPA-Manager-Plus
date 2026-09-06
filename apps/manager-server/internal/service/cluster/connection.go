package cluster

import (
	"context"
	"errors"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpaauthfiles"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
)

// PrepareConnection performs network validation without holding the runtime's
// lifecycle lock. Registry reads and other instances remain available while a
// remote CPA is slow or offline.
func PrepareConnection(ctx context.Context, settings *managerconfig.Service, connection model.ManagerCPAConnectionConfig) (model.ManagerConfig, error) {
	cfg, source, found, err := settings.ResolveManagerConfigWithSource(ctx)
	if err != nil {
		return cfg, err
	}
	if source == managerconfig.SourceEnv && cfg.CPAConnection != connection {
		return cfg, errors.New("connection is managed by environment")
	}
	if err := cpa.ValidateManagementAPI(ctx, connection.CPABaseURL, connection.ManagementKey); err != nil {
		return cfg, err
	}
	cfg.CPAConnection = connection
	if !found {
		enabled := true
		cfg.Collector = model.ManagerCollectorConfig{Enabled: &enabled, CollectorMode: "auto", Queue: "usage", PopSide: "right", BatchSize: 100, PollIntervalMS: 500}
		cfg.CodexInspection = model.DefaultCodexInspectionConfig()
	}
	if managerconfig.ManagerCollectorEnabled(cfg) {
		if err := cpa.ValidateCollectorConfig(ctx, connection.CPABaseURL, connection.ManagementKey, cfg.Collector.PollIntervalMS); err != nil {
			return cfg, err
		}
		if err := cpa.SetUsageStatisticsEnabled(ctx, connection.CPABaseURL, connection.ManagementKey, true); err != nil {
			return cfg, err
		}
	}
	return cfg, nil
}

func FetchCredentials(ctx context.Context, connection model.ManagerCPAConnectionConfig) ([]map[string]any, error) {
	files, err := cpaauthfiles.New(nil).Fetch(ctx, connection.CPABaseURL, connection.ManagementKey)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(files))
	for _, file := range files {
		// Metadata only: credential contents and tokens never enter aggregate responses.
		item := map[string]any{"name": file.Name, "id": file.ID, "provider": file.Provider, "authIndex": file.AuthIndex, "disabled": file.Disabled}
		for _, key := range []string{"type", "email", "account", "label", "note", "priority", "weight", "prefix", "account_id", "status", "status_message", "unavailable", "runtime_only", "size", "modified", "created_at", "updated_at", "last_refresh", "project_id", "plan_type", "codex_member", "provider_scope", "runtime_id"} {
			if value, ok := file.Raw[key]; ok {
				item[key] = value
			}
		}
		result = append(result, item)
	}
	return result, nil
}
