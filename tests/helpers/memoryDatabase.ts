import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import * as schema from '../../server/db/schema.js';

/** Complete schema including defaults and new columns, isolated per test worker. */
export function createMemoryDatabase() {
  const sqlite = new Database(':memory:'), dialect = new SQLiteSyncDialect();
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table as any);
    const columns = config.columns.map(column => {
      const value = column.default;
      const sql = value === undefined ? '' : typeof value === 'object' ? dialect.sqlToQuery(value as any).sql
        : typeof value === 'string' ? "'" + value.replace(/'/g, "''") + "'" : String(value);
      return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.isUnique ? ' UNIQUE' : ''}${sql ? ' DEFAULT ' + sql : ''}`;
    });
    sqlite.exec(`CREATE TABLE "${config.name}" (${columns.join(',')})`);
  }
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
