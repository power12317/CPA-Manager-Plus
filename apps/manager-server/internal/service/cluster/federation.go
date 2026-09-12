package cluster

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	monitoringsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/monitoring"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const eventStride int64 = 1_000_000_000_000
const machinePrefix = "@cpamp/"

type FederatedResult struct {
	Data      any      `json:"-"`
	Total     int      `json:"total"`
	Succeeded int      `json:"succeeded"`
	Failures  []string `json:"failures"`
}

type capturedResponse struct {
	header http.Header
	code   int
	bytes.Buffer
	err error
}

func (w *capturedResponse) Header() http.Header { return w.header }
func (w *capturedResponse) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
}
func (w *capturedResponse) Write(data []byte) (int, error) {
	if w.code == 0 {
		w.code = 200
	}
	if w.Len()+len(data) > 64<<20 {
		w.err = errors.New("instance response too large")
		return 0, w.err
	}
	return w.Buffer.Write(data)
}
func (w *capturedResponse) Flush() {}
func (w *capturedResponse) status() int {
	if w.code == 0 {
		return http.StatusOK
	}
	return w.code
}

func readOnlyRequest(r *http.Request) bool {
	if r.Method == http.MethodGet {
		return !strings.Contains(r.URL.Path, "-auth-url") && !strings.HasSuffix(r.URL.Path, "/get-auth-status")
	}
	return r.Method == http.MethodPost && (strings.HasPrefix(r.URL.Path, "/v0/management/monitoring/") || strings.HasSuffix(r.URL.Path, "/quota-snapshots/query"))
}

func qualified(id, value string) string {
	if value == "" {
		return ""
	}
	return machinePrefix + id + "/" + value
}
func splitQualified(value string) (string, string, bool) {
	if !strings.HasPrefix(value, machinePrefix) {
		return "", "", false
	}
	id, rest, ok := strings.Cut(strings.TrimPrefix(value, machinePrefix), "/")
	return id, rest, ok && (id == DefaultID || validID(id))
}
func displayPrefix(item Instance) string { return "[" + item.Name + "] " }

func originOf(value string, items []Instance) (string, string, bool) {
	if id, raw, ok := splitQualified(value); ok {
		return id, raw, true
	}
	for _, item := range items {
		if strings.HasPrefix(value, displayPrefix(item)) {
			return item.ID, strings.TrimPrefix(value, displayPrefix(item)), true
		}
	}
	return "", "", false
}

// Explicit origins come from server-produced credential identities. A generic
// write without an origin is never broadcast across every CPA.
func identityField(key string) bool {
	switch key {
	case "", "name", "names", "fileName", "file_name", "filename", "id", "ids", "runtimeId", "runtime_id", "auth_index", "authIndex", "auth_indices", "auth_files", "auth_file_snapshot", "authFileSnapshot", "account_snapshot", "accountSnapshot", "accounts", "source", "sources", "source_hash", "source_hashes", "credential_id", "credential_ids", "account_key", "state":
		return true
	}
	return false
}

