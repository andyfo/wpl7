// @docs databases/overview, sites/database
/**
 * The database browser's request shapes and limits, shared by the API (validation) and the
 * React app (forms, the grid). Everything here addresses a site's own databases: the site's
 * database and the others it was given (site_databases), always queried as the site's own
 * database user (services/dbBrowser.ts).
 */
import { z } from 'zod';
import { UPLOAD_ID_RE } from './siteFilePath.js';
import { siteSlugParam } from './schemas.js';

/** MariaDB's own databases: never a site's, never listed among them, never dropped. */
export const SYSTEM_DATABASES = ['mysql', 'information_schema', 'performance_schema', 'sys'] as const;

/** A database name the panel creates or addresses for a site: what dbAdmin's identifier check takes. */
export const DB_NAME_RE = /^[a-z0-9_]{1,64}$/;

/**
 * A name MariaDB keeps as a folder (databases, tables): no `/`, `\` or `.`, no NUL, at most 64
 * characters. Anything in that set may exist on a server - a table a plugin made, a database
 * someone created by hand - so the browser and the unused-database list take it, quoted.
 */
export const DB_OBJECT_NAME_RE = /^[^\u0000/\\.]{1,64}$/;

/** A column name: anything but NUL, at most 64 characters. Always checked against the table's own columns. */
export const DB_COLUMN_NAME_RE = /^[^\u0000]{1,64}$/;

export const DB_LIMITS = {
  /** Rows a page of the table browser may ask for. */
  pageRows: 500,
  /** Rows kept of each result of the SQL editor; the statement is stopped after them. */
  resultRows: 1000,
  /** Characters of a value a grid cell or a result shows; the row sheet reads it whole. */
  cellChars: 1000,
  /** Bytes of one value the row sheet reads whole. A longer one is shown cut, and cannot be edited there. */
  fullValueBytes: 1024 * 1024,
  /** Characters of SQL one run takes. */
  sqlChars: 1_000_000,
  /** Filters on one table view. */
  filters: 10,
  /** Rows one delete may name. */
  deleteRows: 500,
  /** The largest dump Import takes, compressed. */
  importBytes: 4 * 1024 ** 3,
  /** One chunk of an import's upload. */
  chunkBytes: 8 * 1024 * 1024,
  /** Seconds a statement may run while browsing (MariaDB's max_statement_time). */
  browseSeconds: 20,
  /** Seconds a statement may run from the SQL editor. */
  sqlSeconds: 50,
} as const;

/** The name of another database for a site: clear of the sites' own prefix and of MariaDB's names. */
export const extraDbNameSchema = z
  .string()
  .regex(DB_NAME_RE, 'use 1-64 lowercase letters, digits and _')
  .refine((n) => !n.startsWith('wp_'), 'names starting with wp_ are kept for the sites’ own databases')
  .refine((n) => !(SYSTEM_DATABASES as readonly string[]).includes(n), 'that name is one of MariaDB’s own');

/** A database a request names: the site's own, or one of its others. Which, the route checks against the site. */
export const dbParam = z.string().regex(DB_NAME_RE, 'not a database name');

export const dbTableParam = z.string().regex(DB_OBJECT_NAME_RE, 'not a table name');
export const dbColumnName = z.string().regex(DB_COLUMN_NAME_RE, 'not a column name');

/**
 * How a filter compares. `contains` and its kin match the text of a value (LIKE, with `%` and `_`
 * in what was typed taken literally); the comparisons take the value as MariaDB would, so `< 10`
 * on a number column compares numbers.
 */
export const dbFilterOps = [
  'eq',
  'ne',
  'lt',
  'gt',
  'le',
  'ge',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isNull',
  'notNull',
] as const;
export type DbFilterOp = (typeof dbFilterOps)[number];

export const DB_FILTER_LABELS: Record<DbFilterOp, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  gt: '>',
  le: '≤',
  ge: '≥',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  isNull: 'is NULL',
  notNull: 'is not NULL',
};

/** The ops that take no value. */
export const DB_FILTER_UNARY: readonly DbFilterOp[] = ['isNull', 'notNull'];

export const dbRowFilter = z
  .object({
    column: dbColumnName,
    op: z.enum(dbFilterOps),
    value: z.string().max(4096).optional(),
  })
  .strict();
export type DbRowFilter = z.infer<typeof dbRowFilter>;

export const dbRowFilters = z.array(dbRowFilter).max(DB_LIMITS.filters);

const emptyAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const queryNumber = <T extends z.ZodType>(schema: T) => z.preprocess(emptyAsUnset, schema);

export const dbRowsQuery = z
  .object({
    offset: queryNumber(z.coerce.number().int().min(0).max(100_000_000)).default(0),
    limit: queryNumber(z.coerce.number().int().min(1).max(DB_LIMITS.pageRows)).default(50),
    sort: dbColumnName.optional(),
    dir: z.enum(['asc', 'desc']).default('asc'),
    /** JSON: DbRowFilter[] - one query value, so a filtered view is one link. */
    filters: z.string().max(64 * 1024).optional(),
  })
  .strict();

/**
 * A row, by its primary key (or first unique key without NULLs): column -> value as text. NULL
 * only where the key allows it.
 */
export const dbRowKey = z.record(dbColumnName, z.string().max(65_535).nullable());
export type DbRowKey = z.infer<typeof dbRowKey>;

/** Values to write: column -> text, null for NULL. A column left out keeps its value (or its default, on insert). */
export const dbRowValues = z.record(dbColumnName, z.string().max(16 * 1024 * 1024).nullable());

/** JSON: DbRowKey. */
export const dbRowQuery = z.object({ key: z.string().max(256 * 1024) }).strict();

export const dbRowUpdateBody = z.object({ key: dbRowKey, values: dbRowValues }).strict();
export const dbRowInsertBody = z.object({ values: dbRowValues }).strict();
export const dbRowDeleteBody = z.object({ keys: z.array(dbRowKey).min(1).max(DB_LIMITS.deleteRows) }).strict();

export const dbSqlBody = z.object({ sql: z.string().min(1).max(DB_LIMITS.sqlChars) }).strict();

export const dbCreateBody = z.object({ name: extraDbNameSchema }).strict();

export const dbParams = z.object({ slug: siteSlugParam, db: dbParam });
export const dbTableParams = z.object({ slug: siteSlugParam, db: dbParam, table: dbTableParam });

export const dbUploadParams = z.object({
  slug: siteSlugParam,
  id: z.string().regex(UPLOAD_ID_RE, 'an upload id is 16-64 characters of A-Z, a-z, 0-9, _ and -'),
});

export const dbUploadQuery = z
  .object({
    /** Where this chunk goes: the bytes already received. */
    offset: queryNumber(z.coerce.number().int().min(0)),
    /** The whole dump's size, compressed. */
    size: queryNumber(z.coerce.number().int().min(1).max(DB_LIMITS.importBytes)),
  })
  .strict();

export const dbImportBody = z
  .object({
    uploadId: z.string().regex(UPLOAD_ID_RE),
    /** Drop every table first, so the database holds exactly what the dump makes. */
    empty: z.boolean().default(false),
    /** Back the site up before anything is changed. */
    backupFirst: z.boolean().default(true),
  })
  .strict();

/** A database on a server that no site uses, as the Databases page names one. */
export const unusedDbParams = z.object({
  serverId: z.coerce.number().int().min(1),
  name: z.string().regex(DB_OBJECT_NAME_RE, 'not a database name'),
});
