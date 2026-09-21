//go:build !race

package httpapi

import "testing"

func TestRejectedCodexIdentityRecovery100K(t *testing.T) {
	verifyRejectedCodexRecovery(t, 100_000, 50_000)
}