func (s *Service) RequestOrigins(r *http.Request, body []byte) ([]string, error) {
	items, err := s.List(r.Context())
	if err != nil {
		return nil, err
	}
	found := map[string]bool{}
	scan := func(value string) {
		if id, _, ok := originOf(value, items); ok {
			found[id] = true
		}
	}
	for key, values := range r.URL.Query() {
		for _, value := range values {
			if identityField(key) {
				scan(value)
			}
		}
	}
	for _, segment := range strings.Split(r.URL.Path, "/") {
		scan(segment)
	}
	if strings.HasPrefix(r.URL.Path, "/v0/management/account-action-candidates/") {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v0/management/account-action-candidates/"), "/")
		if encoded, err := strconv.ParseInt(parts[0], 10, 64); err == nil && encoded >= eventStride {
			ordinal := encoded / eventStride
			if ordinal >= 1 && ordinal <= int64(len(items)) {
				found[items[ordinal-1].ID] = true
			}
		}
	}
	var visit func(any, string)
	visit = func(value any, key string) {
		switch v := value.(type) {
		case string:
			if identityField(key) {
				scan(v)
			}
		case []any:
			for _, x := range v {
				visit(x, key)
			}
		case map[string]any:
			for key, x := range v {
				visit(x, key)
			}
		}
	}
	var payload any
	if json.Unmarshal(body, &payload) == nil {
		visit(payload, "")
	}
	for key, values := range r.Header {
		if strings.HasPrefix(http.CanonicalHeaderKey(key), "X-Cpamp-Auth-File-") {
			for _, value := range values {
				scan(value)
				if decoded, err := url.QueryUnescape(value); err == nil {
					scan(decoded)
					if json.Unmarshal([]byte(decoded), &payload) == nil {
						visit(payload, "")
					}
				}
				for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
					raw, err := encoding.DecodeString(value)
					if err == nil && json.Unmarshal(raw, &payload) == nil {
						visit(payload, "")
						break
					}
				}
			}
		}
	}
	if len(found) == 0 && !readOnlyRequest(r) && !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		if hint := r.Header.Get("X-CPAMP-Instance-Hint"); hint != "" {
			found[hint] = true
		}
	}
	result := make([]string, 0, len(found))
	for id := range found {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}

type omitted struct{}

func decodeScope(value any, id string, items []Instance, field ...string) any {
	key := ""
	if len(field) > 0 {
		key = field[0]
	}
	switch v := value.(type) {
	case string:
		if !identityField(key) {
			return v
		}
		if owner, raw, ok := originOf(v, items); ok {
			if owner != id {
				return omitted{}
			}
			return raw
		}
		return v
	case []any:
		result := make([]any, 0, len(v))
		for _, x := range v {
			decoded := decodeScope(x, id, items, key)
			if _, skip := decoded.(omitted); !skip {
				result = append(result, decoded)
			}
		}
		return result
	case map[string]any:
		result := map[string]any{}
		for key, x := range v {
			decoded := decodeScope(x, id, items, key)
			if _, skip := decoded.(omitted); skip {
				return omitted{}
			}
			result[key] = decoded
		}
		return result
	default:
		return value
	}
}

