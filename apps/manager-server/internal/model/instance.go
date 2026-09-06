package model

// Instance contains public registry metadata only. Connection secrets live in
// the instance's encrypted settings, never in the registry or list response.
type Instance struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Enabled     bool   `json:"enabled"`
	CreatedAtMS int64  `json:"createdAtMs"`
}
