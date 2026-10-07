import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalRequest, signRequest } from '../../src/services/importPull.js';
import { checkSqlPage } from '../../src/services/importSql.js';

/**
 * The protocol's shared vectors (docs/internal/import-protocol.md): the plugin checks itself against
 * the same file (panel/migrate-plugin/tests/run.php), so the two ends cannot drift apart unnoticed.
 */
interface Vectors {
  signature: { name: string; token: string; importId: string; action: string; timestamp: number; nonce: string; body: string; bodySha256: string; canonical: string; signature: string }[];
  literals: { kind: string; value?: string | null; hex?: string; sql: string }[];
  createTable: { name: string; sql: string; warning: boolean }[];
  utf8: { hex: string; valid: boolean; display: string }[];
}

const vectors = JSON.parse(fs.readFileSync(new URL('../fixtures/migrateProtocol.json', import.meta.url), 'utf8')) as Vectors;

describe('the migration protocol, as the plugin speaks it', () => {
  it('signs every request the way the plugin checks it', () => {
    for (const v of vectors.signature) {
      const canonical = canonicalRequest(Number(v.importId), v.action, v.timestamp, v.nonce, Buffer.from(v.body, 'utf8'));
      expect(canonical, v.name).toBe(v.canonical);
      expect(`v1=${signRequest(v.token, canonical)}`, v.name).toBe(v.signature);
    }
  });

  it('takes every literal the plugin writes', () => {
    for (const v of vectors.literals) {
      const line = `INSERT INTO \`wp_t\` (\`c\`) VALUES (${v.sql});`;
      expect(() => checkSqlPage(`${line}\n`, 'wp_t', { first: false }), v.sql).not.toThrow();
    }
    // All of them in one row, and the row twice: as an INSERT line of several rows.
    const row = `(${vectors.literals.map((v) => v.sql).join(',')})`;
    const columns = vectors.literals.map((_, i) => `\`c${i}\``).join(',');
    expect(() => checkSqlPage(`INSERT INTO \`wp_t\` (${columns}) VALUES ${row},${row};\n`, 'wp_t', { first: false })).not.toThrow();
  });

  it('takes every CREATE TABLE the plugin writes', () => {
    for (const v of vectors.createTable) {
      const table = /^CREATE TABLE `([^`]+)`/.exec(v.sql)![1]!;
      const page = `DROP TABLE IF EXISTS \`${table}\`;\n${v.sql};\n`;
      const { lines } = checkSqlPage(page, table, { first: true });
      expect(lines, v.name).toHaveLength(2);
      expect(lines[1]!.includes('utf8mb4_0900_'), v.name).toBe(false);
    }
  });

  it('shows a name that is not UTF-8 the way the plugin does', () => {
    for (const v of vectors.utf8) {
      expect(Buffer.from(v.hex, 'hex').toString('utf8'), v.hex).toBe(v.display);
    }
  });
});
