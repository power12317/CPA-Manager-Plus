package cluster

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/dashboard"
)

const DefaultID = "default"

var ErrNotFound = errors.New("instance not found")
var ErrDisabled = errors.New("instance is disabled")

type Repository interface {
	LoadInstances(context.Context) ([]model.Instance, error)
	SaveInstances(context.Context, []model.Instance) error
}

// Runtime owns one instance's connection, database and background tasks.
type Runtime interface {
	http.Handler
	Connection(context.Context) (model.ManagerCPAConnectionConfig, error)
	Configure(context.Context, model.ManagerCPAConnectionConfig) error
	Credentials(context.Context) ([]map[string]any, error)
	Online(context.Context) bool
	Summary(context.Context, dashboard.SummaryParams) (dashboard.SummaryResponse, error)
	Start(context.Context)
	Stop(context.Context) error
	Close() error
}

type Factory func(context.Context, string) (Runtime, error)
type entry struct {
	model.Instance
	runtime Runtime
	err     error
}

type Instance struct {
	model.Instance
	BaseURL                 string `json:"baseUrl"`
	ManagementKeyConfigured bool   `json:"managementKeyConfigured"`
	Ready                   bool   `json:"ready"`
	Error                   string `json:"error,omitempty"`
}

type Input struct {
	Name          string `json:"name"`
	BaseURL       string `json:"baseUrl"`
	ManagementKey string `json:"managementKey,omitempty"`
	Enabled       bool   `json:"enabled"`
}

type Service struct {
	repo    Repository
	factory Factory
	mu      sync.RWMutex
	writeMu sync.Mutex
	entries map[string]*entry
	ctx     context.Context
	cancel  context.CancelFunc
	ready   chan struct{}
	loadErr error
}

func New(repo Repository, factory Factory, legacy Runtime) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{repo: repo, factory: factory, ctx: ctx, cancel: cancel,
		ready: make(chan struct{}), entries: map[string]*entry{
			DefaultID: {Instance: model.Instance{ID: DefaultID, Name: "Default", Enabled: true}, runtime: legacy},
		}}
}

// Start is called only after the HTTP listener is serving. Existing data files
// are opened independently, so one unavailable instance cannot delay the panel.
func (s *Service) Start(ctx context.Context) {
	go func() {
		select {
		case <-ctx.Done():
			s.cancel()
		case <-s.ctx.Done():
		}
	}()
	go func() {
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		defer close(s.ready)
		items, err := s.repo.LoadInstances(s.ctx)
		if err != nil {
			s.mu.Lock()
			s.loadErr = err
			s.mu.Unlock()
			return
		}
		for index, item := range items {
			if item.ID == DefaultID {
				s.mu.Lock()
				s.entries[DefaultID].Name = item.Name
				s.mu.Unlock()
				continue
			}
			if !validID(item.ID) {
				continue
			}
			// Preserve registry insertion order for entries predating timestamps.
			if item.CreatedAtMS == 0 {
				item.CreatedAtMS = int64(index + 1)
			}
			s.mu.Lock()
			s.entries[item.ID] = &entry{Instance: item}
			s.mu.Unlock()
		}
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4)
		for _, item := range items {
			if item.ID == DefaultID || !validID(item.ID) {
				continue
			}
			wg.Add(1)
			go func(item model.Instance) {
				defer wg.Done()
				select {
				case sem <- struct{}{}:
				case <-s.ctx.Done():
					return
				}
				defer func() { <-sem }()
				rt, err := s.factory(s.ctx, item.ID)
				s.mu.Lock()
				e := s.entries[item.ID]
				e.runtime, e.err = rt, err
				s.mu.Unlock()
				if err == nil && item.Enabled {
					rt.Start(s.ctx)
				}
			}(item)
		}
		wg.Wait()
	}()
}

func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && id == strings.ToLower(id)
}

