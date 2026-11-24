import { describe, expect, it } from 'vitest';
import { checkTrigger, inspectTrigger, unknownNames, type SiteNames } from '../../src/services/packageTriggers.js';

const trigger = (body: string, on = '`wp_posts`', event = 'AFTER INSERT') =>
  `DELIMITER ;;\nCREATE DEFINER=\`old\`@\`localhost\` TRIGGER \`t\` ${event} ON ${on} FOR EACH ROW ${body};;\nDELIMITER ;`;
const SITE: SiteNames = {
  tables: new Set(['wp_posts', 'wp_postmeta', 'wp_log', 'wp_recent', 'wp_café']),
  columns: new Set(['ID', 'post_title', 'post_id', 'meta_key', 'meta_value', 'x', 'note', 'hits', 'at']),
  routines: new Set(['log_change']),
};
const check = (body: string, on?: string) => checkTrigger(trigger(body, on), SITE);
const unknown = (body: string, on?: string) => unknownNames(trigger(body, on), SITE);

describe("a trigger, added only when the site has all it names", () => {
  it('leaves out one that reaches a table the site has not, wherever it stands: MariaDB takes it, then fails every write', () => {
    // After a derived table, in a comma join: the case a reading of the table places misses.
    expect(check('INSERT INTO wp_log SELECT d.x FROM (SELECT 1 AS x) d, wp_missing')).toEqual(["names wp_missing, which the site's database does not have"]);
    expect(unknown('INSERT INTO wp_excluded (x) VALUES (NEW.ID)')).toEqual(['wp_excluded']);
    expect(unknown('SET @n = 1', '`wp_excluded`')).toEqual(['wp_excluded']);
    // MariaDB on Linux tells WP_LOG from wp_log.
    expect(unknown('INSERT INTO WP_LOG VALUES (NEW.ID)')).toEqual(['WP_LOG']);
    // A column it uses, a routine it calls: the same, as each fails the write.
    expect(unknown('SET NEW.post_title = gone_column')).toEqual(['gone_column']);
    expect(unknown('CALL missing_routine(NEW.ID)')).toEqual(['missing_routine']);
    expect(unknown('SET NEW.x = missing_function(1)')).toEqual(['missing_function']);
  });

  it('reads any word where a table stands as a table, a keyword such as events too', () => {
    // MariaDB takes events as a table; with the package's events left out, every write to wp_posts fails.
    expect(check('INSERT INTO events (x) VALUES (NEW.ID)')).toEqual(["names events, which the site's database does not have"]);
    for (const body of [
      'INSERT events VALUES (NEW.ID)',
      'REPLACE INTO status VALUES (NEW.ID)',
      'UPDATE events SET x = 1',
      'DELETE FROM events WHERE x = OLD.ID',
      'SET @n = (SELECT COUNT(*) FROM wp_log JOIN events ON events.x = wp_log.x)',
      'SET @n = (SELECT COUNT(*) FROM wp_log, events)',
      'SET @n = (SELECT COUNT(*) FROM (events JOIN wp_log))',
      'DELETE FROM wp_log USING wp_log, events',
    ]) {
      expect(unknown(body), body).toContain(body.includes('status') ? 'status' : 'events');
    }
    // A routine after CALL, too.
    expect(unknown('CALL events()')).toEqual(['events']);
    // With the table there, it is added; and a subquery's name stands where a table does.
    const withEvents: SiteNames = { ...SITE, tables: new Set([...SITE.tables, 'events']) };
    expect(checkTrigger(trigger('INSERT INTO events (x) VALUES (NEW.ID)'), withEvents)).toEqual([]);
    expect(check('SET NEW.x = (WITH events AS (SELECT 1 AS x) SELECT x FROM events)')).toEqual([]);
  });

  it('reads on past a derived table or JSON_TABLE in a list of tables, and into the derived table too', () => {
    // MariaDB installs it with events left out of the package, then refuses every insert into wp_posts.
    expect(check('INSERT INTO wp_log SELECT d.id FROM (SELECT 1 AS id) AS d, events')).toEqual(["names events, which the site's database does not have"]);
    expect(unknown('INSERT INTO wp_log SELECT d.id FROM (SELECT 1 AS id) d, events')).toEqual(['events']);
    expect(unknown("SET @n = (SELECT COUNT(*) FROM JSON_TABLE('[1]', '$[*]' COLUMNS (v INT PATH '$')) AS jt, events)")).toContain('events');
    expect(unknown('SET @n = (SELECT COUNT(*) FROM (SELECT x FROM events) AS d)')).toEqual(['events']);
    expect(unknown('SET @n = (SELECT COUNT(*) FROM (SELECT x FROM wp_log) AS d JOIN events ON events.x = d.x)')).toEqual(['events']);
    expect(check('SET @n = (SELECT COUNT(*) FROM (SELECT x FROM wp_log) AS d, wp_postmeta)')).toEqual([]);
  });

  it('goes on with a list of tables at its comma, whatever came before it: a join and its condition, a hint', () => {
    // MariaDB installs it with events left out of the package, then refuses the next post's insert.
    expect(check('SET @n = (SELECT COUNT(*) FROM wp_log l JOIN wp_posts p ON p.ID = l.x, events)')).toEqual(["names events, which the site's database does not have"]);
    for (const body of [
      'SET @n = (SELECT COUNT(*) FROM wp_log l LEFT JOIN wp_postmeta pm USING (post_id), events)',
      'SET @n = (SELECT COUNT(*) FROM wp_log FORCE INDEX (PRIMARY), events)',
      'UPDATE wp_log l JOIN wp_postmeta pm ON pm.post_id = l.x, events SET l.note = 1',
      'DELETE FROM l USING wp_log l JOIN wp_postmeta pm ON pm.post_id = l.x, events',
      'INSERT INTO wp_log SELECT x FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id = p.ID AND FIELD(pm.meta_key, 1, 2), events',
    ]) {
      expect(unknown(body), body).toEqual(['events']);
    }
    // And no further: what follows the tables' clause is no table.
    expect(check('SET @n = (SELECT COUNT(*) FROM wp_log l JOIN wp_postmeta pm ON pm.post_id = l.x WHERE l.x IN (1, 2) GROUP BY l.x, l.note)')).toEqual([]);
    expect(check('INSERT INTO wp_log (x) SELECT ID FROM wp_posts ON DUPLICATE KEY UPDATE hits = hits + 1, note = 2')).toEqual([]);
    expect(check('UPDATE wp_log l, wp_postmeta pm SET l.x = 1, pm.meta_value = 2 WHERE pm.post_id = l.x')).toEqual([]);
    expect(check('SET @a = (SELECT x FROM wp_log LIMIT 1), @b = (SELECT post_id FROM wp_postmeta LIMIT 1)')).toEqual([]);
  });

  it("takes the columns JSON_TABLE declares as its own, nested ones too", () => {
    const json =
      "SET @n = (SELECT COUNT(*) FROM JSON_TABLE(NEW.note, '$[*]' COLUMNS (v INT PATH '$.v', n FOR ORDINALITY, " +
      "NESTED PATH '$.tags[*]' COLUMNS (tag VARCHAR(20) PATH '$'))) AS jt WHERE v > 1 AND jt.tag <> '' AND n < 3)";
    expect(check(json)).toEqual([]);
  });

  it('reads DELETE FROM targets USING tables: the targets name the tables or aliases of the USING list', () => {
    expect(check('DELETE FROM l USING wp_log AS l WHERE l.x = OLD.ID')).toEqual([]);
    expect(check('DELETE FROM l USING wp_log l WHERE l.x = OLD.ID')).toEqual([]);
    expect(check('DELETE FROM wp_log.*, pm USING wp_log JOIN wp_postmeta pm ON pm.post_id = wp_log.x')).toEqual([]);
    expect(check('DELETE l FROM wp_log AS l WHERE l.x = OLD.ID')).toEqual([]);
    // The USING list is where the tables stand.
    expect(unknown('DELETE FROM l USING events AS l')).toEqual(['events']);
  });

  it('reads what only follows FROM or USING as what it is: a cursor, a time, a character set, DUAL', () => {
    expect(check('BEGIN DECLARE v INT; DECLARE c CURSOR FOR SELECT x FROM wp_log; OPEN c; FETCH NEXT FROM c INTO v; FETCH FROM c INTO v; CLOSE c; END')).toEqual([]);
    expect(check("SET NEW.note = CONVERT(NEW.note USING utf8mb4), NEW.x = (SELECT 1 FROM DUAL)")).toEqual([]);
  });

  it('adds one whose every name is accounted for', () => {
    expect(check('INSERT INTO wp_log (x, note) VALUES (NEW.ID, CONCAT(OLD.post_title, NOW()))')).toEqual([]);
    expect(check('UPDATE wp_postmeta pm SET pm.meta_value = meta_value + 1 WHERE pm.post_id = NEW.ID AND meta_key = _utf8mb4\'views\' COLLATE utf8mb4_bin')).toEqual([]);
    expect(check('CALL log_change(NEW.ID)')).toEqual([]);
    expect(check('INSERT INTO `wp_café` (x) VALUES (NEW.ID)', '`wp_café`')).toEqual([]);
    expect(check('INSERT INTO wp_log (x) VALUES (NEW.ID) ON DUPLICATE KEY UPDATE hits = hits + 1')).toEqual([]);
  });

  it("takes the names it gives as its own: cursors, variables, labels, handlers, aliases, derived tables, subqueries' names", () => {
    expect(
      check(
        'BEGIN DECLARE done INT DEFAULT 0; DECLARE v INT; DECLARE c CURSOR FOR SELECT x FROM wp_log; ' +
          'DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1; OPEN c; ' +
          'scan: LOOP FETCH NEXT FROM c INTO v; IF done THEN LEAVE scan; END IF; END LOOP scan; CLOSE c; END',
      ),
    ).toEqual([]);
    expect(check('SET NEW.x = (SELECT d.n FROM (SELECT COUNT(*) AS n FROM wp_log) d)')).toEqual([]);
    expect(check('SET NEW.x = (SELECT total FROM (SELECT COUNT(*) total FROM wp_log) AS counted)')).toEqual([]);
    expect(check('SET NEW.x = (WITH r (n) AS (SELECT 1), q AS (SELECT n FROM r) SELECT q.n FROM q)')).toEqual([]);
    expect(check("BEGIN DECLARE dup CONDITION FOR SQLSTATE '23000'; DECLARE EXIT HANDLER FOR dup SET @failed = 1; SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no'; END")).toEqual([]);
  });

  it('names another database by its name', () => {
    expect(check('INSERT INTO `analytics`.`events` VALUES (NEW.ID) /* olddb.x */ -- shop.y')).toEqual(['names the database analytics']);
    expect(check('SET NEW.x = shopdb.wp_users.ID')).toEqual(['names the database shopdb']);
  });

  it('leaves out one with ||: OR in one SQL mode, joining strings in another, and the package does not say which', () => {
    expect(check("SET NEW.note = 'A' || 'B'")).toEqual(['uses ||, which means OR or joins strings depending on an SQL mode the package does not record']);
    expect(check("SET NEW.note = 'A||B'")).toEqual([]);
  });
});

describe('a trigger, before the package is unpacked', () => {
  const tables = new Set(['wp_posts', 'wp_log']);
  it('says only what is wrong whatever the site holds: the views among it are not named yet', () => {
    expect(inspectTrigger(trigger('INSERT INTO wp_log SELECT * FROM wp_some_view'), tables)).toEqual([]);
    expect(inspectTrigger(trigger('BEGIN DECLARE c CURSOR FOR SELECT x FROM wp_log; OPEN c; FETCH NEXT FROM c INTO @v; CLOSE c; END'), tables)).toEqual([]);
    expect(inspectTrigger(trigger('INSERT INTO shopdb.audit VALUES (NEW.ID)'), tables)).toEqual(['names the database shopdb']);
    expect(inspectTrigger(trigger('SET @n = 1', '`wp_gone`'), tables)).toEqual(['is on wp_gone, which the package does not have']);
    expect(inspectTrigger(trigger("SET NEW.x = 'a' || 'b'"), tables)).toEqual(['uses ||, which means OR or joins strings depending on an SQL mode the package does not record']);
  });
});
