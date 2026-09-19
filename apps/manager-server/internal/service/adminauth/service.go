package adminauth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/security"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type Service struct {
	cfg   config.Config
	store *store.Store
}

func New(cfg config.Config, store *store.Store) *Service {
	return &Service{cfg: cfg, store: store}
}

func (s *Service) VerifyHeader(ctx context.Context, authorizationHeader string) (bool, error) {
	credential, ok, err := s.store.LoadAdminCredential(ctx)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, errors.New("admin credential is not initialized")
	}
	return security.VerifyAdminKey(credential, security.ExtractBearerToken(authorizationHeader)), nil
}

func (s *Service) VerifyPanelHeader(ctx context.Context, authorizationHeader string) (bool, error) {
	return s.VerifyHeader(ctx, authorizationHeader)
}

func (s *Service) VerifySubmittedExternalConfigHeader(ctx context.Context, authorizationHeader string, cfg store.ManagerConfig) (bool, error) {
	return s.VerifyHeader(ctx, authorizationHeader)
}

func (s *Service) PanelUsesExternalManagementKey(ctx context.Context) (bool, error) {
	return false, nil
}

// ChangeAdminKey verifies the current credential before replacing it. The new
// value intentionally has no strength policy: deployments may use their own
// password policy, including short test-only values.
func (s *Service) ChangeAdminKey(ctx context.Context, currentKey, newKey string) error {
	currentKey = strings.TrimSpace(currentKey)
	newKey = strings.TrimSpace(newKey)
	if currentKey == "" {
		return errors.New("current admin key is required")
	}
	if newKey == "" {
		return errors.New("new admin key is required")
	}
	credential, ok, err := s.store.LoadAdminCredential(ctx)
	if err != nil {
		return err
	}
	if !ok || !security.VerifyAdminKey(credential, currentKey) {
		return errors.New("invalid admin key")
	}
	next, err := security.NewAdminCredential(newKey, "panel")
	if err != nil {
		return err
	}
	next.CreatedAtMS = credential.CreatedAtMS
	next.RotatedAtMS = time.Now().UnixMilli()
	return s.store.SaveAdminCredential(ctx, next)
}