func (s *Service) List(ctx context.Context) ([]Instance, error) {
	s.mu.RLock()
	if s.loadErr != nil {
		s.mu.RUnlock()
		return nil, errors.New("instance registry could not be loaded")
	}
	entries := make([]entry, 0, len(s.entries))
	for _, e := range s.entries {
		entries = append(entries, *e)
	}
	s.mu.RUnlock()
	result := make([]Instance, 0, len(entries))
	for _, e := range entries {
		item := Instance{Instance: e.Instance, Ready: e.runtime != nil && e.err == nil}
		if item.Ready {
			connection, err := e.runtime.Connection(ctx)
			if err != nil {
				item.Ready = false
				item.Error = "connection settings unavailable"
			} else {
				item.BaseURL = connection.CPABaseURL
				item.ManagementKeyConfigured = connection.ManagementKey != ""
			}
		} else {
			item.Error = "instance is initializing or unavailable"
		}
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAtMS != result[j].CreatedAtMS {
			return result[i].CreatedAtMS < result[j].CreatedAtMS
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}

func (s *Service) Runtime(id string) (Runtime, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e := s.entries[id]
	if e == nil {
		return nil, ErrNotFound
	}
	if !e.Enabled {
		return nil, ErrDisabled
	}
	if e.runtime == nil || e.err != nil {
		return nil, errors.New("instance is not ready")
	}
	return e.runtime, nil
}

func normalizeURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("baseUrl must be an HTTP(S) URL without credentials, query or fragment")
	}
	u.Host = strings.ToLower(u.Host)
	return cpa.NormalizeBaseURL(u.String()), nil
}

func (s *Service) Save(ctx context.Context, id string, input Input) (string, error) {
	select {
	case <-s.ready:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 100 {
		return "", errors.New("name is required and must be at most 100 bytes")
	}
	base, err := normalizeURL(input.BaseURL)
	if err != nil {
		return "", err
	}
	items, err := s.List(ctx)
	if err != nil {
		return "", err
	}
	for _, other := range items {
		if other.ID != id && other.Name == input.Name {
			return "", errors.New("instance names must be unique")
		}
		if other.ID != id && other.BaseURL == base {
			return "", errors.New("this CPA address is already registered; duplicate queue consumers are not allowed")
		}
	}
	creating := id == ""
	var rt Runtime
	if creating {
		if len(items) >= 100 {
			return "", errors.New("at most 100 instances are supported")
		}
		if strings.TrimSpace(input.ManagementKey) == "" {
			return "", errors.New("managementKey is required")
		}
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", err
		}
		id = hex.EncodeToString(random[:])
		rt, err = s.factory(ctx, id)
		if err != nil {
			return "", errors.New("could not initialize instance storage")
		}
	} else {
		s.mu.RLock()
		e := s.entries[id]
		if e != nil {
			rt = e.runtime
		}
		s.mu.RUnlock()
		if e == nil {
			return "", ErrNotFound
		}
		if rt == nil {
			return "", errors.New("instance storage is unavailable")
		}
		if id == DefaultID && !input.Enabled {
			return "", errors.New("the compatibility instance cannot be disabled; disable its collector in configuration")
		}
	}
	connection := model.ManagerCPAConnectionConfig{CPABaseURL: base, ManagementKey: strings.TrimSpace(input.ManagementKey)}
	previous, err := rt.Connection(ctx)
	if err != nil {
		if creating {
			_ = rt.Close()
		}
		return "", err
	}
	if connection.ManagementKey == "" {
		connection.ManagementKey = previous.ManagementKey
	}
	if creating || connection != previous {
		if err := rt.Configure(ctx, connection); err != nil {
			if creating {
				_ = rt.Close()
			}
			// Never return an upstream body or URL that may contain credentials.
			return "", errors.New("CPA connection validation or persistence failed; verify the URL, key and remote-management access")
		}
	}
	meta := model.Instance{ID: id, Name: input.Name, Enabled: input.Enabled}
	if creating {
		meta.CreatedAtMS = time.Now().UnixMilli()
		for _, item := range items {
			if item.CreatedAtMS >= meta.CreatedAtMS {
				meta.CreatedAtMS = item.CreatedAtMS + 1
			}
		}
	}
	next := make([]model.Instance, 0, len(items)+1)
	for _, item := range items {
		if item.ID != id {
			next = append(next, item.Instance)
		} else {
			meta.CreatedAtMS = item.CreatedAtMS
		}
	}
	next = append(next, meta)
	if err := s.repo.SaveInstances(ctx, next); err != nil {
		if creating {
			_ = rt.Close()
		}
		return "", err
	}
	s.mu.Lock()
	s.entries[id] = &entry{Instance: meta, runtime: rt}
	s.mu.Unlock()
	if id != DefaultID {
		if input.Enabled {
			rt.Start(s.ctx)
		} else if err := rt.Stop(ctx); err != nil {
			return id, err
		}
	}
	return id, nil
}

