import { describe, expect, it } from 'vitest';
import { dbAlterChange, dbColumnDef, type DbColumnDef } from '../../shared/databases.js';
import type { DbTableStructureDto } from '../../shared/types.js';
import { alterTableSql, columnSql, createTableSql, ddlString, describeChanges, dropTableSql, truncateTableSql } from '../../src/lib/sqlDdl.js';
import { fakeColumn } from '../dbBrowserFake.js';

const col = (fields: Partial<DbColumnDef> & { name: string; type: string }): DbColumnDef =>
  dbColumnDef.parse({ nullable: false, default: { kind: 'none' }, ...fields });

const posts: DbTableStructureDto = {
  table: 'wp_posts',
  type: 'table',
  columns: [
    fakeColumn('ID', 'bigint(20) unsigned', { nullable: false, key: 'PRI', extra: 'auto_increment' }),
    fakeColumn('post_title', 'text', { nullable: false }),
    fakeColumn('post_status', 'varchar(20)', { nullable: false, default: "'publish'" }),
    fakeColumn('post_date', 'datetime', { nullable: false, default: "'0000-00-00 00:00:00'" }),
    fakeColumn('geo', 'point', { nullable: true, default: 'NULL' }),
  ],
  indexes: [
    { name: 'PRIMARY', unique: true, columns: ['ID'], lengths: [null], type: 'BTREE' },
    { name: 'type_status_date', unique: false, columns: ['post_status', 'post_date'], lengths: [null, null], type: 'BTREE' },
  ],
  key: ['ID'],
  rows: 3,
  foreignKeys: [{ name: 'fk_author', columns: ['ID'], refTable: 'wp_users', refColumns: ['ID'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' }],
};

describe('structure changes as SQL', () => {
  it('writes a column with its type, NULL, default, counter and comment', () => {
    expect(columnSql(col({ name: 'views', type: 'int(10) unsigned', default: { kind: 'value', value: '0' }, comment: "it's counted" }))).toBe(
      "`views` int(10) unsigned NOT NULL DEFAULT '0' COMMENT 'it''s counted'",
    );
    expect(
      columnSql(col({ name: 'seen', type: 'datetime(6)', nullable: true, default: { kind: 'currentTimestamp' }, onUpdateCurrentTimestamp: true })),
    ).toBe('`seen` datetime(6) NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)');
    expect(columnSql(col({ name: 'id', type: 'bigint', autoIncrement: true }))).toBe('`id` bigint NOT NULL AUTO_INCREMENT');
    expect(columnSql(col({ name: 'kind', type: "enum('a','b''c')", collation: 'utf8mb4_bin' }))).toBe(
      "`kind` enum('a','b''c') COLLATE utf8mb4_bin NOT NULL",
    );
  });

  it('refuses what is not a column', () => {
    expect(() => columnSql(col({ name: 'x', type: 'int; DROP TABLE wp_users' }))).toThrow(/not a column type/);
    expect(() => columnSql(col({ name: 'x', type: 'varchar' }))).toThrow(/not a column type/);
    expect(() => columnSql(col({ name: 'x', type: 'text', autoIncrement: true }))).toThrow(/whole-number/);
    expect(() => columnSql(col({ name: 'x', type: 'date', default: { kind: 'currentTimestamp' } }))).toThrow(/datetime or timestamp/);
    expect(() => columnSql(col({ name: 'x', type: 'int', default: { kind: 'null' } }))).toThrow(/does not take NULL/);
    expect(() => columnSql(col({ name: 'x', type: 'int', default: { kind: 'keep' } }))).toThrow(/no default to keep/);
  });

  it('quotes text so it stays one literal', () => {
    expect(ddlString("a'b\\c")).toBe("'a''b\\\\c'");
    expect(() => ddlString('a\u0000')).toThrow(/NUL/);
  });

  it('changes a table in one ALTER, each change checked against the table as the ones before leave it', () => {
    const changes = [
      { op: 'addColumn', column: col({ name: 'views', type: 'int' }), position: { after: 'post_title' } },
      { op: 'addIndex', index: { kind: 'index', name: 'views', columns: [{ name: 'views' }] } },
      { op: 'modifyColumn', name: 'post_status', column: col({ name: 'status', type: 'varchar(40)', default: { kind: 'keep' } }), position: null },
      // An exotic type stays as it is: only its own type is taken without the grammar.
      { op: 'modifyColumn', name: 'geo', column: col({ name: 'geo', type: 'point', nullable: true, default: { kind: 'keep' } }), position: 'first' },
      { op: 'dropIndex', name: 'PRIMARY' },
      { op: 'addIndex', index: { kind: 'primary', columns: [{ name: 'ID' }, { name: 'post_title', length: 10 }] } },
      { op: 'dropForeignKey', name: 'fk_author' },
      { op: 'rename', name: 'wp_articles' },
    ].map((c) => dbAlterChange.parse(c));
    expect(alterTableSql(posts, changes)).toBe(
      'ALTER TABLE `wp_posts` ADD COLUMN `views` int NOT NULL AFTER `post_title`, ADD INDEX `views` (`views`), ' +
        "CHANGE COLUMN `post_status` `status` varchar(40) NOT NULL DEFAULT 'publish', " +
        'CHANGE COLUMN `geo` `geo` point NULL DEFAULT NULL FIRST, DROP PRIMARY KEY, ' +
        'ADD PRIMARY KEY (`ID`, `post_title`(10)), DROP FOREIGN KEY `fk_author`, RENAME TO `wp_articles`',
    );
    expect(describeChanges('wp_posts', changes)).toBe('8 changes to wp_posts');
    expect(describeChanges('wp_posts', changes.slice(2, 3))).toBe('Rename column post_status to status in wp_posts');
  });

  it('says what is wrong with a change before anything runs', () => {
    const alter = (c: unknown) => alterTableSql(posts, [dbAlterChange.parse(c)]);
    expect(() => alter({ op: 'dropColumn', name: 'nope' })).toThrow(/no column "nope"/);
    expect(() => alter({ op: 'addColumn', column: col({ name: 'post_title', type: 'int' }) })).toThrow(/has a column "post_title" already/);
    expect(() => alter({ op: 'addIndex', index: { kind: 'primary', columns: [{ name: 'post_title' }] } })).toThrow(/replace it/);
    expect(() => alter({ op: 'dropIndex', name: 'nope' })).toThrow(/no index "nope"/);
    expect(() => alter({ op: 'dropForeignKey', name: 'nope' })).toThrow(/no foreign key/);
    expect(() => alter({ op: 'modifyColumn', name: 'geo', column: col({ name: 'geo', type: 'polygon(3)' }) })).toThrow(/not a column type/);
    expect(() => alter({ op: 'rename', name: 'wp_posts' })).toThrow(/name it has/);
    // An index names columns as the whole statement leaves them: by a renamed column's new name.
    const both = (index: string) =>
      alterTableSql(posts, [
        dbAlterChange.parse({ op: 'addIndex', index: { kind: 'index', name: 'ix', columns: [{ name: index }] } }),
        dbAlterChange.parse({ op: 'modifyColumn', name: 'post_status', column: col({ name: 'status', type: 'varchar(20)' }) }),
      ]);
    expect(() => both('post_status')).toThrow(/no column "post_status"/);
    expect(both('status')).toContain('ADD INDEX `ix` (`status`)');
    // A place names columns as the changes before it leave them.
    expect(() =>
      alterTableSql(posts, [
        dbAlterChange.parse({ op: 'addColumn', column: col({ name: 'e', type: 'int' }), position: { after: 'f' } }),
        dbAlterChange.parse({ op: 'addColumn', column: col({ name: 'f', type: 'int' }) }),
      ]),
    ).toThrow(/no column "f"/);
    expect(() => alterTableSql({ ...posts, type: 'view' }, [dbAlterChange.parse({ op: 'dropColumn', name: 'ID' })])).toThrow(/view/);
  });

  it('names columns in a request the way MariaDB reads one', () => {
    const alter = (...changes: unknown[]) => alterTableSql(posts, changes.map((c) => dbAlterChange.parse(c)));
    const addX = { op: 'addColumn', column: col({ name: 'x', type: 'int' }) };
    // CHANGE and DROP name columns of the table as it is, each once.
    expect(() => alter(addX, { op: 'modifyColumn', name: 'x', column: col({ name: 'y', type: 'int' }) })).toThrow(/a name this same request gives/);
    expect(() => alter(addX, { op: 'dropColumn', name: 'x' })).toThrow(/a name this same request gives/);
    expect(() =>
      alter(
        { op: 'modifyColumn', name: 'post_title', column: col({ name: 'title', type: 'text' }) },
        { op: 'modifyColumn', name: 'title', column: col({ name: 'heading', type: 'text' }) },
      ),
    ).toThrow(/a name this same request gives/);
    expect(() =>
      alter({ op: 'modifyColumn', name: 'post_title', column: col({ name: 'post_title', type: 'text' }) }, { op: 'dropColumn', name: 'post_title' }),
    ).toThrow(/twice/);
    // A place names a column there at that point, and still there at the end.
    expect(() =>
      alter(
        { op: 'addColumn', column: col({ name: 'z', type: 'int' }), position: { after: 'post_title' } },
        { op: 'modifyColumn', name: 'post_title', column: col({ name: 'title', type: 'text' }) },
      ),
    ).toThrow(/renames or drops/);
    // Dropped, then added again under its name: one statement can.
    expect(alter({ op: 'dropColumn', name: 'geo' }, { op: 'addColumn', column: col({ name: 'geo', type: 'int' }) })).toBe(
      'ALTER TABLE `wp_posts` DROP COLUMN `geo`, ADD COLUMN `geo` int NOT NULL',
    );
  });

  it('changes only columns it can carry over whole, and keeps what it carries', () => {
    const table: DbTableStructureDto = {
      ...posts,
      columns: [
        ...posts.columns,
        fakeColumn('total', 'int(11)', { nullable: true, default: 'NULL', extra: 'STORED GENERATED' }),
        fakeColumn('secret', 'int(11)', { nullable: true, default: 'NULL', extra: 'INVISIBLE' }),
        fakeColumn('qty', 'int(11)', { nullable: true, default: 'NULL', check: '`qty` > 0' }),
        fakeColumn('data', 'json', { nullable: true, default: 'NULL', collation: 'utf8mb4_bin' }),
        fakeColumn('icon', 'varchar(8)', { default: "'?'" }),
        fakeColumn('note', 'varchar(20)', { nullable: true, default: 'NULL' }),
      ],
    };
    const change = (name: string, column: Partial<DbColumnDef> & { type: string }) =>
      alterTableSql(table, [dbAlterChange.parse({ op: 'modifyColumn', name, column: col({ name, ...column }) })]);
    expect(() => change('total', { type: 'int' })).toThrow(/generated column/);
    expect(() => change('secret', { type: 'int' })).toThrow(/invisible/);
    expect(() => change('qty', { type: 'int' })).toThrow(/CHECK constraint/);
    // A JSON column stays JSON (MariaDB adds its check back), with its own collation.
    expect(change('data', { type: 'json', nullable: true, default: { kind: 'keep' }, collation: 'utf8mb4_bin' })).toBe(
      'ALTER TABLE `wp_posts` CHANGE COLUMN `data` `data` json COLLATE utf8mb4_bin NULL DEFAULT NULL',
    );
    // A default MariaDB shows with ? is given again, not kept as a real ?.
    expect(() => change('icon', { type: 'varchar(8)', default: { kind: 'keep' } })).toThrow(/give it again/);
    // A kept NULL is no default once the column takes no NULL; a collation goes with text only.
    expect(change('note', { type: 'varchar(20)', default: { kind: 'keep' }, collation: 'utf8mb4_unicode_ci' })).toBe(
      'ALTER TABLE `wp_posts` CHANGE COLUMN `note` `note` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL',
    );
    expect(change('note', { type: 'varbinary(20)', collation: 'utf8mb4_unicode_ci' })).toBe(
      'ALTER TABLE `wp_posts` CHANGE COLUMN `note` `note` varbinary(20) NOT NULL',
    );
  });

  it('creates, empties and drops a table', () => {
    expect(
      createTableSql({
        name: 'shop_orders',
        columns: [col({ name: 'id', type: 'bigint unsigned', autoIncrement: true }), col({ name: 'total', type: 'decimal(10,2)', default: { kind: 'value', value: '0' } })],
        primaryKey: ['id'],
      }),
    ).toBe("CREATE TABLE `shop_orders` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `total` decimal(10,2) NOT NULL DEFAULT '0',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB");
    expect(createTableSql({ name: 'wpl7_try_x', columns: [col({ name: 'a', type: 'int' })], primaryKey: [] }, { temporary: true })).toMatch(
      /^CREATE TEMPORARY TABLE `wpl7_try_x` \(/,
    );
    expect(() => createTableSql({ name: 't', columns: [col({ name: 'id', type: 'int', autoIncrement: true })], primaryKey: [] })).toThrow(/first in the primary key/);
    expect(() => createTableSql({ name: 't', columns: [col({ name: 'a', type: 'int' }), col({ name: 'a', type: 'int' })], primaryKey: [] })).toThrow(/Two columns/);
    expect(truncateTableSql(posts)).toBe('TRUNCATE TABLE `wp_posts`');
    expect(dropTableSql({ table: 'v_x', type: 'view' })).toBe('DROP VIEW `v_x`');
    expect(() => truncateTableSql({ table: 'v_x', type: 'view' })).toThrow(/no rows of its own/);
  });
});
