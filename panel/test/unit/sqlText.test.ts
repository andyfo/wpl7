import { describe, expect, it } from 'vitest';
import { buildKeyCondition, buildWhere, escapeLike, formatSql, quoteIdent, splitStatements } from '../../src/lib/sqlText.js';
import { columnKind, toCell } from '../../src/services/dbBrowser.js';
import { parseBatchLine, parseInventory, quoteDbObject } from '../../src/services/dbAdmin.js';

describe('SQL text the database browser builds', () => {
  it('quotes names, doubling a backtick in them', () => {
    expect(quoteIdent('wp_options')).toBe('`wp_options`');
    expect(quoteIdent('we`ird')).toBe('`we``ird`');
    expect(() => quoteIdent('a\u0000b')).toThrow(/NUL/);
    expect(quoteDbObject('old-shop')).toBe('`old-shop`');
    expect(() => quoteDbObject('a/b')).toThrow();
    expect(() => quoteDbObject('a.b')).toThrow();
  });

  it('takes % and _ literally in a LIKE pattern', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\');
  });

  it('builds a filter as placeholders, and refuses a column the table does not have', () => {
    const cols = new Set(['option_name', 'option_value', 'autoload']);
    const where = buildWhere(
      [
        { column: 'option_name', op: 'startsWith', value: 'wp_' },
        { column: 'option_value', op: 'notContains', value: '50%' },
        { column: 'autoload', op: 'ne', value: 'no' },
        { column: 'option_value', op: 'isNull' },
      ],
      cols,
    );
    expect(where.sql).toBe('WHERE `option_name` LIKE ? AND `option_value` NOT LIKE ? AND `autoload` <> ? AND `option_value` IS NULL');
    expect(where.values).toEqual(['wp\\_%', '%50\\%%', 'no']);
    expect(formatSql(`SELECT * FROM t ${where.sql}`, where.values)).toBe(
      "SELECT * FROM t WHERE `option_name` LIKE 'wp\\\\_%' AND `option_value` NOT LIKE '%50\\\\%%' AND `autoload` <> 'no' AND `option_value` IS NULL",
    );
    expect(buildWhere([], cols)).toEqual({ sql: '', values: [] });
    expect(() => buildWhere([{ column: 'nope', op: 'eq', value: '1' }], cols)).toThrow(/no column "nope"/);
  });

  it('matches any of the filters, a list of values, and any column', () => {
    const cols = new Set(['id', 'title', 'body', 'data']);
    const anyColumns = ['id', 'title', 'body'];
    const where = buildWhere(
      [
        { column: 'id', op: 'in', value: '1, 2,3' },
        { column: '*', op: 'contains', value: 'shop' },
      ],
      cols,
      { match: 'any', anyColumns },
    );
    expect(where.sql).toBe(
      'WHERE (`id` IN (?, ?, ?)) OR ((CAST(`id` AS CHAR) LIKE ? OR CAST(`title` AS CHAR) LIKE ? OR CAST(`body` AS CHAR) LIKE ?))',
    );
    expect(where.values).toEqual(['1', '2', '3', '%shop%', '%shop%', '%shop%']);
    // A negative comparison on any column: no column may match, a NULL one counting as no match.
    expect(buildWhere([{ column: '*', op: 'notContains', value: 'x' }], cols, { anyColumns }).sql).toBe(
      'WHERE NOT (COALESCE(CAST(`id` AS CHAR) LIKE ?, 0) OR COALESCE(CAST(`title` AS CHAR) LIKE ?, 0) OR COALESCE(CAST(`body` AS CHAR) LIKE ?, 0))',
    );
    // Empty items in a list are left out; a list of nothing is refused.
    expect(buildWhere([{ column: 'id', op: 'in', value: '12, 15,' }], cols).values).toEqual(['12', '15']);
    expect(() => buildWhere([{ column: 'id', op: 'in', value: ' , ' }], cols)).toThrow(/at least one value/);
    expect(buildWhere([{ column: 'id', op: 'notIn', value: '7' }], cols).sql).toBe('WHERE `id` NOT IN (?)');
    expect(() => buildWhere([{ column: '*', op: 'lt', value: '3' }], cols, { anyColumns })).toThrow(/Pick a column/);
    expect(() => buildWhere([{ column: 'id', op: 'in', value: Array(101).fill('1').join(',') }], cols)).toThrow(/at most 100/);
    // One filter: "any" changes nothing.
    expect(buildWhere([{ column: 'id', op: 'eq', value: '1' }], cols, { match: 'any' }).sql).toBe('WHERE `id` = ?');
  });

  it('finds a row by exactly its key columns, NULL-safe', () => {
    expect(buildKeyCondition({ a: '1', b: null }, ['a', 'b'])).toEqual({ sql: '`a` <=> ? AND `b` <=> ?', values: ['1', null] });
    expect(() => buildKeyCondition({ a: '1' }, ['a', 'b'])).toThrow(/send exactly those/);
    expect(() => buildKeyCondition({ a: '1', c: '2' }, ['a'])).toThrow();
  });
});

