package worker

import (
	"context"
	"errors"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"log"
	"time"
)

const usageResponseMetadataBackfillRetryDelay = 5 * time.Second

func WaitForUsageResponseMetadataBackfill(ctx context.Context, db *store.Store) error {
	return WaitForBackfillReadiness(ctx, usageResponseMetadataBackfillRetryDelay, func(runCtx context.Context) error {
		return RunUsageResponseMetadataBackfill(runCtx, db)
	})
}

func WaitForBackfillReadiness(ctx context.Context, retryDelay time.Duration, run func(context.Context) error) error {
	if run == nil {
		return errors.New("usage response metadata backfill is not configured")
	}
	if retryDelay <= 0 {
		retryDelay = time.Second
	}
	for {
		err := run(ctx)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("usage response metadata backfill failed; will retry: %v", err)
		timer := time.NewTimer(retryDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func RunUsageResponseMetadataBackfill(ctx context.Context, db *store.Store) error {
	const batchLimit = 1000
	total := 0
	for {
		updated, err := db.BackfillUsageResponseMetadata(ctx, batchLimit)
		if err != nil {
			return err
		}
		if updated == 0 {
			if total > 0 {
				log.Printf("usage response metadata backfill completed: updated=%d", total)
			}
			return nil
		}
		total += updated
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
