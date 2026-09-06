package cluster

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
)

// GuardConnectionUpdate routes connection edits through the registry's duplicate
// consumer check; all other Manager settings use the existing update controller.
func GuardConnectionUpdate(w http.ResponseWriter, r *http.Request, load func(context.Context) (model.ManagerCPAConnectionConfig, error)) bool {
	if r.URL.Path != "/usage-service/config" || r.Method != http.MethodPut {
		return true
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		response.Error(w, 400, err)
		return false
	}
	var submitted model.ManagerConfig
	if err := json.Unmarshal(body, &submitted); err != nil {
		response.Error(w, 400, err)
		return false
	}
	current, err := load(r.Context())
	if err != nil {
		response.Error(w, 500, err)
		return false
	}
	if (submitted.CPAConnection.CPABaseURL != "" && cpa.NormalizeBaseURL(submitted.CPAConnection.CPABaseURL) != current.CPABaseURL) || (submitted.CPAConnection.ManagementKey != "" && submitted.CPAConnection.ManagementKey != current.ManagementKey) {
		response.Error(w, 409, errors.New("change CPA connection in the instance registry"))
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return true
}
