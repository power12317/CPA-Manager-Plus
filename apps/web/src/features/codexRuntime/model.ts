import type { CodexRuntimeWorker, CodexRuntimeWorkerInput } from '@/types/codexRuntime';

export interface WorkerDraft {
  key: string;
  id: string;
  url: string;
  authFile: string;
  token: string;
  models: string;
  saved: boolean;
  disabled: boolean;
}

export const workerDraft = (worker: CodexRuntimeWorker): WorkerDraft => ({
  key: worker.id,
  id: worker.id,
  url: worker.url,
  authFile: worker.auth_file,
  token: '',
  models: worker.models.join('\n'),
  saved: true,
  disabled: worker.disabled,
});

export function validateWorkers(workers: WorkerDraft[]): string | undefined {
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const worker of workers) {
    const id = worker.id.trim();
    const file = worker.authFile.trim();
    if (!id || !file || !worker.url.trim()) return 'required_fields';
    if (ids.has(id) || files.has(file)) return 'duplicate_worker';
    if (/[\\/]/.test(file) || !file.endsWith('.json') || file === '.json') return 'invalid_file';
    try {
      const url = new URL(worker.url.trim());
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
        return 'invalid_url';
    } catch {
      return 'invalid_url';
    }
    ids.add(id);
    files.add(file);
  }
  return undefined;
}

export function workerPayload(workers: WorkerDraft[]): CodexRuntimeWorkerInput[] {
  return workers.map((worker) => ({
    id: worker.id.trim(),
    url: worker.url.trim(),
    auth_file: worker.authFile.trim(),
    disabled: worker.disabled,
    models: [
      ...new Set(
        worker.models
          .split(/[\n,]/)
          .map((model) => model.trim())
          .filter(Boolean)
      ),
    ],
    ...(worker.token.trim() ? { token: worker.token.trim() } : {}),
  }));
}

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
