package cluster

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	clustersvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cluster"
)

func (h *Handler) oailbBorrow(w http.ResponseWriter, r *http.Request, targetID, path string) {
	w.Header().Set("Cache-Control", "no-store")
	if path == "oailb-borrow/credentials" {
		if r.Method != http.MethodGet {
			response.MethodNotAllowed(w)
			return
		}
		items, err := h.Service.OailbBorrowCredentials(r.Context(), targetID, r.URL.Query().Get("source"))
		if err != nil {
			borrowError(w, err)
			return
		}
		response.JSON(w, 200, map[string]any{"credentials": items})
		return
	}
	switch r.Method {
	case http.MethodGet:
		status, err := h.Service.OailbBorrowSettings(r.Context(), targetID)
		if err != nil {
			borrowError(w, err)
			return
		}
		response.JSON(w, 200, status)
	case http.MethodPut:
		r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
		var input *clustersvc.OailbBorrowSelection
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil || input == nil {
			borrowError(w, clustersvc.ErrBorrowSelection)
			return
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			borrowError(w, clustersvc.ErrBorrowSelection)
			return
		}
		status, err := h.Service.SaveOailbBorrow(r.Context(), targetID, *input)
		if err != nil {
			borrowError(w, err)
			return
		}
		response.JSON(w, 200, status)
	default:
		response.MethodNotAllowed(w)
	}
}

func borrowError(w http.ResponseWriter, err error) {
	code, status := "oailb_borrow_unavailable", http.StatusBadGateway
	switch {
	case errors.Is(err, clustersvc.ErrBorrowUnsupported):
		code, status = "oailb_borrow_unsupported", http.StatusConflict
	case errors.Is(err, clustersvc.ErrBorrowSourceUnsupported):
		code, status = "oailb_borrow_source_unsupported", http.StatusConflict
	case errors.Is(err, clustersvc.ErrBorrowSelection):
		code, status = "oailb_borrow_selection", http.StatusBadRequest
	case errors.Is(err, clustersvc.ErrBorrowCredential):
		code, status = "oailb_borrow_credential", http.StatusConflict
	case errors.Is(err, clustersvc.ErrBorrowSourceUnavailable):
		code, status = "oailb_borrow_source_unavailable", http.StatusServiceUnavailable
	case errors.Is(err, clustersvc.ErrNotFound), errors.Is(err, clustersvc.ErrDisabled):
		code, status = "oailb_borrow_target_unavailable", http.StatusConflict
	}
	response.JSON(w, status, map[string]string{"code": code, "error": code})
}
