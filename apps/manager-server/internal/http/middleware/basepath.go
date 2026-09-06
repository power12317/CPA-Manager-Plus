package middleware

import (
	"net/http"
	"strings"
)

// BasePath supports proxies that retain the deployment prefix. Proxies that
// strip it need no application configuration. Relative redirects work in both.
func BasePath(prefix string, next http.Handler) http.Handler {
	prefix = strings.TrimRight(prefix, "/")
	if prefix == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == prefix {
			w.Header().Set("Location", prefix+"/")
			w.WriteHeader(http.StatusTemporaryRedirect)
			return
		}
		if strings.HasPrefix(r.URL.Path, prefix+"/") {
			clone := r.Clone(r.Context())
			clone.URL.Path = strings.TrimPrefix(r.URL.Path, prefix)
			clone.URL.RawPath = ""
			next.ServeHTTP(w, clone)
			return
		}
		next.ServeHTTP(w, r)
	})
}
