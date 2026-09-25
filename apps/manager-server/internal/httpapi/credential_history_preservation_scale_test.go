//go:build !race

package httpapi

import "testing"

func TestMacBaseline100KDoesNotRebuildOldData(t *testing.T) {
	verifyMacBaselinePreservedWithoutRebuild(t, 100_000)
}

func TestDevinAccounting100KPreservesCodexBaselineAndListener(t *testing.T) {
	verifyMacBaselinePreservedWithoutRebuild(t, 100_000, true)
}
