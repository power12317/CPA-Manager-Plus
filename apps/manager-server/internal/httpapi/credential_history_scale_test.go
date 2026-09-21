//go:build !race

package httpapi

import "testing"

func TestCredentialHistoryUpgrade100KServesBeforeRebuildAndResumes(t *testing.T) {
	verifyCredentialHistoryUpgradeServesBeforeRebuildAndResumes(t, 100_000)
}
