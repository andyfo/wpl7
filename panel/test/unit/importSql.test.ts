import { describe, expect, it } from 'vitest';
import { checkSqlPage, rewriteCollations } from '../../src/services/importSql.js';

const T = 'wpx_options';
const DROP = 'DROP TABLE IF EXISTS `wpx_options`;';
const CREATE =
  "CREATE TABLE `wpx_options` ( `option_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT, `option_name` varchar(191) NOT NULL DEFAULT '', " +
  "`option_value` longtext NOT NULL, `autoload` varchar(20) NOT NULL DEFAULT 'yes', PRIMARY KEY (`option_id`), UNIQUE KEY `option_name` (`option_name`) " +
  ') ENGINE=InnoDB AUTO_INCREMENT=812 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;';
const INSERT =
  "INSERT INTO `wpx_options` (`option_id`,`option_name`,`option_value`,`autoload`) VALUES " +
  "(1,'siteurl','https://willow-pediatrics.example','yes'),(2,'blogname','Willow\\'s; Pediatrics','yes')," +
  "(3,'empty','','no'),(4,'quotes','It''s \\\\ fine',NULL),(5,'bin',X'00ff10','yes'),(6,'num',-1.5e3,'no');";

const page = (...lines: string[]) => `${lines.join('\n')}\n`;
const refused = (sql: string, first = false) => () => checkSqlPage(sql, T, { first });

describe('the SQL an import accepts', () => {
  it('takes the grammar the plugin writes', () => {
    expect(checkSqlPage(page(DROP, CREATE, INSERT), T, { first: true })).toEqual({ lines: [DROP, CREATE, INSERT], collations: false });
    expect(checkSqlPage(page(INSERT, INSERT), T, { first: false }).lines).toHaveLength(2);
  });

  it('rewrites MySQL 8 collations, and only outside quotes', () => {
    const mysql8 = CREATE.replace('utf8mb4_unicode_520_ci', 'utf8mb4_0900_ai_ci').replace(
      "DEFAULT 'yes'",
      "DEFAULT 'utf8mb4_0900_ai_ci' COLLATE utf8mb4_0900_bin",
    );
    const { lines, collations } = checkSqlPage(page(DROP, mysql8), T, { first: true });
    expect(collations).toBe(true);
    expect(lines[1]).toContain("DEFAULT 'utf8mb4_0900_ai_ci' COLLATE utf8mb4_bin");
    expect(lines[1]).toContain('COLLATE=utf8mb4_unicode_520_ci;');
    expect(rewriteCollations('COLLATE utf8mb4_de_pb_0900_ai_ci')).toEqual({ line: 'COLLATE utf8mb4_unicode_520_ci', changed: true });
  });

  it.each([
    ['a second statement', `${INSERT} DROP DATABASE wp_other;`],
    ['a statement after a semicolon in place of a value', "INSERT INTO `wpx_options` (`a`) VALUES (1);DROP TABLE `wpx_users`;"],
    ['an expression for a value', 'INSERT INTO `wpx_options` (`a`) VALUES ((SELECT password FROM wpx_users));'],
    ['a function for a value', 'INSERT INTO `wpx_options` (`a`) VALUES (LOAD_FILE(\'/etc/passwd\'));'],
    ['another table', 'INSERT INTO `wpx_users` (`a`) VALUES (1);'],
    ['a string that never closes', "INSERT INTO `wpx_options` (`a`) VALUES ('abc\\');"],
    ['an odd hex literal', "INSERT INTO `wpx_options` (`a`) VALUES (X'abc');"],
    ['a comment', 'INSERT INTO `wpx_options` (`a`) VALUES (1); -- x'],
    ['an unquoted column', 'INSERT INTO `wpx_options` (a) VALUES (1);'],
    ['an UPDATE', "UPDATE `wpx_options` SET `option_value`='x';"],
    ['a SET', 'SET GLOBAL general_log=1;'],
  ])('refuses %s', (_what, line) => {
    expect(refused(page(line))).toThrow(/Refused SQL from the old site/);
  });

  it.each([
    ['a DEFINER', CREATE.replace(') ENGINE', ') DEFINER=`root`@`%` ENGINE')],
    ['a DATA DIRECTORY', CREATE.replace(') ENGINE', ") DATA DIRECTORY='/var/lib/mysql/wp_other' ENGINE")],
    ['a FEDERATED table', CREATE.replace('ENGINE=InnoDB', 'ENGINE=FEDERATED')],
    ['a CONNECT table', CREATE.replace('ENGINE=InnoDB', 'ENGINE = CONNECT')],
    ['a versioned comment', CREATE.replace(') ENGINE', ') /*!50100 PARTITION BY HASH (`option_id`) */ ENGINE')],
    ['CREATE … SELECT', CREATE.replace(';', ' SELECT * FROM `wp_other`.`wp_users`;')],
    ['a second statement', CREATE.replace(';', '; DROP DATABASE `wp_other`;')],
  ])('refuses a CREATE TABLE with %s', (_what, create) => {
    expect(refused(page(DROP, create), true)).toThrow(/Refused SQL from the old site/);
  });

  it('lets the forbidden words through inside quotes', () => {
    const quoted = CREATE.replace("DEFAULT ''", "DEFAULT 'DEFINER; DATA DIRECTORY /* SELECT'");
    expect(checkSqlPage(page(DROP, quoted), T, { first: true }).lines[1]).toBe(quoted);
  });

  it('needs the DROP and the CREATE on a first page, and only INSERTs after it', () => {
    expect(refused(page(INSERT), true)).toThrow(/DROP TABLE IF EXISTS/);
    expect(refused(page(DROP, INSERT), true)).toThrow(/CREATE TABLE/);
    expect(refused(page(DROP), false)).toThrow(/INSERT INTO/);
    expect(refused(page('DROP TABLE IF EXISTS `wpx_users`;', CREATE), true)).toThrow(/another table/);
  });
});
