package cluster

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
)

type ExportFile struct{ *os.File }

func (f *ExportFile) Close() error {
	name := f.Name()
	return errors.Join(f.File.Close(), os.Remove(name))
}

// Assemble a complete sanitized JSONL export before sending response headers,
// so an unavailable source never produces a silently incomplete download.
func (s *Service) ExportAll(r *http.Request) (*ExportFile, error) {
	items, err := s.List(r.Context())
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp("", "cpamp-usage-export-*.jsonl")
	if err != nil {
		return nil, err
	}
	result := &ExportFile{file}
	success := false
	defer func() {
		if !success {
			_ = result.Close()
		}
	}()
	for index, item := range items {
		if !item.Enabled {
			continue
		}
		rt, err := s.Runtime(item.ID)
		if err != nil {
			return nil, err
		}
		response := &capturedResponse{header: make(http.Header)}
		rt.ServeHTTP(response, r.Clone(r.Context()))
		if response.err != nil || response.status() < 200 || response.status() >= 300 {
			return nil, errors.New("an instance could not export its usage data")
		}
		scanner := bufio.NewScanner(&response.Buffer)
		scanner.Buffer(make([]byte, 4096), 8<<20)
		for scanner.Scan() {
			if err := r.Context().Err(); err != nil {
				return nil, err
			}
			if len(scanner.Bytes()) == 0 {
				continue
			}
			var value any
			if err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
				return nil, err
			}
			value = scopeOutput(value, item, int64(index+1), "items", r.URL.Path)
			if err := json.NewEncoder(file).Encode(value); err != nil {
				return nil, err
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if info.Size() > 1<<30 {
			return nil, errors.New("aggregate export exceeds 1 GiB; export individual instances")
		}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	success = true
	return result, nil
}
