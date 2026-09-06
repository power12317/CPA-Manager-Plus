package proxy

import (
	"net/http"
	"net/url"
	"testing"
)

func TestUpstreamRedirectPreservesDeploymentAndInstance(t *testing.T) {
	upstream, _ := url.Parse("http://cpa:8317")
	public, _ := url.Parse("https://example.com/tools/cpamp/api/instances/default/v0/management/start")
	for _, raw := range []string{"/v0/management/next?state=one", "http://cpa:8317/v0/management/next?state=one"} {
		response := &http.Response{Header: http.Header{"Location": []string{raw}}}
		rewriteLocalRedirect(response, upstream, "/v0/management/start")
		relative, err := url.Parse(response.Header.Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		got := public.ResolveReference(relative).String()
		if got != "https://example.com/tools/cpamp/api/instances/default/v0/management/next?state=one" {
			t.Fatalf("redirect escaped scope: %s", got)
		}
	}
	response := &http.Response{Header: http.Header{"Location": []string{"https://accounts.example.com/authorize"}}}
	rewriteLocalRedirect(response, upstream, "/v0/management/start")
	if response.Header.Get("Location") != "https://accounts.example.com/authorize" {
		t.Fatal("external OAuth redirect rewritten")
	}
}
