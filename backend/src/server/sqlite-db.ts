import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppDatabase, AppExecResult, AppPreparedStatement, AppResult } from "../runtime";

type SqliteValue = string | number | bigint | null | Buffer;

export interface SqliteOptions {
  databasePath: string;
  migrationsDir: string;
}

export function openSqliteDatabase(options: SqliteOptions): AppDatabase {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const sqlite = new Database(options.databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrateSqliteDatabase(sqlite, options.migrationsDir);
  return createSqliteDatabase(sqlite);
}

export function createSqliteDatabase(sqlite: Database.Database): AppDatabase {
  const database = {
    prepare(sql: string) {
      return new SqliteStatement(sqlite, sql);
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]): Promise<Array<AppResult<T>>> {
      const runBatch = sqlite.transaction(() =>
        statements.map((statement) => {
          if (!(statement instanceof SqliteStatement)) {
            throw new Error("SQLite adapter can only batch its own prepared statements");
          }
          return statement.runSync<T>();
        })
      );
      return runBatch();
    },
    async exec(sql: string): Promise<AppExecResult> {
      sqlite.exec(sql);
      return { count: splitSqlStatements(sql).length, duration: 0 };
    }
  };

  return database as unknown as AppDatabase;
}

export function migrateSqliteDatabase(sqlite: Database.Database, migrationsDir: string): void {
  if (!existsSync(migrationsDir)) {
    throw new Error(`SQLite migrations directory does not exist: ${migrationsDir}`);
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    sqlite.prepare("SELECT name FROM schema_migrations").all().map((row) => String((row as { name: unknown }).name))
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort();

  for (const fileName of migrationFiles) {
    if (applied.has(fileName)) {
      continue;
    }

    const sql = readFileSync(join(migrationsDir, fileName), "utf8");
    const statements = splitSqlStatements(sql);
    const applyMigration = sqlite.transaction(() => {
      for (const statement of statements) {
        try {
          sqlite.prepare(statement).run();
        } catch (error) {
          if (!isIgnorableMigrationError(error)) {
            throw error;
          }
        }
      }
      sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))").run(fileName);
    });

    applyMigration();
  }
}

class SqliteStatement {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly sql: string,
    private readonly bindings: SqliteValue[] = []
  ) {}

  bind(...values: unknown[]): AppPreparedStatement {
    return new SqliteStatement(this.sqlite, this.sql, values.map(normalizeBinding));
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.bindings) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return (column ? row[column] : row) as T;
  }

  async all<T = unknown>(): Promise<AppResult<T>> {
    const rows = this.sqlite.prepare(this.sql).all(...this.bindings) as T[];
    return appResult(rows);
  }

  async run<T = unknown>(): Promise<AppResult<T>> {
    return this.runSync<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.sqlite.prepare(this.sql);
    const rows = statement.raw().all(...this.bindings) as T[];
    if (options?.columnNames) {
      return [statement.columns().map((column) => column.name), ...rows];
    }
    return rows;
  }

  runSync<T = unknown>(): AppResult<T> {
    const result = this.sqlite.prepare(this.sql).run(...this.bindings);
    return appResult([], Number(result.changes), Number(result.lastInsertRowid));
  }
}

function appResult<T>(rows: T[], changes = 0, lastRowId = 0): AppResult<T> {
  return {
    success: true,
    meta: {
      duration: 0,
      changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      size_after: 0,
      rows_read: rows.length,
      rows_written: changes
    },
    results: rows
  } as AppResult<T>;
}

function normalizeBinding(value: unknown): SqliteValue {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return String(value);
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (!quote && char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      current += "\n";
      continue;
    }

    current += char;

    if (quote) {
      if (char === quote) {
        if ((quote === "'" || quote === '"') && next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === ";") {
      const statement = current.slice(0, -1).trim();
      if (statement) {
        statements.push(statement);
      }
      current = "";
    }
  }

  const finalStatement = current.trim();
  if (finalStatement) {
    statements.push(finalStatement);
  }
  return statements;
}

function isIgnorableMigrationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("duplicate column name") ||
    message.includes("already exists") ||
    message.includes("duplicate index") ||
    message.includes("index") && message.includes("already exists");
}
