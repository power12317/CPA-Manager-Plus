package cluster

import (
	"errors"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func (h *Handler) aggregate(w http.ResponseWriter, r *http.Request) {
	if !middleware.AuthorizeAdmin(w, r, h.Auth) {
		return
	}
	next := clustersvc.StripAggregatePath(r)
	if clustersvc.RequiresInstance(next.URL.Path) {
		response.Error(w, http.StatusConflict, clustersvc.ErrInstanceRequired)
		return
	}
	if next.Method == http.MethodGet && next.URL.Path == "/v0/management/usage/export" {
		file, err := h.Service.ExportAll(next)
		if err != nil {
			response.Error(w, 502, err)
			return
		}
		defer file.Close()
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Content-Disposition", `attachment; filename="usage-all-instances.jsonl"`)
		_, _ = io.Copy(w, file)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65<<20))
	if err != nil {
		response.Error(w, 400, err)
		return
	}
	if strings.HasSuffix(next.URL.Path, "/auth-files/download") || strings.HasPrefix(next.Header.Get("Content-Type"), "multipart/") {
		origins, err := h.Service.RequestOrigins(next, body)
		if err != nil || len(origins) != 1 {
			response.Error(w, 409, errors.New("select one instance for this file operation"))
			return
		}
		scoped, err := h.Service.ScopedRequest(next, body, origins[0])
		if err != nil {
			response.Error(w, 400, err)
			return
		}
		rt, err := h.Service.Runtime(origins[0])
		if err != nil {
			response.Error(w, 503, err)
			return
		}
		rt.ServeHTTP(w, scoped)
		return
	}
	result, err := h.Service.Federate(next, body)
	if err != nil {
		response.Error(w, 502, err)
		return
	}
	w.Header().Set("X-CPAMP-Instance-Count", strconv.Itoa(result.Total))
	w.Header().Set("X-CPAMP-Instance-Succeeded", strconv.Itoa(result.Succeeded))
	response.JSON(w, 200, result.Data)
}