describe('splitting SQL into statements', () => {
  it('splits on ; outside strings, names and comments', () => {
    expect(
      splitStatements(`SELECT 'a;b', "c;d", \`e;f\` FROM t; -- not; here
UPDATE t SET x = 'it''s; fine' /* a; comment */ WHERE y = 'back\\'slash;';
# a comment; only
SELECT 1`),
    ).toEqual([
      "SELECT 'a;b', \"c;d\", `e;f` FROM t",
      "-- not; here\nUPDATE t SET x = 'it''s; fine' /* a; comment */ WHERE y = 'back\\'slash;'",
      '# a comment; only\nSELECT 1',
    ]);
  });

  it('drops what is only comments and space, and keeps executable comments', () => {
    expect(splitStatements('-- nothing\n/* at all */ ;  ;')).toEqual([]);
    expect(splitStatements('/*!40101 SET NAMES utf8mb4 */;')).toEqual(['/*!40101 SET NAMES utf8mb4 */']);
    expect(splitStatements('--x not a comment without a space;')).toEqual(['--x not a comment without a space']);
  });

  it('follows DELIMITER lines, as dumps with triggers write them', () => {
    const dump = `SET @a = 1;
DELIMITER ;;
CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END ;;
DELIMITER ;
SELECT 2;`;
    expect(splitStatements(dump)).toEqual([
      'SET @a = 1',
      'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END',
      'SELECT 2',
    ]);
  });

  it('copes with a statement of a million characters without rescanning it', () => {
    const big = `INSERT INTO t VALUES ${Array.from({ length: 50_000 }, (_, i) => `(${i},'x')`).join(',\n')}`;
    const started = Date.now();
    expect(splitStatements(`${big};SELECT 1`)).toHaveLength(2);
    // Linear is well under a second; rescanning would take minutes. The margin is for a busy machine.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe('what the browser shows', () => {
  it('names a column’s kind from its type', () => {
    expect(['bigint', 'decimal', 'year'].map(columnKind)).toEqual(['number', 'number', 'number']);
    expect(['datetime', 'timestamp'].map(columnKind)).toEqual(['date', 'date']);
    expect(['longtext', 'varchar', 'enum'].map(columnKind)).toEqual(['text', 'text', 'text']);
    expect(['longblob', 'varbinary'].map(columnKind)).toEqual(['binary', 'binary']);
    expect(columnKind('geometry')).toBe('other');
  });

  it('turns values into cells: text, NULL, bytes described, long text cut', () => {
    expect(toCell(null)).toBeNull();
    expect(toCell(42)).toBe('42');
    expect(toCell('18446744073709551615')).toBe('18446744073709551615');
    expect(toCell(Buffer.from([0, 255]))).toEqual({ binary: 2, hex: '00ff' });
    expect(toCell({ a: 1 })).toBe('{"a":1}');
    expect(toCell('x'.repeat(1500))).toEqual({ cut: 'x'.repeat(1000), length: 1500 });
  });
});

describe("reading the mariadb client's batch output", () => {
  it('undoes its escapes', () => {
    expect(parseBatchLine('a\\tb\tc\\\\d\te\\nf')).toEqual(['a\tb', 'c\\d', 'e\nf']);
  });

  it('reads the inventory', () => {
    expect(parseInventory('wp_shop\tutf8mb4_unicode_ci\t12\t1638400\nempty\tNULL\t0\t0\n')).toEqual([
      { name: 'wp_shop', collation: 'utf8mb4_unicode_ci', tables: 12, bytes: 1638400 },
      { name: 'empty', collation: null, tables: 0, bytes: 0 },
    ]);
  });
});
