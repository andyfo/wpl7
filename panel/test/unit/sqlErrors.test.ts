import { describe, expect, it } from 'vitest';
import { redactSqlError } from '../../src/lib/sqlErrors.js';

/** What the MariaDB 11.4 client writes to stderr when a statement fails: the statement, then the error. */
const failed = (statement: string, error: string) => `--------------\n${statement}\n--------------\n\n${error}\n`;

describe("a database client's error, without the site's data or the panel's secrets in it", () => {
  it('leaves out the statement the client repeats, and the values its error quotes', () => {
    expect(
      redactSqlError(failed("INSERT INTO u VALUES\n('gina-secret',1,NULL),\n('gina-secret',2,NULL)", "ERROR 1062 (23000) at line 1: Duplicate entry 'gina-secret' for key 'PRIMARY'")),
    ).toBe("ERROR 1062 (23000) at line 1: Duplicate entry '…' for key 'PRIMARY'");
    expect(redactSqlError("ERROR 1062 (23000) at line 42: Duplicate entry 'o'brien@example.com' for key 'user_email'")).toBe(
      "ERROR 1062 (23000) at line 42: Duplicate entry '…' for key 'user_email'",
    );
    expect(
      redactSqlError(failed("INSERT INTO u VALUES ('hank-secret',1,NULL) oops", "ERROR 1064 (42000) at line 1: You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'oops' at line 3")),
    ).toBe("ERROR 1064 (42000) at line 1: You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '…' at line 3");
    expect(redactSqlError("ERROR 1366 (22007) at line 1: Incorrect integer value: 'card 4111 1111' for column `t`.`u`.`n` at row 1")).toBe(
      "ERROR 1366 (22007) at line 1: Incorrect integer value: '…' for column `t`.`u`.`n` at row 1",
    );
    expect(redactSqlError("ERROR 1292 (22007) at line 3: Truncated incorrect INTEGER value: 'card 4111'")).toBe("ERROR 1292 (22007) at line 3: Truncated incorrect INTEGER value: '…'");
  });

  it('keeps what names things: tables, columns, keys, users, clauses', () => {
    expect(redactSqlError("ERROR 1146 (42S02) at line 1: Table 'site.wp_x' doesn't exist")).toBe("ERROR 1146 (42S02) at line 1: Table 'site.wp_x' doesn't exist");
    expect(redactSqlError(failed("INSERT INTO u (k, nope) VALUES ('erin-secret', 1)", "ERROR 1054 (42S22) at line 1: Unknown column 'nope' in 'INSERT INTO'"))).toBe(
      "ERROR 1054 (42S22) at line 1: Unknown column 'nope' in 'INSERT INTO'",
    );
    expect(redactSqlError("ERROR 1406 (22001) at line 1: Data too long for column 'k' at row 1")).toBe("ERROR 1406 (22001) at line 1: Data too long for column 'k' at row 1");
  });

  it("never passes on a password of the panel's own statements", () => {
    const out = redactSqlError(failed("CREATE USER 'x'@'%' IDENTIFIED BY 'hunter2-secret'", "ERROR 1396 (HY000) at line 1: Operation CREATE USER failed for 'x'@'%'"));
    expect(out).toBe("ERROR 1396 (HY000) at line 1: Operation CREATE USER failed for 'x'@'%'");
    expect(out).not.toContain('hunter2');
  });

  it("shows no words a trigger or routine raised itself, under whatever code and state", () => {
    const NOT_SHOWN = '(not shown, as it can hold the site’s data)';
    expect(redactSqlError('ERROR 1644 (45000) at line 2: blocked frank-private')).toBe(`ERROR 1644 (45000) at line 2: ${NOT_SHOWN}`);
    // SIGNAL SQLSTATE '23000' SET MESSAGE_TEXT = CONCAT('dup ', NEW.email): a state of the server's own, SIGNAL's code.
    expect(redactSqlError('ERROR 1644 (23000) at line 5: dup alice@example.com')).toBe(`ERROR 1644 (23000) at line 5: ${NOT_SHOWN}`);
    // … SET MYSQL_ERRNO = 1062 as well: words that are not MariaDB's message for 1062.
    expect(redactSqlError('ERROR 1062 (23000) at line 5: dup alice@example.com')).toBe(`ERROR 1062 (23000) at line 5: ${NOT_SHOWN}`);
    expect(redactSqlError("ERROR 9999 (HY000): Something about 'a' and 'b's value' here")).toBe(`ERROR 9999 (HY000): ${NOT_SHOWN}`);
    expect(redactSqlError("ERROR 1690 (22003) at line 4: BIGINT UNSIGNED value is out of range in '`t`.`n` - 4111'")).toBe("ERROR 1690 (22003) at line 4: BIGINT UNSIGNED value is out of range in '…'");
  });

  it('keeps the lines of the tools around it, which quote nothing; says so when nothing is left', () => {
    expect(redactSqlError('gzip: /work/db.sql.gz: unexpected end of file\n')).toBe('gzip: /work/db.sql.gz: unexpected end of file');
    expect(redactSqlError("some line the client wrote with 'a value'\n")).toBe('(the database server’s words are left out, as they can hold the site’s data)');
  });
});
