package setting

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"time"
)

func (r *repository) LoadInstances(ctx context.Context) ([]model.Instance, error) {
	var raw string
	err := r.db.QueryRowContext(ctx, `select value from settings where key = 'instances_v1'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return []model.Instance{}, nil
	}
	if err != nil {
		return nil, err
	}
	var instances []model.Instance
	err = json.Unmarshal([]byte(raw), &instances)
	return instances, err
}

func (r *repository) SaveInstances(ctx context.Context, instances []model.Instance) error {
	raw, err := json.Marshal(instances)
	if err != nil {
		return err
	}
	return upsertSetting(ctx, r.db, "instances_v1", raw, time.Now().UnixMilli())
}
