//go:build race

package httpapi

import "testing"

func TestCredentialHistoryUpgradeServesBeforeRebuildAndResumesUnderRace(t *testing.T) {
	// Exercise the same migration, real listener, interruption and restart with
	// multiple batches. The normal suite covers 100k rows; race-instrumenting
	// SQLite's VM makes full-table fallback scans unsuitable for timing tests.
	verifyCredentialHistoryUpgradeServesBeforeRebuildAndResumes(t, 2_000)
}