func (s *Service) ScopedRequest(r *http.Request, body []byte, id string) (*http.Request, error) {
	items, err := s.List(r.Context())
	if err != nil {
		return nil, err
	}
	next := r.Clone(r.Context())
	for _, item := range items {
		if item.ID == id {
			next.URL.Path = strings.ReplaceAll(next.URL.Path, "/"+displayPrefix(item), "/")
			next.URL.RawPath = ""
		}
	}
	next.Header = r.Header.Clone()
	if strings.HasPrefix(next.URL.Path, "/v0/management/account-action-candidates/") {
		parts := strings.Split(strings.TrimPrefix(next.URL.Path, "/v0/management/account-action-candidates/"), "/")
		if encoded, err := strconv.ParseInt(parts[0], 10, 64); err == nil && encoded >= eventStride {
			ordinal := encoded / eventStride
			if ordinal < 1 || ordinal > int64(len(items)) || items[ordinal-1].ID != id {
				return nil, errors.New("candidate belongs to another instance")
			}
			parts[0] = strconv.FormatInt(encoded%eventStride, 10)
			next.URL.Path = "/v0/management/account-action-candidates/" + strings.Join(parts, "/")
			next.URL.RawPath = ""
		}
	}
	query := next.URL.Query()
	for key, values := range query {
		out := []string{}
		for _, value := range values {
			decoded := decodeScope(value, id, items, key)
			if text, ok := decoded.(string); ok {
				out = append(out, text)
			}
		}
		query[key] = out
	}
	next.URL.RawQuery = query.Encode()
	for key, values := range next.Header {
		if !strings.HasPrefix(http.CanonicalHeaderKey(key), "X-Cpamp-Auth-File-") {
			continue
		}
		for i, value := range values {
			if decoded, err := url.QueryUnescape(value); err == nil {
				var object any
				if json.Unmarshal([]byte(decoded), &object) == nil {
					raw, err := json.Marshal(decodeScope(object, id, items))
					if err != nil {
						return nil, err
					}
					values[i] = url.QueryEscape(string(raw))
					continue
				}
				if http.CanonicalHeaderKey(key) == "X-Cpamp-Auth-File-Physical-Name" && next.Header.Get("X-CPAMP-Auth-File-Physical-Name-Encoding") == "uri" {
					if scoped, ok := decodeScope(decoded, id, items).(string); ok {
						values[i] = scoped
						continue
					}
				}
			}
			if decoded, ok := decodeScope(value, id, items).(string); ok {
				values[i] = decoded
			}
			for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
				raw, err := encoding.DecodeString(value)
				var payload any
				if err == nil && json.Unmarshal(raw, &payload) == nil {
					raw, err = json.Marshal(decodeScope(payload, id, items))
					if err != nil {
						return nil, err
					}
					values[i] = encoding.EncodeToString(raw)
					break
				}
			}
		}
		next.Header[key] = values
	}
	next.Header.Del("X-CPAMP-Auth-File-Physical-Name-Encoding")
	var payload any
	if strings.HasPrefix(next.Header.Get("Content-Type"), "multipart/") {
		_, params, err := mime.ParseMediaType(next.Header.Get("Content-Type"))
		if err != nil {
			return nil, err
		}
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		var rewritten bytes.Buffer
		writer := multipart.NewWriter(&rewritten)
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			header := part.Header
			if filename := part.FileName(); filename != "" {
				decoded := decodeScope(filename, id, items)
				name, ok := decoded.(string)
				if !ok {
					return nil, errors.New("file belongs to another instance")
				}
				header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": part.FormName(), "filename": name}))
			}
			destination, err := writer.CreatePart(header)
			if err != nil {
				return nil, err
			}
			if _, err := io.Copy(destination, part); err != nil {
				return nil, err
			}
			_ = part.Close()
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		body = rewritten.Bytes()
		next.Header.Set("Content-Type", writer.FormDataContentType())
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		payload = decodeScope(payload, id, items)
		// Global keyset cursors sort by (timestamp, instance ordinal, local id).
		ordinal := int64(0)
		for i, item := range items {
			if item.ID == id {
				ordinal = int64(i + 1)
			}
		}
		if object, ok := payload.(map[string]any); ok {
			if include, ok := object["include"].(map[string]any); ok {
				if page, ok := include["events_page"].(map[string]any); ok {
					if cursor, ok := page["before_id"].(float64); ok && cursor >= float64(eventStride) {
						owner := int64(cursor) / eventStride
						local := int64(cursor) % eventStride
						if ordinal > owner {
							local = 0
						} else if ordinal < owner {
							local = eventStride - 1
						}
						page["before_id"] = local
					}
				}
			}
		}
		body, err = json.Marshal(payload)
		if err != nil {
			return nil, err
		}
	}
	next.Body = io.NopCloser(bytes.NewReader(body))
	next.ContentLength = int64(len(body))
	next.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	return next, nil
}

