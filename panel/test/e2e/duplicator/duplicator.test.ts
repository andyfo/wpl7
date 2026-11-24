/**
 * Sites made from real Duplicator packages, end to end: the package read as New site reads it, the
 * site made by its create job, and what arrived compared with what the package holds. Every file
 * byte for byte (a .zip against the system's unzip, a .daf against the archive's own entries), and
 * every table row for row: the dump the job hands over, loaded as the site's own user into a
 * MariaDB of the panel's version, against Duplicator's own dump files loaded there unchanged, as
 * root. The new site's container and its database import are the suite's fakes, as in the
 * import's end-to-end test.
 *
 * Opt-in: needs Docker, and packages built by Duplicator itself (the `_archive.zip` or
 * `_archive.daf` file of a backup) in a folder of their own. Run it when the package reader, the
 * dump filter or the set-up changes:
 *
 *   WPL7_DUPLICATOR_E2E_DIR=/path/to/packages npx vitest run test/e2e/duplicator
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { jobs, sites } from '../../../src/db/schema.js';
import { hostExec } from '../../../src/lib/exec.js';
import { DafReader } from '../../../src/lib/dupArchive.js';
import { OpenPackage, inspectPackage, packageCharset } from '../../../src/services/duplicator.js';
import { sitePaths } from '../../../src/services/siteSpec.js';
import { makeWorld, waitFor } from '../../helpers.js';
import { logOf } from '../../importWorld.js';

const DIR = process.env.WPL7_DUPLICATOR_E2E_DIR ?? '';
const PACKAGES = DIR ? fs.readdirSync(DIR).filter((f) => /_archive\.(zip|daf)$/.test(f)).map((f) => path.join(DIR, f)) : [];
const RUN = `wpl7-dup-e2e-${process.pid}`;

function docker(args: string[], input?: Buffer | string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, { input, maxBuffer: 1024 ** 3 });
  return { status: res.status ?? -1, stdout: res.stdout?.toString('utf8') ?? '', stderr: res.stderr?.toString('utf8') ?? '' };
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Every regular file under `root`, by its path, with its hash. */
function tree(root: string, rel = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) for (const [k, v] of tree(root, r)) out.set(k, v);
    else if (e.isFile()) out.set(r, sha(fs.readFileSync(path.join(root, r))));
  }
  return out;
}

/** What the package holds outside the installer, as the reference: the system's unzip, or the archive's own entries. */
async function packageFiles(file: string, work: string): Promise<Map<string, string>> {
  if (file.endsWith('.zip')) {
    const ref = path.join(work, 'ref');
    fs.mkdirSync(ref);
    const res = spawnSync('unzip', ['-q', '-o', file, '-d', ref]);
    expect(res.status, res.stderr?.toString()).toBe(0);
    return new Map([...tree(ref)].filter(([k]) => !k.startsWith('dup-installer/')));
  }
  const out = new Map<string, string>();
  const daf = await DafReader.open(file);
  try {
    let name: string | null = null;
    let hash: crypto.Hash | null = null;
    const done = () => {
      if (name && hash) out.set(name, hash.digest('hex'));
      name = null;
      hash = null;
    };
    await daf.walk({
      onEntry: async (e) => {
        done();
        const n = e.name.toString('utf8');
        if (e.kind !== 'file' || n.startsWith('dup-installer/') || n === '__dup__archive__index.json') return null;
        name = n;
        hash = crypto.createHash('sha256');
        const h = hash;
        return async (chunk) => void h.update(chunk);
      },
    });
    done();
  } finally {
    await daf.close();
  }
  return out;
}

