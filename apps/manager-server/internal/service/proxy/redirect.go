package proxy

import (
	"net/http"
	"net/url"
	"path"
	"strings"
)

// Keep upstream-local redirects inside the public deployment AND instance
// prefix without trusting forwarded headers. Relative Location resolution is
// performed by the browser against the original public request URL.
func rewriteLocalRedirect(response *http.Response, upstream *url.URL, requestPath string) {
	raw := response.Header.Get("Location")
	if raw == "" {
		return
	}
	location, err := url.Parse(raw)
	if err != nil {
		return
	}
	if location.Host != "" && (location.Host != upstream.Host || (location.Scheme != "" && location.Scheme != upstream.Scheme)) {
		return
	}
	if location.Host == "" && !strings.HasPrefix(location.Path, "/") {
		return
	}
	target := location.EscapedPath()
	basePath := strings.TrimRight(upstream.EscapedPath(), "/")
	if basePath != "" && (target == basePath || strings.HasPrefix(target, basePath+"/")) {
		target = strings.TrimPrefix(target, basePath)
	}
	directory := strings.Trim(path.Dir(requestPath), "/")
	depth := 0
	if directory != "" && directory != "." {
		depth = len(strings.Split(directory, "/"))
	}
	relative := strings.Repeat("../", depth) + strings.TrimPrefix(target, "/")
	if relative == "" {
		relative = "./"
	}
	if location.RawQuery != "" {
		relative += "?" + location.RawQuery
	}
	if location.Fragment != "" {
		relative += "#" + location.EscapedFragment()
	}
	response.Header.Set("Location", relative)
}
