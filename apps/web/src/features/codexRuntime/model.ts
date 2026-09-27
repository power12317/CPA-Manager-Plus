export function isCallbackURL(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      Boolean(url.searchParams.get('state')) &&
      Boolean(url.searchParams.get('code') || url.searchParams.get('error'))
    );
  } catch {
    return false;
  }
}
