import { describe, expect, it } from 'vitest';
import type { DockerPort, RunResult } from '../../src/services/docker.js';
import { WpService, wpCliFailure } from '../../src/services/wp.js';

// WP-CLI's own words in these cases, as WP-CLI 2.12 on PHP 8.4 printed them for stand-in plugins.
const REDIRECTED: RunResult = {
  stdout: "Unpacking the package...\nInstalling the plugin...\nPlugin installed successfully.\nActivating 'welcome-redirect'...\n",
  stderr:
    'Warning: Some code is trying to do a URL redirect. Backtrace:\n' +
    "#0 /var/www/html/wp-includes/class-wp-hook.php(355): WP_CLI\\Utils\\wp_redirect_handler('http://example....')\n" +
    "#1 /var/www/html/wp-includes/plugin.php(206): WP_Hook->apply_filters('http://example....', Array)\n",
  exitCode: 1,
};
const FATAL: RunResult = {
  stdout: "Plugin installed successfully.\nActivating 'welcome-redirect'...\n",
  stderr:
    '[01-Jan-2026 12:00:00 UTC] PHP Fatal error:  Uncaught RuntimeException: setup failed in /var/www/html/wp-content/plugins/welcome-redirect/welcome-redirect.php:6\n' +
    'Stack trace:\n' +
    "#0 /var/www/html/wp-includes/class-wp-hook.php(353): {closure}(false)\n" +
    '#1 {main}\n' +
    '  thrown in /var/www/html/wp-content/plugins/welcome-redirect/welcome-redirect.php on line 6\n',
  exitCode: 255,
};
const NOT_FOUND: RunResult = {
  stdout: '',
  stderr: "Warning: welcome-redirect: Plugin not found.\nWarning: The 'welcome-redirect' plugin could not be found.\nError: No plugins installed.\n",
  exitCode: 1,
};
const ok = (stdout = ''): RunResult => ({ stdout, stderr: '', exitCode: 0 });
const listing = (status: string | null): RunResult =>
  ok(JSON.stringify([{ name: 'other', status: 'active' }, ...(status ? [{ name: 'welcome-redirect', status }] : [])]));

/** WpService over a Docker that answers each exec with the next of `answers`, and records the command. */
function wpWith(...answers: RunResult[]) {
  const commands: string[] = [];
  const docker = {
    exec: async (_name: string, cmd: string[]) => {
      commands.push(cmd.join(' '));
      const answer = answers.shift();
      if (!answer) throw new Error(`no answer scripted for ${cmd.join(' ')}`);
      return answer;
    },
  } as unknown as DockerPort;
  return { wp: new WpService(docker), commands };
}

const STATE_CHECK = 'wp plugin list --format=json --fields=name,status --skip-update-check --skip-plugins --skip-themes';

describe('a plugin install or activation is judged by what WordPress has', () => {
  it('takes a run that succeeded at its word, without asking WordPress', async () => {
    const { wp, commands } = wpWith(ok("Plugin 'welcome-redirect' activated.\nSuccess: Installed 1 of 1 plugins."));
    expect(await wp.installPlugin('wp-blog', 'welcome-redirect', 'welcome-redirect', true, 'admin')).toEqual({ outcome: 'done', error: null });
    expect(commands).toEqual(['wp plugin install welcome-redirect --activate --user=admin']);
  });

  it('is done when the plugin ended PHP after WordPress saved it active, as Breakdance does on its first activation', async () => {
    const { wp, commands } = wpWith(REDIRECTED, listing('active'));
    expect(await wp.installPlugin('wp-blog', '/srv/plugins/welcome-redirect-1a2b.zip', 'welcome-redirect', true, 'admin')).toEqual({
      outcome: 'done',
      error: null,
    });
    // Read with the plugins not loaded, and without asking every update server.
    expect(commands).toEqual(['wp plugin install /srv/plugins/welcome-redirect-1a2b.zip --activate --user=admin', STATE_CHECK]);
  });

  it('is done, with the error, when the plugin crashed after WordPress saved it active', async () => {
    const { wp } = wpWith(FATAL, listing('active'));
    expect(await wp.installPlugin('wp-blog', 'welcome-redirect', 'welcome-redirect', true)).toEqual({
      outcome: 'done',
      error: 'PHP Fatal error: Uncaught RuntimeException: setup failed in /var/www/html/wp-content/plugins/welcome-redirect/welcome-redirect.php:6',
    });
  });

  it('is installed but not active when the activation did not get that far', async () => {
    const { wp } = wpWith(FATAL, listing('inactive'));
    const change = await wp.installPlugin('wp-blog', 'welcome-redirect', 'welcome-redirect', true);
    expect(change.outcome).toBe('inactive');
    expect(change.error).toContain('setup failed');
  });

  it('is done when an inactive plugin is all that was asked for', async () => {
    const { wp } = wpWith(REDIRECTED, listing('inactive'));
    expect(await wp.installPlugin('wp-blog', 'welcome-redirect', 'welcome-redirect', false)).toEqual({ outcome: 'done', error: null });
  });

  it('failed when WordPress does not have the plugin, or cannot say, or the folder is not known', async () => {
    expect(await wpWith(NOT_FOUND, listing(null)).wp.installPlugin('wp-blog', 'welcome-redirect', 'welcome-redirect', true)).toEqual({
      outcome: 'failed',
      error: "Warning: welcome-redirect: Plugin not found. Warning: The 'welcome-redirect' plugin could not be found. Error: No plugins installed.",
    });
    const broken = wpWith(REDIRECTED, { stdout: '', stderr: 'Error: Error establishing a database connection.', exitCode: 1 });
    expect((await broken.wp.installPlugin('wp-blog', 'welcome-redirect', 'welcome-redirect', true)).outcome).toBe('failed');
    const unknown = wpWith(REDIRECTED);
    expect((await unknown.wp.installPlugin('wp-blog', '/srv/plugins/loose-files.zip', null, true)).outcome).toBe('failed');
    expect(unknown.commands).toHaveLength(1);
  });

  it('judges an activation the same way', async () => {
    const { wp, commands } = wpWith(REDIRECTED, listing('active'));
    expect(await wp.activatePlugin('wp-blog', 'welcome-redirect', '7')).toEqual({ outcome: 'done', error: null });
    expect(commands).toEqual(['wp plugin activate welcome-redirect --user=7', STATE_CHECK]);
    expect((await wpWith(FATAL, listing('inactive')).wp.activatePlugin('wp-blog', 'welcome-redirect')).outcome).toBe('inactive');
  });
});

describe('wpCliFailure', () => {
  it("names PHP's fatal error without the log's timestamp or the stack trace", () => {
    expect(wpCliFailure(FATAL)).toBe(
      'PHP Fatal error: Uncaught RuntimeException: setup failed in /var/www/html/wp-content/plugins/welcome-redirect/welcome-redirect.php:6',
    );
  });

  it("gives WP-CLI's warnings and error, without the backtrace under a warning", () => {
    expect(wpCliFailure(NOT_FOUND)).toBe(
      "Warning: welcome-redirect: Plugin not found. Warning: The 'welcome-redirect' plugin could not be found. Error: No plugins installed.",
    );
    expect(wpCliFailure(REDIRECTED)).toBe('Warning: Some code is trying to do a URL redirect.');
  });

  it('falls back on the exit code, and keeps to a log line', () => {
    expect(wpCliFailure({ stdout: 'Activating ...', stderr: '', exitCode: 1 })).toBe('exit code 1');
    expect(wpCliFailure({ stdout: '', stderr: `Error: ${'x'.repeat(1000)}`, exitCode: 1 })).toHaveLength(300);
  });
});
