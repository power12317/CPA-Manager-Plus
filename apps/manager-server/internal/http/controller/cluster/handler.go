package cluster

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/dashboard"
)

type Handler struct {
	Service *clustersvc.Service
	Auth    middleware.AdminVerifier
	Next    http.Handler
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if clustersvc.IsAggregatePath(r.URL.Path) {
		h.aggregate(w, r)
		return
	}
	path := strings.TrimRight(r.URL.Path, "/")
	if path != "/api/instances" && !strings.HasPrefix(path, "/api/instances/") && !strings.HasPrefix(path, "/api/cluster/") {
		h.Next.ServeHTTP(w, r)
		return
	}
	// HTML and runtime discovery must be accessible before login. Their content
	// is identical for every instance and contains no connection credentials.
	if strings.HasPrefix(path, "/api/instances/") {
		parts := strings.SplitN(strings.TrimPrefix(path, "/api/instances/"), "/", 2)
		// Model discovery keeps the legacy CPA API-key contract. This endpoint
		// forwards the caller's key unchanged and never substitutes an admin key.
		if len(parts) == 2 && (parts[1] == "v1/models" || parts[1] == "models") && r.Method == http.MethodGet {
			rt, err := h.Service.Runtime(parts[0])
			if err != nil {
				response.Error(w, 503, err)
				return
			}
			next := r.Clone(r.Context())
			next.URL.Path = "/" + parts[1]
			next.URL.RawPath = ""
			rt.ServeHTTP(w, next)
			return
		}
		if len(parts) == 2 && (parts[1] == "management.html" || parts[1] == "usage-service/info") && r.Method == http.MethodGet {
			next := r.Clone(r.Context())
			next.URL.Path = "/" + parts[1]
			next.URL.RawPath = ""
			h.Next.ServeHTTP(w, next)
			return
		}
	}
	if !middleware.AuthorizeAdmin(w, r, h.Auth) {
		return
	}
	if path == "/api/instances" {
		switch r.Method {
		case http.MethodGet:
			items, err := h.Service.List(r.Context())
			if err != nil {
				response.Error(w, 503, err)
				return
			}
			response.JSON(w, 200, map[string]any{"instances": items})
		case http.MethodPost:
			h.save(w, r, "")
		default:
			response.MethodNotAllowed(w)
		}
		return
	}
	if path == "/api/cluster/credentials" || path == "/api/cluster/dashboard" {
		if r.Method != http.MethodGet {
			response.MethodNotAllowed(w)
			return
		}
		if path == "/api/cluster/credentials" {
			data, err := h.Service.Credentials(r.Context())
			if err != nil {
				response.Error(w, 503, err)
				return
			}
			response.JSON(w, 200, data)
		} else {
			start, err := strconv.ParseInt(r.URL.Query().Get("today_start_ms"), 10, 64)
			if err != nil || start <= 0 || start > time.Now().UnixMilli() {
				response.Error(w, 400, errors.New("today_start_ms must be a positive timestamp no later than now"))
				return
			}
			data, err := h.Service.Dashboard(r.Context(), dashboard.SummaryParams{TodayStartMS: start, NowMS: time.Now().UnixMilli()})
			if err != nil {
				response.Error(w, 503, err)
				return
			}
			response.JSON(w, 200, data)
		}
		return
	}
	if strings.HasPrefix(path, "/api/instances/") {
		parts := strings.SplitN(strings.TrimPrefix(path, "/api/instances/"), "/", 2)
		if len(parts) == 1 {
			if r.Method == http.MethodPut {
				h.save(w, r, parts[0])
				return
			}
			response.MethodNotAllowed(w)
			return
		}
		rt, err := h.Service.Runtime(parts[0])
		if err != nil {
			status := 503
			if errors.Is(err, clustersvc.ErrNotFound) {
				status = 404
			}
			response.Error(w, status, err)
			return
		}
		next := r.Clone(r.Context())
		next.URL.Path = "/" + parts[1]
		next.URL.RawPath = ""
		// CPA connections are changed through the registry so duplicate queue
		// consumers cannot be introduced via a legacy setup endpoint.
		if next.URL.Path == "/setup" {
			response.Error(w, 409, errors.New("manage this connection in the instance registry"))
			return
		}
		rt.ServeHTTP(w, next)
		return
	}
	http.NotFound(w, r)
}

func (h *Handler) save(w http.ResponseWriter, r *http.Request, id string) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var input clustersvc.Input
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		response.Error(w, 400, errors.New("invalid instance settings"))
		return
	}
	id, err := h.Service.Save(r.Context(), id, input)
	if err != nil {
		response.Error(w, 400, err)
		return
	}
	response.JSON(w, 200, map[string]string{"id": id})
}
