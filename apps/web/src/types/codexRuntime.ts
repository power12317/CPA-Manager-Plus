export interface CodexRuntimeWorker {
  id: string;
  url: string;
  auth_file: string;
  token_configured: boolean;
  models: string[];
  disabled: boolean;
}

export interface CodexRuntimeCredential {
  name: string;
  worker_id: string;
  enabled: boolean;
  owner: string;
  status: string;
  account_id?: string;
}

export interface CodexRuntimeState {
  enabled: boolean;
  workers: CodexRuntimeWorker[];
  credentials: CodexRuntimeCredential[];
}

export interface CodexRuntimeWorkerInput {
  id: string;
  url: string;
  auth_file: string;
  models: string[];
  disabled: boolean;
  token?: string;
}

export interface CodexRuntimeLogin {
  login_id: string;
  url: string;
  state?: string;
}

export interface CodexRuntimeLoginStatus {
  status: 'pending' | 'completed' | 'error';
  error?: string;
}
