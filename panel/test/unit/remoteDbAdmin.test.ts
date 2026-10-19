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

  it('imports via gzip -dc | docker exec -i, with the client commands and local files off', async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).importFrom('/srv/backups/demo/x/db.sql.gz', 'wp_demo');
    const call = exec.calls[0]!;
    expect(call.args[1]).toContain(`set -o pipefail; gzip -dc '/srv/backups/demo/x/db.sql.gz' | docker exec -i wpl7-mariadb`);
    expect(call.args[1]).toContain('exec mariadb --binary-mode --sandbox --local-infile=0 -uroot');
    expect(call.args[1]).toContain('wp_demo');
  });

  it('imports as the site user without its password in any argv, and removes the login file', async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).importFromAs('/srv/wpl7-import/3/db.sql.gz', 'wp_demo', 'wp_demo', 'p"w\\d');
    const [login, pipeline, cleanup] = exec.calls;
    // The login goes over stdin into a file only root in the MariaDB container can read.
    expect(login!.method).toBe('runWithInput');
    expect(login!.args.slice(0, 5)).toEqual(['exec', '-i', 'wpl7-mariadb', 'sh', '-c']);
    expect(login!.args[5]).toMatch(/^umask 077; cat > \/run\/wpl7-import-[0-9a-f]{16}\.cnf$/);
    expect(login!.input).toBe('[client]\nuser=wp_demo\npassword="p\\"w\\\\d"\n');
    const cnf = /\/run\/wpl7-import-[0-9a-f]{16}\.cnf/.exec(login!.args[5]!)![0];
    expect(pipeline!.args[1]).toBe(
      `set -o pipefail; gzip -dc '/srv/wpl7-import/3/db.sql.gz' | docker exec -i wpl7-mariadb mariadb --defaults-extra-file=${cnf} --binary-mode --sandbox --local-infile=0 --max-allowed-packet=1G wp_demo`,
    );
    expect(cleanup!.args).toEqual(['exec', 'wpl7-mariadb', 'rm', '-f', cnf]);
    for (const call of exec.calls) {
      expect(call.args.join(' ')).not.toContain('p"w');
      expect(call.args.join(' ')).not.toContain('MYSQL_PWD');
      expect(call.args.join(' ')).not.toContain('MARIADB_ROOT_PASSWORD');
    }
  });

  it('removes the login file when the import fails', async () => {
    const exec = new FakeExec();
    exec.results = [{ stdout: '', stderr: '', exitCode: 0 }, { stdout: '', stderr: 'ERROR 1064', exitCode: 1 }];
    await expect(new RemoteDbAdminService(exec).importFromAs('/x/db.sql.gz', 'wp_demo', 'wp_demo', 'pw')).rejects.toThrow(
      /Database import failed \(exit 1\): ERROR 1064/,
    );
    expect(exec.calls.at(-1)!.args.slice(0, 4)).toEqual(['exec', 'wpl7-mariadb', 'rm', '-f']);
  });

  it('raises the packet limit only when a statement needs more', async () => {
    const exec = new FakeExec();
    exec.results = [{ stdout: '16777216\n', stderr: '', exitCode: 0 }, { stdout: '', stderr: '', exitCode: 0 }];
    const db = new RemoteDbAdminService(exec);
    expect(await db.raisePacketLimit(20 * 1024 * 1024)).toBe(32 * 1024 * 1024);
    expect(exec.calls[0]!.input).toBe('SELECT @@GLOBAL.max_allowed_packet;\n');
    expect(exec.calls[1]!.input).toBe('SET GLOBAL max_allowed_packet = 33554432;');
    exec.results = [{ stdout: '67108864\n', stderr: '', exitCode: 0 }];
    expect(await db.raisePacketLimit(20 * 1024 * 1024)).toBeNull();
    expect(exec.calls).toHaveLength(3);
  });

  it("grants another database to the site's own user, its name escaped in the grant only", async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).createExtraDb('shop_crm', 'wp_shop');
    expect(exec.calls[0]!.input).toBe('CREATE DATABASE `shop_crm` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
    const grant = exec.calls[1]!.input!;
    // Grants an earlier database of that name left go first, then the site's own.
    expect(grant).toContain("DELETE FROM mysql.db WHERE Db IN ('shop\\\\_crm', 'shop_crm');");
    expect(grant).toContain("GRANT ALL PRIVILEGES ON `shop\\_crm`.* TO 'wp_shop'@'%';");
    await expect(new RemoteDbAdminService(exec).createExtraDb('bad name', 'wp_shop')).rejects.toThrow(/Unsafe/);
  });

  it('drops any name a server can hold, quoted, and every grant on it', async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).dropDb('old-shop`x');
    expect(exec.calls[0]!.input).toBe(
      "DROP DATABASE IF EXISTS `old-shop``x`;\nDELETE FROM mysql.db WHERE Db IN ('old-shop`x', 'old-shop`x');\nFLUSH PRIVILEGES;",
    );
  });

  it('changes a password over stdin only', async () => {
    const exec = new FakeExec();
    await new RemoteDbAdminService(exec).setUserPassword('wp_shop', "n3w'pw\\");
    const call = exec.calls[0]!;
    expect(call.args.join(' ')).not.toContain('n3w');
    expect(call.input).toBe("ALTER USER 'wp_shop'@'%' IDENTIFIED BY 'n3w''pw\\\\';");
  });

  it('reads the inventory and the users from batch output', async () => {
    const exec = new FakeExec();
    exec.results = [{ stdout: 'wp_shop\tutf8mb4_unicode_ci\t3\t49152\n', stderr: '', exitCode: 0 }];
    const db = new RemoteDbAdminService(exec);
    expect(await db.inventory()).toEqual([{ name: 'wp_shop', collation: 'utf8mb4_unicode_ci', tables: 3, bytes: 49152 }]);
    expect(exec.calls[0]!.args.at(-1)).toContain('-N -B');
    exec.results = [{ stdout: '%\nlocalhost\n', stderr: '', exitCode: 0 }, { stdout: '', stderr: '', exitCode: 0 }];
    await db.dropUser('wp_gone');
    expect(exec.calls.at(-1)!.input).toBe("DROP USER IF EXISTS 'wp_gone'@'%';\nDROP USER IF EXISTS 'wp_gone'@'localhost';");
  });

  it('fails loudly with stderr context', async () => {
    const exec = new FakeExec();
    exec.results = [{ stdout: '', stderr: 'boom', exitCode: 1 }];
    await expect(new RemoteDbAdminService(exec).importFrom('/x/db.sql.gz', 'wp_demo')).rejects.toThrow(
      /Database import failed \(exit 1\): boom/,
    );
  });
});
