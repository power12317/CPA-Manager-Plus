package usage

import "strings"

// NormalizeOailbNode accepts only CPA's compact DNS label, never a JWT, URL or
// complete hostname. CPA owns response/request precedence and socket identity.
func NormalizeOailbNode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) == 0 || len(value) > 63 || value[0] == '-' || value[len(value)-1] == '-' {
		return ""
	}
	for _, c := range value {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return ""
		}
	}
	return value
}
