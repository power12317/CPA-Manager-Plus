export interface CodexRuntimeCredential {
  name: string;
  label: string;
  enabled: boolean;
  owner: string;
  status: string;
  account_id?: string;
}

export interface CodexRuntimeState {
  enabled: boolean;
  credentials: CodexRuntimeCredential[];
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