type Result[T any] struct {
	InstanceID   string `json:"instanceId"`
	InstanceName string `json:"instanceName"`
	Data         T      `json:"data"`
	Error        string `json:"error,omitempty"`
	FetchedAtMS  int64  `json:"fetchedAtMs"`
	Online       bool   `json:"online"`
}

type Aggregate[T any] struct {
	Instances []Result[T] `json:"instances"`
	Total     int         `json:"total"`
	Succeeded int         `json:"succeeded"`
}

func aggregate[T any](ctx context.Context, s *Service, read func(context.Context, Runtime) (T, error)) (Aggregate[T], error) {
	items, err := s.List(ctx)
	if err != nil {
		return Aggregate[T]{}, err
	}
	active := make([]Instance, 0, len(items))
	for _, item := range items {
		if item.Enabled {
			active = append(active, item)
		}
	}
	out := Aggregate[T]{Instances: make([]Result[T], len(active)), Total: len(active)}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, item := range active {
		wg.Add(1)
		go func(i int, item Instance) {
			defer wg.Done()
			result := Result[T]{InstanceID: item.ID, InstanceName: item.Name}
			defer func() { result.FetchedAtMS = time.Now().UnixMilli(); out.Instances[i] = result }()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				result.Error = "request cancelled"
				return
			}
			defer func() { <-sem }()
			rt, err := s.Runtime(item.ID)
			if err != nil {
				result.Error = err.Error()
				return
			}
			readCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			result.Data, err = read(readCtx, rt)
			if err != nil {
				result.Error = "instance query failed or timed out"
			}
			checkCtx, cancelCheck := context.WithTimeout(ctx, 2*time.Second)
			result.Online = rt.Online(checkCtx)
			cancelCheck()
		}(i, item)
	}
	wg.Wait()
	for _, r := range out.Instances {
		if r.Error == "" {
			out.Succeeded++
		}
	}
	return out, nil
}

func (s *Service) Credentials(ctx context.Context) (Aggregate[[]map[string]any], error) {
	return aggregate(ctx, s, func(ctx context.Context, rt Runtime) ([]map[string]any, error) { return rt.Credentials(ctx) })
}

func (s *Service) Dashboard(ctx context.Context, params dashboard.SummaryParams) (Aggregate[dashboard.SummaryResponse], error) {
	return aggregate(ctx, s, func(ctx context.Context, rt Runtime) (dashboard.SummaryResponse, error) {
		return rt.Summary(ctx, params)
	})
}

func (s *Service) Close(ctx context.Context) error {
	s.cancel()
	select {
	case <-s.ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.RLock()
	entries := make([]entry, 0, len(s.entries))
	for _, e := range s.entries {
		entries = append(entries, *e)
	}
	s.mu.RUnlock()
	var errs []error
	for _, e := range entries {
		if e.ID == DefaultID || e.runtime == nil {
			continue
		}
		if err := e.runtime.Stop(ctx); err != nil {
			errs = append(errs, fmt.Errorf("stop instance %s: %w", e.ID, err))
			continue
		}
		if err := e.runtime.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