// With no folder given, one skipped case: a file with no suite at all fails the run.
describe.skipIf(PACKAGES.length === 0).each(PACKAGES.length > 0 ? PACKAGES : ['(no packages)'])('a site from %s', (file) => {
  const name = path.basename(file).replace(/[^a-z0-9]+/gi, '-').slice(-40).toLowerCase();
  const scratch = `${RUN}-${name}`;
  let work = '';
  const dumps: string[] = [];
  let w: Awaited<ReturnType<typeof makeWorld>>;

  const sql = (db: string, query: string, user = 'root', password = 'rootpw') => {
    const res = docker(['exec', '-i', '-e', `MYSQL_PWD=${password}`, scratch, 'mariadb', `-u${user}`, '-h127.0.0.1', '--default-character-set=utf8mb4', '-N', '-B', db], query);
    expect(res.status, res.stderr).toBe(0);
    return res.stdout;
  };

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'wpl7-dup-e2e-'));
    expect(docker(['run', '-d', '--name', scratch, '-e', 'MARIADB_ROOT_PASSWORD=rootpw', loadConfig().mariadb.clientImage]).status).toBe(0);
    await waitFor(() => docker(['exec', '-e', 'MYSQL_PWD=rootpw', scratch, 'mariadb', '-uroot', '-e', 'SELECT 1']).status === 0, 120_000);
    w = await makeWorld({ exec: hostExec });
    w.docker.onStart = (container) => {
      if (!container.startsWith('wp-')) return;
      const config = path.join(sitePaths(w.config, container.slice(3)).wordpress, 'wp-config.php');
      if (fs.existsSync(path.dirname(config)) && !fs.existsSync(config)) fs.writeFileSync(config, '<?php // written by the image');
    };
    const importFromAs = w.dbAdmin.importFromAs.bind(w.dbAdmin);
    w.dbAdmin.importFromAs = async (src, db, user, password) => {
      const copy = path.join(work, `dump-${dumps.length}.sql.gz`);
      fs.copyFileSync(src, copy);
      dumps.push(copy);
      return importFromAs(src, db, user, password);
    };
  }, 5 * 60_000);

  // Removing the database container takes longer than a hook's ten seconds on a busy machine.
  afterAll(() => {
    docker(['rm', '-f', '-v', scratch]);
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }, 2 * 60_000);

  it('makes the site: every file as the package has it, and the database loads as the site user', async () => {
    const id = 'e2e-package-upload-01';
    fs.mkdirSync(w.core.packages.dir(), { recursive: true });
    fs.copyFileSync(file, w.core.packages.path(id));
    const pkg = await OpenPackage.open(file);
    let charset: string;
    let prefix: string;
    let originals: Buffer[] = [];
    try {
      const inspection = await inspectPackage(pkg, id, w.core.settings.get('phpVersions') ?? []);
      expect(inspection.dto.blockedReason, JSON.stringify(inspection.dto.warnings)).toBeNull();
      charset = packageCharset(inspection.contents)!;
      prefix = inspection.report!.table_prefix;
      for (const d of inspection.contents.dumps) {
        const raw = await pkg.readAll(d.ref, 1024 ** 3);
        originals.push(d.gzip ? zlib.gunzipSync(raw) : raw);
      }
    } finally {
      await pkg.close();
    }

    const body = { title: 'From a package', slug: 'frompkg', domainMode: 'dev' as const, app: 'wordpress' as const, package: { uploadId: id, carryConstants: [], deactivatePlugins: [], removeDropins: [], removeMuPlugins: [], rewritePaths: true } };
    const { job } = w.deps.sites.create(body, await w.deps.sites.assertCanCreate(body));
    w.worker.start();
    try {
      await waitFor(() => ['succeeded', 'failed'].includes(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status), 15 * 60_000);
    } finally {
      await w.worker.stop();
    }
    expect(w.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status, logOf(w, job.id).join('\n')).toBe('succeeded');
    const site = w.db.select().from(sites).where(eq(sites.slug, 'frompkg')).get()!;
    expect(site.tablePrefix).toBe(prefix);

    // Files: every one the package holds, byte for byte; nothing of the installer, and not the
    // wp-config-docker.php these packages have from the image their site ran on.
    const expected = await packageFiles(file, work);
    const got = tree(sitePaths(w.config, 'frompkg').wordpress);
    const leftOut = (k: string) => /^[^/]*installer[^/]*\.php(\.bak)?$/.test(k) || k === 'wp-config-docker.php';
    const missing = [...expected].filter(([k, v]) => !leftOut(k) && got.get(k) !== v).map(([k]) => k);
    expect(missing).toEqual([]);
    expect([...got.keys()].filter((k) => k.startsWith('dup-installer/') || /^[^/]*installer(-backup)?\.php$/.test(k) || k === 'wp-config-docker.php')).toEqual([]);

    // The database: the job's dump as the site's own user, Duplicator's own as root, table by table.
    sql('', "CREATE DATABASE site CHARACTER SET utf8mb4; CREATE USER 'site'@'%' IDENTIFIED BY 'sitepw'; GRANT ALL PRIVILEGES ON site.* TO 'site'@'%'; CREATE DATABASE ref CHARACTER SET utf8mb4;");
    const load = docker(
      ['exec', '-i', '-e', 'MYSQL_PWD=sitepw', scratch, 'mariadb', '--binary-mode', '--sandbox', '--local-infile=0', '--max-allowed-packet=1G', '-usite', '-h127.0.0.1', 'site'],
      zlib.gunzipSync(fs.readFileSync(dumps[0]!)),
    );
    expect(load.status, load.stderr).toBe(0);
    const reference = Buffer.concat([Buffer.from(`SET NAMES ${charset!};\nSET FOREIGN_KEY_CHECKS=0;\nSET sql_mode='NO_AUTO_VALUE_ON_ZERO';\n`), ...originals.flatMap((o) => [o, Buffer.from('\n')])]);
    const refLoad = docker(['exec', '-i', '-e', 'MYSQL_PWD=rootpw', scratch, 'mariadb', '--binary-mode', '--max-allowed-packet=1G', '-uroot', 'ref'], reference);
    expect(refLoad.status, refLoad.stderr).toBe(0);
    const tables = sql('ref', "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='ref' AND TABLE_TYPE='BASE TABLE' ORDER BY 1;").split('\n').filter(Boolean);
    expect(tables).toContain(`${prefix!}options`);
    for (const table of tables) {
      const cols = sql(
        'ref',
        `SET SESSION group_concat_max_len=1000000; SELECT GROUP_CONCAT(CONCAT('IFNULL(HEX(CAST(\`',COLUMN_NAME,'\` AS BINARY)),''N'')') ORDER BY ORDINAL_POSITION SEPARATOR ',') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='ref' AND TABLE_NAME='${table}';`,
      ).trim();
      const q = (db: string) => `SELECT COUNT(*), IFNULL(SUM(CRC32(CONCAT_WS(',', ${cols}))), 0) FROM \`${db}\`.\`${table}\`;`;
      expect(sql('site', q('site')), table).toBe(sql('ref', q('ref')));
    }
    // A view comes along as the site user's.
    const views = sql('site', "SELECT DEFINER FROM information_schema.VIEWS WHERE TABLE_SCHEMA='site';").split('\n').filter(Boolean);
    for (const definer of views) expect(definer).toBe('site@%');
  }, 30 * 60_000);
});
