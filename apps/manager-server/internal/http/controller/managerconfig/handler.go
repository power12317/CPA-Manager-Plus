package managerconfig

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

type Handler struct {
	App *app.Context
}

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if !h.authorizeRead(w, r) {
			return
		}
		result, err := h.App.ManagerConfigService.Get(r.Context())
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err)
			return
		}
		response.JSON(w, http.StatusOK, result)
	case http.MethodPut:
		var req struct {
			Config store.ManagerConfig `json:"config"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			response.Error(w, http.StatusBadRequest, err)
			return
		}
		ok, err := h.App.AdminAuthService.VerifySubmittedExternalConfigHeader(
			r.Context(),
			r.Header.Get("Authorization"),
			req.Config,
		)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err)
			return
		}
		if !ok {
			response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
			return
		}
		result, err := h.App.ManagerConfigService.Update(r.Context(), req.Config)
		if err != nil {
			response.Error(w, response.ManagerConfigErrorStatus(err), err)
			return
		}
		response.JSON(w, http.StatusOK, result)
	default:
		response.MethodNotAllowed(w)
	}
}

func (h *Handler) ChangeAdminKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.MethodNotAllowed(w)
		return
	}
	var req struct {
		CurrentKey string `json:"currentKey"`
		NewKey     string `json:"newKey"`
		ConfirmKey string `json:"confirmKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, errors.New("invalid admin key request"))
		return
	}
	if req.NewKey != req.ConfirmKey {
		response.Error(w, http.StatusBadRequest, errors.New("new admin keys do not match"))
		return
	}
	// Require both the authenticated session and the explicitly entered old
	// key. This prevents a stale browser session from rotating credentials.
	ok, err := h.App.AdminAuthService.VerifyHeader(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
		return
	}
	if err := h.App.AdminAuthService.ChangeAdminKey(r.Context(), req.CurrentKey, req.NewKey); err != nil {
		if strings.Contains(err.Error(), "invalid admin key") {
			response.Error(w, http.StatusUnauthorized, err)
			return
		}
		response.Error(w, http.StatusBadRequest, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]bool{"changed": true})
}

func (h *Handler) authorizeRead(w http.ResponseWriter, r *http.Request) bool {
	ok, err := h.App.AdminAuthService.VerifyPanelHeader(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return false
	}
	if ok {
		return true
	}
	setup, setupOK, err := h.App.ManagerConfigService.ResolveSetup(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return false
	}
	if !setupOK || setup.ManagementKey == "" {
		return true
	}
	response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
	return false
}

// ValidateCPAConnection is the strict server-side CPA connection validation
// endpoint used by the installer after a connection import. It requires CPAMP
// admin auth, ignores any client-supplied CPA Management Key, resolves the
// connection Manager Server actually uses, and propagates every CPA upstream
// failure (auth, network, 5xx) as a non-2xx response so the installer fails
// closed instead of committing a migration on a false positive.
func (h *Handler) ValidateCPAConnection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.MethodNotAllowed(w)
		return
	}
	ok, err := h.App.AdminAuthService.VerifyHeader(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		response.Error(w, http.StatusUnauthorized, errors.New("invalid admin key"))
		return
	}
	result, err := h.App.ManagerConfigService.ValidateCPAConnection(r.Context())
	if err != nil {
		response.Error(w, http.StatusBadGateway, err)
		return
	}
	if !result.Configured {
		response.Error(w, http.StatusConflict, errors.New("CPA connection is not configured"))
		return
	}
	response.JSON(w, http.StatusOK, result)
}
