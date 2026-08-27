declare module "bun:sqlite" {
  export class Statement<Result = Record<string, unknown>, Params extends unknown[] = unknown[]> {
    all(...params: Params): Result[];
    get(...params: Params): Result | null;
    run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
  }

  export class Database {
    constructor(filename: string, options?: { create?: boolean; readonly?: boolean });
    close(): void;
    exec(sql: string): void;
    query<Result = Record<string, unknown>, Params extends unknown[] = unknown[]>(sql: string): Statement<Result, Params>;
    run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
}
