import { describe, expect, it } from 'vitest';
import { RemoteDbAdminService } from '../../src/servers/remoteDbAdmin.js';
import { FakeExec } from '../helpers.js';

describe('RemoteDbAdminService', () => {
  it('pipes DDL over stdin - nothing sensitive in argv', async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).createSiteDb('wp_demo', 'wp_demo', "p'w&d");
    const call = exec.calls[0]!;
    expect(call.method).toBe('runWithInput');
    expect(call.cmd).toBe('docker');
    expect(call.args).toEqual(['exec', '-i', 'wpl7-mariadb', 'sh', '-c', 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"']);
    // The password travels only via stdin, SQL-escaped.
    expect(call.args.join(' ')).not.toContain("p'w&d");
    expect(call.input).toContain('CREATE DATABASE `wp_demo`');
    expect(call.input).toContain("CREATE USER 'wp_demo'@'%' IDENTIFIED BY 'p''w&d';");
  });

  it('escapes LIKE wildcards in the GRANT database pattern (no cross-tenant rights)', async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).createSiteDb('wp_my_shop', 'wp_my_shop', 'pw');
    const sql = exec.calls[0]!.input!;
    // Unescaped, `wp_my_shop` would also grant on wp_myXshop / wp_my_shopX.
    expect(sql).toContain("GRANT ALL PRIVILEGES ON `wp\\_my\\_shop`.* TO 'wp_my_shop'@'%';");
    // CREATE/DROP take literal identifiers - they must NOT be escaped.
    expect(sql).toContain('CREATE DATABASE `wp_my_shop`');
  });

  it('rejects unsafe identifiers', async () => {
    const exec = new FakeExec();
    const svc = new RemoteDbAdminService(exec);
    await expect(svc.recreateDb('wp_demo; DROP')).rejects.toThrow(/Unsafe MySQL identifier/);
    expect(exec.calls).toHaveLength(0);
  });

  it('dumps via a worker-side pipeline reading the container env password', async () => {
    const exec = new FakeExec();
    exec.results = [
      { stdout: '', stderr: '', exitCode: 0 }, // pipeline
      { stdout: '4096\n', stderr: '', exitCode: 0 }, // stat size check
    ];
    await new RemoteDbAdminService(exec).dumpTo('wp_demo', '/srv/backups/demo/x/db.sql.gz');
    const pipeline = exec.calls[0]!;
    expect(pipeline.cmd).toBe('bash');
    expect(pipeline.args[1]).toContain('set -o pipefail');
    expect(pipeline.args[1]).toContain('mariadb-dump');
    expect(pipeline.args[1]).toContain('-p"$MARIADB_ROOT_PASSWORD"');
    expect(pipeline.args[1]).toContain(`| gzip > '/srv/backups/demo/x/db.sql.gz'`);
  });

  it('imports via zcat | docker exec -i', async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).importFrom('/srv/backups/demo/x/db.sql.gz', 'wp_demo');
    const call = exec.calls[0]!;
    expect(call.args[1]).toContain(`zcat '/srv/backups/demo/x/db.sql.gz' | docker exec -i wpl7-mariadb`);
    expect(call.args[1]).toContain('wp_demo');
  });

  it('fails loudly with stderr context', async () => {
    const exec = new FakeExec();
    exec.results = [{ stdout: '', stderr: 'boom', exitCode: 1 }];
    await expect(new RemoteDbAdminService(exec).importFrom('/x/db.sql.gz', 'wp_demo')).rejects.toThrow(
      /Database import failed \(exit 1\): boom/,
    );
  });
});
