package collector

import (
	"context"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/resp"
)

func TestOailbNodeThroughRESPQueue(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		const command = "*3\r\n$4\r\nRPOP\r\n$5\r\nusage\r\n$1\r\n1\r\n"
		data := make([]byte, len(command))
		if _, err = io.ReadFull(conn, data); err != nil {
			done <- err
			return
		}
		if string(data) != command {
			done <- fmt.Errorf("unexpected command %q", data)
			return
		}
		const payload = `{"timestamp":"2026-09-26T12:00:00Z","model":"gpt-test","oailb_node":"unified-96","total_tokens":3}`
		_, err = fmt.Fprintf(conn, "*1\r\n$%d\r\n%s\r\n", len(payload), payload)
		done <- err
	}()
	client, err := resp.Dial("http://"+listener.Addr().String(), false)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	db := newTestStore(t)
	manager := NewManager(testConfig(t, "resp"), db)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The mock closes after one batch. The collector processes it before EOF.
	_ = manager.consumeRESP(ctx, RuntimeConfig{BatchSize: 1}, client, "usage", "right")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	events, err := db.RecentEvents(ctx, 10)
	if err != nil || len(events) != 1 || events[0].OailbNode != "unified-96" {
		t.Fatalf("RESP node lost: %+v %v", events, err)
	}
}
