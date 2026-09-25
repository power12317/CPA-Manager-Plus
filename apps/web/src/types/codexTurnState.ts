export interface CodexTurnStateTicket {
  model: string;
  length: number;
  ready: boolean;
  remainingSeconds: number;
  blocked: boolean;
  expiresAt?: string;
}

export interface CodexTurnStateAccount {
  id: string;
  name?: string;
  tickets: CodexTurnStateTicket[];
}

export interface CodexTurnStateStatus {
  enabled: boolean;
  targetLength: number;
  ttlSeconds: number;
  refreshBeforeSeconds: number;
  probeIntervalSeconds: number;
  attemptTimeoutSeconds: number;
  failClosed: boolean;
  models: string[];
  harvestProxyUrl: string;
  harvestProxyConfigured: boolean;
  accounts: CodexTurnStateAccount[];
}
