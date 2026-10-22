// Temporary binding lifecycle; remove when direct upstream provides SIWC.
export function isSiwcCallbackValid(value: string, state: string): boolean {
  try {
    const raw = value.trim();
    const url = new URL(raw);
    const params = url.searchParams;
    const get = (key: string) => params.get(key)?.trim();
    return Boolean(
      state &&
      raw.split('?')[0] === 'http://127.0.0.1:1455/auth/callback' &&
      !url.hash &&
      ['state', 'code', 'client_id', 'error'].every((key) => params.getAll(key).length <= 1) &&
      get('state') === state &&
      (get('error') || (get('code') && get('client_id')))
    );
  } catch {
    return false;
  }
}

// Do not abort start: its late response is needed to cancel the captured session.
export function createSiwcStart<T extends { state: string }>(options: {
  start: () => Promise<T>;
  cancel: (state: string) => Promise<unknown>;
  onResult: (result: T) => void;
  onError: (error: unknown) => void;
}) {
  let started = false;
  let closed = false;
  let completed = false;
  let state = '';
  const cleanup = () => {
    if (!state || completed) return;
    const pending = state;
    state = '';
    void options.cancel(pending).catch(() => {});
  };
  return {
    start: async () => {
      if (started || closed) return;
      started = true;
      try {
        const result = await options.start();
        state = result.state;
        if (closed) cleanup();
        else options.onResult(result);
      } catch (error) {
        if (!closed) options.onError(error);
      }
    },
    complete: () => {
      completed = true;
    },
    close: () => {
      closed = true;
      cleanup();
    },
  };
}
