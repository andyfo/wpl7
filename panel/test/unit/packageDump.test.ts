import { describe, expect, it } from 'vitest';
import { PackageDumpError, PackageDumpFilter, createdNames, dumpCharset, packageDumpPreamble, stripDefiners } from '../../src/services/packageDump.js';
import { BINARY, schemaSql, tableSql } from '../duplicatorFixtures.js';

/** The filter's output for `files`, fed `step` bytes at a time. */
function run(files: Buffer[], opts: { prefix?: string; step?: number } = {}) {
  const filter = new PackageDumpFilter(opts.prefix ?? 'wpd_');
  const parts: Buffer[] = [];
  for (const file of files) {
    const step = opts.step ?? file.length;
    for (let at = 0; at < file.length; at += step) parts.push(filter.push(file.subarray(at, at + step)));
    parts.push(filter.endFile());
  }
  return { filter, out: Buffer.concat(parts) };
}

const sql = (lines: string[]) => Buffer.from(`${lines.join('\n')}\n`, 'latin1');

describe("a package's dump, made fit for the site's own user", () => {
  it('passes rows through byte for byte, and rewrites only the statements around them', () => {
    const files = [schemaSql(), tableSql('wpd_', 'options'), tableSql('wpd_', 'posts')];
    const whole = run(files);
    // Fed a byte at a time it comes out the same.
    expect(run(files, { step: 1 }).out.equals(whole.out)).toBe(true);
    const text = whole.out.toString('latin1');
    // A row that says USE, DEFINER and a MySQL 8 collation is data, and stays as it is.
    expect(text).toContain('("2","blogname","USE other; DEFINER=`x`@`y` utf8mb4_0900_ai_ci stays");');
    expect(whole.out.includes(Buffer.concat([Buffer.from('raw bytes:', 'latin1'), BINARY]))).toBe(true);
    // The table's collation is one MariaDB before 11.4.5 knows; the view is the site user's.
    expect(text.split('COLLATE=utf8mb4_uca1400_nopad_ai_ci;').length - 1).toBe(1);
    expect(text.split('COLLATE=utf8mb4_unicode_520_ci;').length - 1).toBe(1);
    expect(text.replace('utf8mb4_0900_ai_ci stays', '')).not.toContain('0900');
    expect(text).toContain('CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `wpd_recent` AS select');
    expect(whole.filter).toMatchObject({ hasOptions: true, collationsChanged: true, definersRemoved: 1, dropped: 0 });
    // Every file ends on a line of its own: the next one's first statement starts clean.
    expect(text).toContain('/* DUPLICATOR_MYSQLDUMP_EOF */\n/* INSERT TABLE DATA: wpd_options */');
    // A statement runs over lines: the longest is at least the longest line.
    expect(whole.filter.longest).toBeGreaterThanOrEqual(Math.max(...files.flatMap((f) => f.toString('latin1').split('\n').map((l) => l.length))));
  });

  it('measures whole statements, as the database server takes them', () => {
    const insert = ['INSERT IGNORE INTO `wpd_posts` VALUES ', '(1,"a"),', '(2,"b");'];
    const { filter } = run([sql([...insert, '/* INSERT TABLE DATA: wpd_options */', 'CREATE TABLE `wpd_options` (', '  `a` int', ');'])], { step: 5 });
    // As the server gets it: without the IGNORE it loses on the way.
    expect(filter.longest).toBe(insert.join('\n').length - 'IGNORE '.length);
  });

  it("keeps a routine's strings and comments as they are, where a string runs over lines", () => {
    const { out, filter } = run(
      [
        sql([
          'DELIMITER ;;',
          'CREATE DEFINER=`root`@`localhost` PROCEDURE `wpd_p`()',
          'BEGIN',
          "  -- it's a comment, with a quote in it",
          "  SELECT 'first line",
          'utf8mb4_0900_ai_ci DEFINER=`x`@`y` on the second;;',
          "end' AS s;",
          '  /* utf8mb4_0900_ai_ci in a comment ;; */',
          '  SELECT `x` COLLATE utf8mb4_0900_ai_ci FROM `wpd_t`;',
          'END ;;',
          'DELIMITER ;',
          "CREATE TABLE `wpd_x` (`c` varchar(9) DEFAULT 'a;",
          "b' COLLATE utf8mb4_0900_ai_ci);",
          'CREATE TABLE `wpd_options` (`a` int);',
        ]),
      ],
      { step: 7 },
    );
    const text = out.toString('latin1');
    expect(text).toContain("  SELECT 'first line\nutf8mb4_0900_ai_ci DEFINER=`x`@`y` on the second;;\nend' AS s;");
    expect(text).toContain('  /* utf8mb4_0900_ai_ci in a comment ;; */');
    expect(text).toContain('  SELECT `x` COLLATE utf8mb4_uca1400_nopad_ai_ci FROM `wpd_t`;');
    expect(text).toContain('CREATE PROCEDURE `wpd_p`()');
    // A line that ends in a string is not the statement's end.
    expect(text).toContain("CREATE TABLE `wpd_x` (`c` varchar(9) DEFAULT 'a;\nb' COLLATE utf8mb4_uca1400_nopad_ai_ci);");
    expect(filter).toMatchObject({ definersRemoved: 1, hasOptions: true });
  });

  it('passes a long row on as it arrives, never holding it whole', () => {
    const filter = new PackageDumpFilter('wpd_');
    const head = Buffer.from('INSERT INTO `wpd_posts` VALUES ("');
    const piece = Buffer.alloc(1024 * 1024, 0x61);
    let out = filter.push(head).length;
    for (let i = 0; i < 8; i++) out += filter.push(piece).length;
    // All of it went on before the row ended.
    expect(out).toBe(head.length + 8 * piece.length);
    out += filter.push(Buffer.from('");\n')).length + filter.endFile().length;
    expect(out).toBe(head.length + 8 * piece.length + 4);
    expect(filter.longest).toBe(head.length + 8 * piece.length + 3);
    // A row whose end is out of sight is refused rather than guessed at.
    const blank = new PackageDumpFilter('wpd_');
    blank.push(Buffer.from(`INSERT INTO \`wpd_posts\` VALUES ("${'a'.repeat(5000)}");`));
    expect(() => blank.push(Buffer.concat([Buffer.alloc(5000, 0x20), Buffer.from('\n')]))).toThrow(/blank space/);
  });

  it('loads a dump in the character set WordPress wrote it in, if the filter reads that set safely', () => {
    expect(dumpCharset('utf8')).toBe('utf8mb4');
    expect(dumpCharset('UTF8MB4')).toBe('utf8mb4');
    expect(dumpCharset('cp1250')).toBe('cp1250');
    expect(dumpCharset('sjis')).toBeNull();
    expect(packageDumpPreamble('cp1250')).toMatch(/^SET NAMES cp1250;\n/);
    expect(() => packageDumpPreamble('latin1; DROP TABLE x')).toThrow(PackageDumpError);
  });

  it("takes the definer out of mysqldump's views and triggers, and out of routines, whatever their body says", () => {
    const { out, filter } = run([
      sql([
        '/*M!999999\\- enable the sandbox mode */ ',
        '/*!50001 CREATE ALGORITHM=UNDEFINED */',
        '/*!50013 DEFINER=`wp`@`%` SQL SECURITY DEFINER */',
        '/*!50001 VIEW `wpd_v` AS select 1 AS `a` */;',
        'DELIMITER ;;',
        '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `t` BEFORE INSERT ON `wpd_posts` FOR EACH ROW SET NEW.ID = NEW.ID */;;',
        "CREATE DEFINER='root'@'localhost' PROCEDURE `p`()",
        'BEGIN',
        "  SELECT 'DEFINER=`kept`@`kept`';",
        '  SELECT 2;',
        'END ;;',
        'DELIMITER ;',
        'CREATE TABLE `wpd_options` (`a` int);',
      ]),
    ]);
    const text = out.toString('latin1');
    expect(text).toContain('/*!50013 SQL SECURITY DEFINER */');
    expect(text).toContain('/*!50003 CREATE*/ /*!50017 */ /*!50003 TRIGGER');
    expect(text).toContain('CREATE PROCEDURE `p`()');
    expect(text).toContain("  SELECT 'DEFINER=`kept`@`kept`';");
    expect(filter.definersRemoved).toBe(3);
    expect(filter.hasOptions).toBe(true);
  });

  it('drops what sets the old server itself, and refuses a dump that would load elsewhere', () => {
    const { out, filter } = run([
      sql([
        'SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;',
        'SET @@SESSION.SQL_LOG_BIN= 0;',
        "SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '3E11FA47-71CA-11E1-9E33-C80AA9429562:1-5';",
        'CREATE TABLE `wpd_options` (`a` int);',
      ]),
    ]);
    expect(out.toString('latin1')).not.toMatch(/SQL_LOG_BIN= 0|GTID_PURGED/);
    expect(out.toString('latin1')).toContain('SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;');
    expect(filter.dropped).toBe(2);
    expect(() => run([sql(['USE `wp_other`;'])])).toThrow(PackageDumpError);
    expect(() => run([sql(['/*!40000 CREATE DATABASE `x` */;'])])).toThrow(/database of its own/);
    expect(() => run([sql(['/* moved */ USE `wp_other`;'])])).toThrow(/switches to another database/);
  });

  it("says when no table of the site's prefix holds its options", () => {
    expect(run([schemaSql('wpd_')], { prefix: 'wp_' }).filter.hasOptions).toBe(false);
    expect(run([schemaSql('wp_')], { prefix: 'wp_' }).filter.hasOptions).toBe(true);
  });

  it('reads a statement to its end across Windows line breaks', () => {
    const { out } = run([Buffer.from("INSERT INTO `t` VALUES\r\n(1,'a'),\r\n(2,'b');\r\nCREATE TABLE `x` (`c` varchar(1) COLLATE utf8mb4_0900_ai_ci);\r\n", 'latin1')]);
    expect(out.toString('latin1')).toContain('COLLATE utf8mb4_uca1400_nopad_ai_ci);\r\n');
  });

  it('takes a long row in small pieces without copying it over and over', () => {
    const row = Buffer.alloc(32 * 1024 * 1024, 0x61);
    const dump = Buffer.concat([Buffer.from('INSERT INTO `wpd_posts` VALUES\n("'), row, Buffer.from('");\nCREATE TABLE `wpd_options` (`a` int);\n')]);
    const started = Date.now();
    const { out, filter } = run([dump], { step: 16 * 1024 });
    // Linear, even on a busy machine: copying the line over and over would take minutes.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(out.equals(dump)).toBe(true);
    expect(filter.hasOptions).toBe(true);
  });

  it('starts every file afresh: an unended statement or DELIMITER stays in its own file', () => {
    const { out, filter } = run([sql(['DELIMITER ;;', 'CREATE DEFINER=`a`@`b` PROCEDURE `p`() SELECT 1']), sql(['CREATE TABLE `wpd_options` (`a` varchar(1) COLLATE utf8mb4_0900_ai_ci);'])]);
    expect(out.toString('latin1')).toContain('COLLATE utf8mb4_uca1400_nopad_ai_ci);');
    expect(filter.hasOptions).toBe(true);
  });

  it('loads every row or fails: INSERT IGNORE and REPLACE become INSERT, whatever the length of the row', () => {
    const lines = ['INSERT IGNORE INTO `wpd_options` VALUES ', '("1","a","b"),', '("2","c","d");', 'REPLACE INTO `wpd_posts` VALUES (1);', 'INSERT LOW_PRIORITY IGNORE INTO `wpd_posts` VALUES (2);'];
    const { out } = run([sql([...lines, 'CREATE TABLE `wpd_options` (`a` int);'])], { step: 3 });
    expect(out.toString('latin1')).toContain('INSERT INTO `wpd_options` VALUES \n("1","a","b"),\n("2","c","d");\nINSERT INTO `wpd_posts` VALUES (1);\nINSERT INTO `wpd_posts` VALUES (2);');
    // A row too long to hold, passed on as it arrives: its first words change all the same.
    const long = Buffer.concat([Buffer.from('INSERT IGNORE INTO `wpd_posts` VALUES ("'), Buffer.alloc(64 * 1024, 0x61), Buffer.from('");\n')]);
    const streamed = run([long], { step: 1000 }).out;
    expect(streamed.subarray(0, 40).toString('latin1')).toBe('INSERT INTO `wpd_posts` VALUES ("aaaaaaa');
    expect(streamed.length).toBe(long.length - 'IGNORE '.length);
    // The words of a row are never changed.
    expect(run([sql(['INSERT INTO `wpd_posts` VALUES ("REPLACE INTO x"),', '("INSERT IGNORE");'])]).out.toString('latin1')).toContain('("REPLACE INTO x"),\n("INSERT IGNORE");');
  });

  it('knows the tables, views, columns and routines the dump creates, by their names in its own character set', () => {
    const { filter } = run([
      Buffer.concat([
        sql([
          'CREATE TABLE IF NOT EXISTS `wpd_options` (`option_id` int, `option_name` varchar(9), PRIMARY KEY (`option_id`), KEY `name` (`option_name`));',
          '/*!50001 CREATE ALGORITHM=UNDEFINED */',
          '/*!50013 DEFINER=`wp`@`%` SQL SECURITY DEFINER */',
          '/*!50001 VIEW `wpd_recent` AS select `wpd_options`.`option_id` AS `recent_id` */;',
          'DELIMITER ;;',
          'CREATE DEFINER=`wp`@`%` PROCEDURE `log_change`() BEGIN CREATE TABLE `made_later` (`a` int); END ;;',
          'DELIMITER ;',
        ]),
        // A UTF-8 table name, as its bytes come.
        Buffer.from('CREATE TABLE `wpd_café` (`prix` int);\n', 'utf8'),
      ]),
    ]);
    expect([...filter.tables].sort()).toEqual(['wpd_café', 'wpd_options', 'wpd_recent']);
    expect([...filter.columns].sort()).toEqual(['option_id', 'option_name', 'prix', 'recent_id']);
    expect([...filter.routines]).toEqual(['log_change']);
    expect(createdNames('CREATE OR REPLACE VIEW `site`.`v2` AS SELECT 1 AS `one`')).toEqual({ kind: 'view', name: 'v2', columns: ['one'] });
    expect(createdNames('INSERT INTO `t` VALUES ("CREATE TABLE x")')).toBeNull();
    // Read as latin1, a latin1 dump's names are its own.
    const latin1 = new PackageDumpFilter('wpd_', 'latin1');
    latin1.push(Buffer.from([...Buffer.from('CREATE TABLE `wpd_caf'), 0xe9, ...Buffer.from('` (`a` int);\n')]));
    expect([...latin1.tables]).toEqual(['wpd_café']);
  });

  it('turns unique checks on where the dump turns them off: InnoDB would take a duplicate into a unique index unnoticed', () => {
    const { out } = run([sql(['/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;', 'SET @@SESSION.unique_checks = 0;', '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;'])]);
    expect(out.toString('latin1')).toBe('/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=1 */;\nSET @@SESSION.unique_checks=1;\n/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n');
    expect(packageDumpPreamble('utf8mb4')).not.toMatch(/UNIQUE_CHECKS/i);
    // Only there: in a routine, unique_checks = 0 is the routine's own question, left as it is.
    const routine = ['DELIMITER ;;', 'CREATE FUNCTION `checks_off`() RETURNS INT DETERMINISTIC RETURN @@SESSION.unique_checks = 0 ;;', 'DELIMITER ;'];
    expect(run([sql(routine)]).out.toString('latin1')).toContain('RETURN @@SESSION.unique_checks = 0 ;;');
  });

  it('strips a definer outside quoted strings only', () => {
    expect(stripDefiners('CREATE DEFINER=`a`@`%` VIEW v AS SELECT \'DEFINER=`b`@`c`\' AS x')).toEqual({
      line: "CREATE VIEW v AS SELECT 'DEFINER=`b`@`c`' AS x",
      removed: 1,
    });
    expect(stripDefiners('CREATE DEFINER = CURRENT_USER VIEW v AS SELECT 1').removed).toBe(0);
  });
});
