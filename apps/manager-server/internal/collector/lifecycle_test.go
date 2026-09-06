package collector

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStopWaitsForQueueConsumerBeforeDatabaseCanClose(t *testing.T) {
	runCtx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	m := &Manager{cancel: cancel, done: done}
	waitCtx, stop := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer stop()
	if err := m.StopAndWait(waitCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("returned before consumer completed: %v", err)
	}
	if runCtx.Err() == nil {
		t.Fatal("consumer was not cancelled")
	}
	close(done)
	if err := m.StopAndWait(context.Background()); err != nil {
		t.Fatal(err)
	}
}
