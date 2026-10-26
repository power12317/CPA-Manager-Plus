package collector

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
)

func receive[T any](t *testing.T, ctx context.Context, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		var zero T
		return zero
	}
}

func controlledService(control *Control) *Service {
	s := New(collectorpkg.NewManager(config.Config{CollectorMode: "http", Queue: "usage"}, nil))
	s.UseControl(control)
	return s
}

func TestGlobalControlCancelsHTTPAndPreservesEligibleRuntimes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := make(chan struct{}, 10)
	ended := make(chan struct{}, 10)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/usage-queue" {
			http.NotFound(w, r)
			return
		}
		started <- struct{}{}
		<-r.Context().Done()
		ended <- struct{}{}
	}))
	defer upstream.Close()
	control := NewControl(true)
	a, b := controlledService(control), controlledService(control)
	defer a.Stop(ctx)
	defer b.Stop(ctx)
	cfg := collectorpkg.RuntimeConfig{CPAUpstreamURL: upstream.URL, ManagementKey: "test", CollectorMode: "http", BatchSize: 100, PollInterval: time.Hour}
	for _, s := range []*Service{a, b} {
		if err := s.StartRuntime(ctx, cfg); err != nil {
			t.Fatal(err)
		}
		receive(t, ctx, started)
	}
	if err := control.SetEnabled(ctx, false); err != nil {
		t.Fatal(err)
	}
	receive(t, ctx, ended)
	receive(t, ctx, ended)
	for _, s := range []*Service{a, b} {
		if s.Status().Collector != "stopped" {
			t.Fatal("global stop returned with an active consumer")
		}
	}
	// A reconnect or a newly admitted runtime cannot start while disabled.
	if err := a.StartRuntime(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	c := controlledService(control)
	defer c.Stop(ctx)
	if err := c.StartRuntime(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if a.Status().Collector != "stopped" || c.Status().Collector != "stopped" {
		t.Fatal("start bypassed global false")
	}
	// An instance explicitly stopped during the global pause must stay stopped.
	if err := b.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := control.SetEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	receive(t, ctx, started)
	receive(t, ctx, started)
	if b.Status().Collector != "stopped" {
		t.Fatal("global enable overrode local stop")
	}
	if len(control.pending) != 2 {
		t.Fatalf("pending=%d", len(control.pending))
	}
	if err := control.SetEnabled(ctx, false); err != nil {
		t.Fatal(err)
	}
	receive(t, ctx, ended)
	receive(t, ctx, ended)
}

func readCommand(reader *bufio.Reader) ([]string, error) {
	header, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	count, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(header, "*")))
	if err != nil {
		return nil, err
	}
	values := make([]string, count)
	for i := range values {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		size, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "$")))
		if err != nil {
			return nil, err
		}
		value := make([]byte, size+2)
		if _, err := io.ReadFull(reader, value); err != nil {
			return nil, err
		}
		values[i] = string(value[:size])
	}
	return values, nil
}

func TestGlobalControlCancelsRESPSubscriptionAndSkipsCancelledStarts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	subscribed, disconnected := make(chan error, 1), make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			subscribed <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		reader := bufio.NewReader(conn)
		cmd, err := readCommand(reader)
		if err != nil || len(cmd) < 1 || cmd[0] != "AUTH" {
			subscribed <- fmt.Errorf("auth=%v: %v", cmd, err)
			return
		}
		_, _ = io.WriteString(conn, "+OK\r\n")
		cmd, err = readCommand(reader)
		if err != nil || len(cmd) < 1 || cmd[0] != "SUBSCRIBE" {
			subscribed <- fmt.Errorf("subscribe=%v: %v", cmd, err)
			return
		}
		_, err = io.WriteString(conn, "*3\r\n$9\r\nsubscribe\r\n$5\r\nusage\r\n:1\r\n")
		subscribed <- err
		_, err = reader.ReadByte()
		disconnected <- err
	}()
	control := NewControl(true)
	s := controlledService(control)
	defer s.Stop(ctx)
	cfg := collectorpkg.RuntimeConfig{CPAUpstreamURL: "http://" + listener.Addr().String(), ManagementKey: "test", CollectorMode: "subscribe", Queue: "usage"}
	if err := s.StartRuntime(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if err := receive(t, ctx, subscribed); err != nil {
		t.Fatal(err)
	}
	if err := control.SetEnabled(ctx, false); err != nil {
		t.Fatal(err)
	}
	if err := receive(t, ctx, disconnected); !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
		t.Fatalf("subscription not closed: %v", err)
	}
	cancelled, stop := context.WithCancel(ctx)
	if err := s.StartRuntime(cancelled, cfg); err != nil {
		t.Fatal(err)
	}
	stop()
	if err := control.SetEnabled(ctx, true); err != nil {
		t.Fatal(err)
	}
	if s.Status().Collector != "stopped" {
		t.Fatal("restarted an expired instance context")
	}
}

func TestGlobalControlCancelsRESPInitialization(t *testing.T) {
	for _, phase := range []string{"tls handshake", "auth", "subscribe"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			blocked, closed := make(chan error, 1), make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					blocked <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				reader := bufio.NewReader(conn)
				if phase == "tls handshake" {
					// Receive the ClientHello without replying; cancellation must
					// interrupt the handshake before the dialer's normal timeout.
					header := make([]byte, 5)
					_, err = io.ReadFull(reader, header)
					if err == nil {
						_, err = io.CopyN(io.Discard, reader, int64(header[3])<<8|int64(header[4]))
					}
				} else {
					_, err = readCommand(reader)
					if phase == "subscribe" && err == nil {
						_, err = io.WriteString(conn, "+OK\r\n")
						if err == nil {
							_, err = readCommand(reader)
						}
					}
				}
				blocked <- err
				_, err = reader.ReadByte()
				closed <- err
			}()
			control := NewControl(true)
			service := controlledService(control)
			defer service.Stop(ctx)
			scheme := "http://"
			if phase == "tls handshake" {
				scheme = "https://"
			}
			if err := service.StartRuntime(ctx, collectorpkg.RuntimeConfig{
				CPAUpstreamURL: scheme + listener.Addr().String(), ManagementKey: "test", CollectorMode: "auto", Queue: "usage",
			}); err != nil {
				t.Fatal(err)
			}
			if err := receive(t, ctx, blocked); err != nil {
				t.Fatal(err)
			}
			if err := control.SetEnabled(ctx, false); err != nil {
				t.Fatal(err)
			}
			if err := receive(t, ctx, closed); !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
				t.Fatalf("initialization socket remained open: %v", err)
			}
			if service.Status().Collector != "stopped" {
				t.Fatal("initialization bypassed global stop")
			}
		})
	}
}
