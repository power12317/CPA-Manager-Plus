package cluster

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpaauthfiles"
)

var (
	ErrBorrowUnsupported       = errors.New("oailb borrowing is not supported by this CPA")
	ErrBorrowSourceUnsupported = errors.New("oailb borrowing is not supported by the source CPA")
	ErrBorrowSelection         = errors.New("select another enabled instance and a Codex OAuth credential")
	ErrBorrowCredential        = errors.New("the selected Codex OAuth credential is unavailable")
	ErrBorrowUnavailable       = errors.New("could not read or save oailb borrowing settings")
	ErrBorrowSourceUnavailable = errors.New("could not read the source instance")
)

const oailbSettingsPath = "/v0/management/codex-oailb-borrow"

// The browser selects registry identities, never connection secrets or URLs.
type OailbBorrowSelection struct {
	SourceInstanceID string `json:"sourceInstanceId"`
	SourceAuthID     string `json:"sourceAuthId"`
}

type OailbBorrowStatus struct {
	Supported        bool   `json:"supported"`
	Configured       bool   `json:"configured"`
	SourceInstanceID string `json:"sourceInstanceId,omitempty"`
	SourceAuthID     string `json:"sourceAuthId,omitempty"`
	SourceAuthFile   string `json:"sourceAuthFile,omitempty"`
}

type OailbBorrowCredential struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type cpaOailbBorrowConfig struct {
	SourceInstanceID    string `json:"source-instance-id"`
	SourceURL           string `json:"source-url"`
	SourceManagementKey string `json:"source-management-key"`
	SourceAuthID        string `json:"source-auth-id"`
	SourceAuthFile      string `json:"source-auth-file"`
}

func oailbHTTPClient() *http.Client {
	return &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		// A 307/308 must not send the source management key to a different host.
		return http.ErrUseLastResponse
	}}
}

func (s *Service) borrowConnection(ctx context.Context, id string) (model.ManagerCPAConnectionConfig, error) {
	runtime, err := s.Runtime(id)
	if err != nil {
		return model.ManagerCPAConnectionConfig{}, err
	}
	connection, err := runtime.Connection(ctx)
	if err != nil || connection.CPABaseURL == "" || connection.ManagementKey == "" {
		return model.ManagerCPAConnectionConfig{}, ErrBorrowUnavailable
	}
	return connection, nil
}

