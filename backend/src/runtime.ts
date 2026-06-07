export interface AppEnv {
  STATIC_ASSETS?: StaticAssetHandler;
  DATABASE?: AppDatabase;
  TELEGRAM_RATE_LIMITER?: TelegramRateLimiterClient;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_STORAGE_CHAT_ID: string;
  LINK_SIGNING_SECRET: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_SESSION_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  MAX_FILE_BYTES?: string;
  STALE_MULTIPART_UPLOAD_TTL_HOURS?: string;
  TG_CHANNEL_SECRET?: string;
}

export interface StaticAssetHandler {
  fetch(request: Request): Promise<Response>;
}

export interface TelegramRateLimiterClient {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface AppDatabase {
  prepare(sql: string): AppPreparedStatement;
  batch<T = unknown>(statements: AppPreparedStatement[]): Promise<Array<AppResult<T>>>;
  exec?(sql: string): Promise<AppExecResult>;
}

export interface AppPreparedStatement {
  bind(...values: unknown[]): AppPreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<AppResult<T>>;
  run<T = Record<string, unknown>>(): Promise<AppResult<T>>;
  raw?<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]>;
}

export interface AppResult<T = unknown> {
  success: boolean;
  meta: AppResultMeta & Record<string, unknown>;
  results?: T[];
}

export interface AppResultMeta {
  duration: number;
  changes?: number;
  last_row_id?: number;
  changed_db?: boolean;
  size_after?: number;
  rows_read?: number;
  rows_written?: number;
}

export interface AppExecResult {
  count: number;
  duration: number;
}
