const NODE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Only display the compact node reported for this request by CPA. Full hostnames
// and JWTs are not valid node labels; do not infer a node from a current Cookie.
export const normalizeOailbNode = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const node = value.trim().toLowerCase();
  return NODE_LABEL.test(node) ? node : '';
};