// Only bounded, allowlisted metadata escapes this service. Neither upstream
// bodies nor transport errors are returned: either could echo a secret.
func requestOailbSettings(ctx context.Context, connection model.ManagerCPAConnectionConfig, method string, payload any, result any) error {
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			return ErrBorrowUnavailable
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, cpa.NormalizeBaseURL(connection.CPABaseURL)+oailbSettingsPath, bytes.NewReader(body))
	if err != nil {
		return ErrBorrowUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+connection.ManagementKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := oailbHTTPClient().Do(req)
	if err != nil {
		return ErrBorrowUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 || resp.StatusCode == 405 || resp.StatusCode == 501 {
		return ErrBorrowUnsupported
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ErrBorrowUnavailable
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if err != nil || len(data) > 64<<10 || json.Unmarshal(data, result) != nil {
		return ErrBorrowUnavailable
	}
	return nil
}

func getOailbSettings(ctx context.Context, connection model.ManagerCPAConnectionConfig) (OailbBorrowStatus, error) {
	var result struct {
		Supported bool                  `json:"supported"`
		Config    *cpaOailbBorrowConfig `json:"config"`
	}
	err := requestOailbSettings(ctx, connection, http.MethodGet, nil, &result)
	if errors.Is(err, ErrBorrowUnsupported) {
		return OailbBorrowStatus{}, nil
	}
	if err != nil {
		return OailbBorrowStatus{}, err
	}
	status := OailbBorrowStatus{Supported: result.Supported}
	if result.Supported && result.Config != nil {
		status.Configured = result.Config.SourceURL != "" && result.Config.SourceAuthID != ""
		status.SourceInstanceID = result.Config.SourceInstanceID
		status.SourceAuthID = result.Config.SourceAuthID
		status.SourceAuthFile = result.Config.SourceAuthFile
	}
	return status, nil
}

func (s *Service) OailbBorrowSettings(ctx context.Context, targetID string) (OailbBorrowStatus, error) {
	connection, err := s.borrowConnection(ctx, targetID)
	if err != nil {
		return OailbBorrowStatus{}, err
	}
	return getOailbSettings(ctx, connection)
}

func borrowCredentials(ctx context.Context, source model.ManagerCPAConnectionConfig) ([]OailbBorrowCredential, error) {
	status, err := getOailbSettings(ctx, source)
	if err != nil {
		return nil, ErrBorrowSourceUnavailable
	}
	if !status.Supported {
		return nil, ErrBorrowSourceUnsupported
	}
	files, err := cpaauthfiles.New(oailbHTTPClient(), 15*time.Second).Fetch(ctx, source.CPABaseURL, source.ManagementKey)
	if err != nil {
		return nil, ErrBorrowSourceUnavailable
	}
	counts := map[string]int{}
	for _, file := range files {
		counts[file.ID]++
	}
	result := make([]OailbBorrowCredential, 0)
	for _, file := range files {
		kind, _ := file.Raw["account_type"].(string)
		runtimeOnly, _ := file.Raw["runtime_only"].(bool)
		if file.ID == "" || file.Name == "" || counts[file.ID] != 1 || file.Provider != "codex" || file.Disabled || runtimeOnly || !strings.EqualFold(strings.TrimSpace(kind), "oauth") {
			continue
		}
		result = append(result, OailbBorrowCredential{ID: file.ID, Name: file.Name})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name != result[j].Name {
			return result[i].Name < result[j].Name
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}

func (s *Service) OailbBorrowCredentials(ctx context.Context, targetID, sourceID string) ([]OailbBorrowCredential, error) {
	if targetID == sourceID || sourceID == "" {
		return nil, ErrBorrowSelection
	}
	if _, err := s.Runtime(targetID); err != nil {
		return nil, err
	}
	source, err := s.borrowConnection(ctx, sourceID)
	if err != nil {
		return nil, ErrBorrowSourceUnavailable
	}
	return borrowCredentials(ctx, source)
}

func (s *Service) SaveOailbBorrow(ctx context.Context, targetID string, selection OailbBorrowSelection) (OailbBorrowStatus, error) {
	selection.SourceInstanceID = strings.TrimSpace(selection.SourceInstanceID)
	selection.SourceAuthID = strings.TrimSpace(selection.SourceAuthID)
	target, err := s.borrowConnection(ctx, targetID)
	if err != nil {
		return OailbBorrowStatus{}, err
	}
	status, err := getOailbSettings(ctx, target)
	if err != nil {
		return OailbBorrowStatus{}, err
	}
	if !status.Supported {
		return OailbBorrowStatus{}, ErrBorrowUnsupported
	}
	var payload any = map[string]string{}
	status = OailbBorrowStatus{Supported: true}
	if selection.SourceInstanceID != "" || selection.SourceAuthID != "" {
		if selection.SourceInstanceID == "" || selection.SourceAuthID == "" || selection.SourceInstanceID == targetID {
			return OailbBorrowStatus{}, ErrBorrowSelection
		}
		source, err := s.borrowConnection(ctx, selection.SourceInstanceID)
		if err != nil {
			return OailbBorrowStatus{}, ErrBorrowSourceUnavailable
		}
		credentials, err := borrowCredentials(ctx, source)
		if err != nil {
			return OailbBorrowStatus{}, err
		}
		var name string
		for _, credential := range credentials {
			if credential.ID == selection.SourceAuthID {
				name = credential.Name
				break
			}
		}
		if name == "" {
			return OailbBorrowStatus{}, ErrBorrowCredential
		}
		// Connection() resolves the decrypted registry secret. CPA receives
		// plaintext over its management connection and encrypts with its own key.
		payload = cpaOailbBorrowConfig{SourceInstanceID: selection.SourceInstanceID, SourceURL: cpa.NormalizeBaseURL(source.CPABaseURL), SourceManagementKey: source.ManagementKey, SourceAuthID: selection.SourceAuthID, SourceAuthFile: name}
		status = OailbBorrowStatus{Supported: true, Configured: true, SourceInstanceID: selection.SourceInstanceID, SourceAuthID: selection.SourceAuthID, SourceAuthFile: name}
	}
	var saved struct {
		Status string `json:"status"`
	}
	if err := requestOailbSettings(ctx, target, http.MethodPut, payload, &saved); err != nil {
		return OailbBorrowStatus{}, err
	}
	if saved.Status != "ok" {
		return OailbBorrowStatus{}, ErrBorrowUnavailable
	}
	return status, nil
}
