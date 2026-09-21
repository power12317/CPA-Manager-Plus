//go:build !race

package httpapi

import "testing"

func TestCompletedCodexRecoveryIndexRepair100K(t *testing.T) {
	verifyCompletedCodexRecoveryIndexRepair(t, 100_000)
}
