package cluster

import (
	"context"
	"errors"
)

func (s *Service) monitoringEntries() ([]entry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.loadErr != nil {
		return nil, errors.New("instance registry could not be loaded")
	}
	entries := make([]entry, 0, len(s.entries))
	for _, e := range s.entries {
		if e.ID != DefaultID && e.runtime != nil && e.err == nil {
			entries = append(entries, *e)
		}
	}
	return entries, nil
}

func (s *Service) HasMonitoringConnection(ctx context.Context) (bool, error) {
	entries, err := s.monitoringEntries()
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		connection, err := e.runtime.Connection(ctx)
		if err != nil {
			return false, err
		}
		if connection.CPABaseURL != "" && connection.ManagementKey != "" {
			return true, nil
		}
	}
	return false, nil
}