func scopeOutput(value any, item Instance, ordinal int64, parent, path string) any {
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, x := range v {
			if text, ok := x.(string); ok && text != "" {
				switch key {
				case "auth_index", "authIndex", "source_hash", "event_hash", "eventHash", "credential_id", "account_key", "state":
					x = qualified(item.ID, text)
				case "auth_file_snapshot", "auth_file", "account_snapshot", "source":
					x = displayPrefix(item) + text
				case "id":
					if path == "/v0/management/auth-files" || strings.Contains(path, "monitoring") || strings.Contains(path, "codex-inspection") || strings.Contains(path, "account-action") {
						x = qualified(item.ID, text)
					}
				case "name":
					if (strings.Contains(path, "auth-files") && !strings.HasSuffix(path, "/models")) || strings.Contains(path, "request-error-logs") {
						x = displayPrefix(item) + text
					}
				}
			}
			if n, ok := x.(float64); ok && (key == "id" || key == "next_before_id") && n > 0 {
				x = float64(ordinal*eventStride) + n
			}
			out[key] = scopeOutput(x, item, ordinal, key, path)
		}
		if parent == "files" || parent == "items" || parent == "recent_failures" {
			out["instanceId"] = item.ID
			out["instanceName"] = item.Name
		}
		return out
	case []any:
		out := make([]any, 0, len(v))
		for _, x := range v {
			if text, ok := x.(string); ok {
				switch parent {
				case "auth_indices", "source_hashes", "credential_ids":
					x = qualified(item.ID, text)
				case "auth_files", "accounts", "sources":
					x = displayPrefix(item) + text
				case "files":
					if strings.Contains(path, "auth-files") {
						x = displayPrefix(item) + text
					}
				}
			}
			out = append(out, scopeOutput(x, item, ordinal, parent, path))
		}
		return out
	default:
		return value
	}
}

func (s *Service) Federate(r *http.Request, body []byte) (FederatedResult, error) {
	nowMS := time.Now().UnixMilli()
	if requested, err := strconv.ParseInt(r.URL.Query().Get("now_ms"), 10, 64); err == nil && requested > 0 {
		nowMS = requested
	}
	if r.URL.Path == "/v0/management/monitoring/analytics" {
		var payload map[string]any
		if json.Unmarshal(body, &payload) == nil && number(payload["now_ms"]) <= 0 {
			payload["now_ms"] = nowMS
			body, _ = json.Marshal(payload)
		}
	}
	items, err := s.List(r.Context())
	if err != nil {
		return FederatedResult{}, err
	}
	origins, err := s.RequestOrigins(r, body)
	if err != nil {
		return FederatedResult{}, err
	}
	if !readOnlyRequest(r) && len(origins) == 0 {
		return FederatedResult{}, errors.New("select an instance for this operation")
	}
	allowed := map[string]bool{}
	for _, id := range origins {
		allowed[id] = true
	}
	if r.URL.Path == "/v0/management/model-prices" {
		allowed[DefaultID] = true
	}
	type part struct {
		data any
		err  error
		name string
	}
	parts := make([]part, len(items))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for index, item := range items {
		if !item.Enabled || (len(allowed) > 0 && !allowed[item.ID]) {
			continue
		}
		parts[index].name = item.Name
		wg.Add(1)
		go func(index int, item Instance) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-r.Context().Done():
				parts[index].err = r.Context().Err()
				return
			}
			defer func() { <-sem }()
			rt, err := s.Runtime(item.ID)
			if err != nil {
				parts[index].err = err
				return
			}
			next, err := s.ScopedRequest(r, body, item.ID)
			if err != nil {
				parts[index].err = err
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
			defer cancel()
			next = next.WithContext(ctx)
			if next.URL.Path == "/v0/management/monitoring/analytics" {
				next = next.WithContext(monitoringsvc.WithFederatedPercentiles(ctx))
			}
			if next.URL.Path == "/v0/management/available-models" {
				keysRequest := next.Clone(ctx)
				keysRequest.URL.Path = "/v0/management/api-keys"
				keysResponse := &capturedResponse{header: make(http.Header)}
				rt.ServeHTTP(keysResponse, keysRequest)
				var keys map[string]any
				_ = json.Unmarshal(keysResponse.Bytes(), &keys)
				values, _ := keys["api-keys"].([]any)
				if len(values) == 0 {
					values, _ = keys["apiKeys"].([]any)
				}
				next.URL.Path = "/v1/models"
				next.Header.Del("Authorization")
				if len(values) > 0 {
					if key, ok := values[0].(string); ok {
						next.Header.Set("Authorization", "Bearer "+key)
					}
				}
			}
			if strings.HasSuffix(next.URL.Path, "/dashboard/summary") {
				q := next.URL.Query()
				q.Set("top_models", "100000")
				q.Set("now_ms", strconv.FormatInt(nowMS, 10))
				next.URL.RawQuery = q.Encode()
			}
			response := &capturedResponse{header: make(http.Header)}
			if next.URL.Path == "/v0/management/auth-files" && next.Method == http.MethodGet {
				files, err := rt.Credentials(ctx)
				if err != nil {
					parts[index].err = err
					return
				}
				response.WriteHeader(200)
				_ = json.NewEncoder(response).Encode(map[string]any{"files": files})
			} else {
				rt.ServeHTTP(response, next)
			}
			if response.err != nil || response.status() < 200 || response.status() >= 300 {
				parts[index].err = fmt.Errorf("instance request failed (%d)", response.status())
				return
			}
			var payload any
			if err := json.Unmarshal(response.Bytes(), &payload); err != nil {
				parts[index].err = errors.New("instance did not return JSON")
				return
			}
			var requested monitoringsvc.Request
			_ = json.Unmarshal(body, &requested)
			needsSamples := requested.Include.Timeline || requested.Include.AnomalyPoints || (requested.Include.Summary && (requested.Include.SummaryProfile != "compact" || requested.Include.SummaryPercentiles))
			if strings.HasSuffix(next.URL.Path, "/monitoring/analytics") && needsSamples {
				if hints, ok := rt.(interface {
					FederationHints(context.Context, *http.Request, []byte) (any, error)
				}); ok {
					hintBody := body
					if next.GetBody != nil {
						reader, _ := next.GetBody()
						hintBody, _ = io.ReadAll(reader)
						_ = reader.Close()
					}
					hint, err := hints.FederationHints(ctx, next, hintBody)
					if err != nil {
						parts[index].err = err
						return
					}
					if object, ok := payload.(map[string]any); ok {
						object["_federation"] = hint
					}
				}
			}
			parts[index].data = scopeOutput(payload, item, int64(index+1), "", r.URL.Path)
		}(index, item)
	}
	wg.Wait()
	result := FederatedResult{Failures: []string{}}
	for _, part := range parts {
		if part.name == "" {
			continue
		}
		result.Total++
		if part.err != nil {
			result.Failures = append(result.Failures, part.name)
			continue
		}
		result.Succeeded++
		result.Data = mergePayload(result.Data, part.data, "", r.URL.Path)
	}
	if result.Succeeded == 0 {
		// Keep aggregate read endpoints usable while an instance is offline. The
		// caller receives an empty, valid payload plus instanceCoverage failures.
		result.Data = emptyAggregatePayload(r.URL.Path)
		return result, nil
	}
	result.Data = finalizePayload(result.Data, "", r.URL.Path, body)
	if object, ok := result.Data.(map[string]any); ok {
		object["instanceCoverage"] = map[string]any{"total": result.Total, "succeeded": result.Succeeded, "failures": result.Failures}
	}
	return result, nil
}

func emptyAggregatePayload(path string) any {
	if strings.HasSuffix(path, "/auth-files") {
		return map[string]any{"files": []any{}}
	}
	if strings.HasSuffix(path, "/config") {
		return map[string]any{"config": map[string]any{}}
	}
	return map[string]any{}
}

// Read endpoints exposed through the aggregate base. Unknown GETs are still
// federated, preserving compatible plugin/provider list responses.
func IsAggregatePath(path string) bool {
	return path == "/api/aggregate" || strings.HasPrefix(path, "/api/aggregate/")
}

func StripAggregatePath(r *http.Request) *http.Request {
	next := r.Clone(r.Context())
	next.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/aggregate")
	next.URL.RawPath = ""
	return next
}
