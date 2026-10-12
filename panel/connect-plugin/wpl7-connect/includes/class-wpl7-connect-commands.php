<?php
defined('ABSPATH') || exit;

/**
 * Registered commands (docs/internal/connect-protocol.md, Registered commands): what plugins add
 * to the connector through the `wpl7_connect_commands` filter, listed, helped and run for the
 * panel. Only what is registered runs: nothing falls back to WP-CLI, a shell or PHP. A command
 * gets its arguments as WP-CLI would pass them, its global flags dealt with first; the pure part
 * of that is global_flags(), which tests/run.php checks against the vectors.
 *
 *     add_filter('wpl7_connect_commands', function (array $commands) {
 *         $commands['hello'] = array(
 *             'summary' => 'Says hello',
 *             'help'    => function (array $words) { return "NAME\n\n  wp hello\n"; },
 *             'run'     => function (array $args, array $context) {
 *                 return array('stdout' => "Hello\n", 'stderr' => '', 'exit_code' => 0);
 *             },
 *         );
 *         return $commands;
 *     });
 */
final class WPL7_Connect_Commands
{
    const NAME_RE = '/^[a-z][a-z0-9-]{0,39}$/D';
    const MAX_SUMMARY = 200;
    const MAX_ARGS = 200;
    const MAX_ARG = 65536;
    const MAX_STDIN = 524288;
    const MAX_WORDS = 50;
    /** stdout and stderr are each cut here. */
    const MAX_OUTPUT = 1048576;
    /** How long a command may take, from the request's start, where the host allows it. */
    const RUN_SECONDS = 50;

    /** WP-CLI's global flags that make no sense here: the command is not run. */
    const REFUSED_FLAGS = ['path', 'url', 'ssh', 'http', 'skip-plugins', 'skip-themes', 'skip-packages', 'require', 'exec',
        'context', 'prompt'];
    /** WP-CLI's global flags that change only how WP-CLI itself talks: dropped. */
    const DROPPED_FLAGS = ['quiet', 'debug', 'color'];

    private static $registered = null;

    // -- Pure helpers (tests/run.php) --------------------------------------------------------

    public static function valid_name($name)
    {
        return is_string($name) && preg_match(self::NAME_RE, $name) === 1;
    }

    /**
     * WP-CLI's global flags, anywhere in $args, dealt with as WP-CLI would before the command sees
     * them: `--user=<who>` taken out and returned, the output flags dropped, the ones that would
     * reach outside the site refused. Everything else, `--` and `-` included, is the command's
     * own. The vectors' `globalFlags` cases pin this.
     *
     * @return array ['args' => [...], 'user' => string|null], or ['error' => why, for stderr]
     */
    public static function global_flags($args)
    {
        $out = [];
        $user = null;
        foreach ($args as $arg) {
            $flag = null;
            $value = null;
            if (preg_match('/^--no-([^=]+)$/D', $arg, $m)) {
                $flag = $m[1];
                $value = false;
            } elseif (preg_match('/^--([^=]+)$/D', $arg, $m)) {
                $flag = $m[1];
                $value = true;
            } elseif (preg_match('/^--([^=]+)=(.*)$/sD', $arg, $m)) {
                $flag = $m[1];
                $value = $m[2];
            }
            if ($flag === 'user') {
                if (!is_string($value) || $value === '') {
                    return ['error' => '--user needs a value.'];
                }
                $user = $value;
                continue;
            }
            if (in_array($flag, self::REFUSED_FLAGS, true)) {
                return ['error' => '--' . $flag . ' is not available through WPL7 Connect.'];
            }
            if (in_array($flag, self::DROPPED_FLAGS, true)) {
                continue;
            }
            $out[] = $arg;
        }
        return ['args' => $out, 'user' => $user];
    }

    /** `wp help` with no words: a usage line, then each command and its summary. */
    public static function overview($commands)
    {
        $text = "usage: wp <command> [<args>...]\n\n";
        if (!$commands) {
            return $text . "No commands are registered with WPL7 Connect.\n";
        }
        $width = max(array_map('strlen', array_keys($commands)));
        $text .= "Commands registered with WPL7 Connect:\n\n";
        foreach ($commands as $name => $summary) {
            $text .= rtrim('  ' . str_pad($name, $width) . '  ' . $summary) . "\n";
        }
        return $text;
    }

    // -- The registry ------------------------------------------------------------------------

    /**
     * What plugins registered, by name: entries with a valid name and a callable `run`. Asked
     * when an action needs it, once per request, after every plugin has loaded.
     */
    public static function registered()
    {
        if (self::$registered !== null) {
            return self::$registered;
        }
        $raw = apply_filters('wpl7_connect_commands', []);
        $out = [];
        foreach (is_array($raw) ? $raw : [] as $name => $spec) {
            if (!self::valid_name($name) || !is_array($spec) || !isset($spec['run']) || !is_callable($spec['run'])) {
                continue;
            }
            $out[$name] = [
                'summary' => isset($spec['summary']) && is_string($spec['summary'])
                    ? WPL7_Connect_Plugin::cut(trim(preg_replace('/\s+/', ' ', $spec['summary'])), self::MAX_SUMMARY) : '',
                'help' => isset($spec['help']) && is_callable($spec['help']) ? $spec['help'] : null,
                'run' => $spec['run'],
            ];
        }
        ksort($out, SORT_STRING);
        self::$registered = $out;
        return $out;
    }

    /** The names, for the report and ping. */
    public static function names()
    {
        return array_keys(self::registered());
    }

    // -- The actions -------------------------------------------------------------------------

    /** `commands`: { commands: [{ name, summary }] }, by name. */
    public static function list_action()
    {
        $out = [];
        foreach (self::registered() as $name => $command) {
            $out[] = ['name' => $name, 'summary' => $command['summary']];
        }
        return ['commands' => $out];
    }

    /** `help`: { words } answers { text }: what the command's help gives for them; no words lists the commands. */
    public static function help_action($params)
    {
        $words = array_key_exists('words', $params) ? $params['words'] : [];
        if (!is_array($words) || count($words) > self::MAX_WORDS || array_values($words) !== $words) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'words']);
        }
        foreach ($words as $word) {
            if (!is_string($word) || strlen($word) > 200) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'words']);
            }
        }
        $commands = self::registered();
        if (!$words) {
            $summaries = [];
            foreach ($commands as $name => $command) {
                $summaries[$name] = $command['summary'];
            }
            return ['text' => self::overview($summaries)];
        }
        if (!isset($commands[$words[0]]) || $commands[$words[0]]['help'] === null) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'command']);
        }
        $help = $commands[$words[0]]['help'];
        $text = self::caught(function () use ($help, $words) {
            return call_user_func($help, $words);
        }, $printed);
        if (!is_string($text)) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'command']);
        }
        return ['text' => WPL7_Connect_Plugin::cut_bytes($text, self::MAX_OUTPUT)];
    }

    /**
     * `run`: { args, stdin? } answers { stdout, stderr, exit_code }. args[0], once the global
     * flags are out, names the command; one nobody registered is 404.
     */
    public static function run_action($params)
    {
        $args = isset($params['args']) ? $params['args'] : null;
        if (!is_array($args) || !$args || array_values($args) !== $args) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'args']);
        }
        if (count($args) > self::MAX_ARGS) {
            throw new WPL7_Connect_Error(413, 'too_large', ['detail' => 'args']);
        }
        foreach ($args as $arg) {
            if (!is_string($arg)) {
                throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'args']);
            }
            if (strlen($arg) > self::MAX_ARG) {
                throw new WPL7_Connect_Error(413, 'too_large', ['detail' => 'args']);
            }
        }
        $stdin = array_key_exists('stdin', $params) ? $params['stdin'] : null;
        if ($stdin !== null && !is_string($stdin)) {
            throw new WPL7_Connect_Error(422, 'unsupported', ['detail' => 'stdin']);
        }
        if ($stdin !== null && strlen($stdin) > self::MAX_STDIN) {
            throw new WPL7_Connect_Error(413, 'too_large', ['detail' => 'stdin']);
        }

        $parsed = self::global_flags($args);
        if (isset($parsed['error'])) {
            return self::result('', 'Error: ' . $parsed['error'] . "\n", 1);
        }
        $commands = self::registered();
        $name = isset($parsed['args'][0]) ? $parsed['args'][0] : '';
        if (!isset($commands[$name])) {
            throw new WPL7_Connect_Error(404, 'not_found', ['detail' => 'command']);
        }
        // Only now, inside a request the panel signed and after every check, does anyone sign in.
        $user = 0;
        if ($parsed['user'] !== null) {
            $found = WPL7_Connect_Rest::find_user($parsed['user']);
            if (!$found) {
                return self::result('', "Error: Invalid user ID, email or login: '" . $parsed['user'] . "'\n", 1);
            }
            $user = (int) $found->ID;
        }
        wp_set_current_user($user);

        $context = ['deadline' => self::deadline(), 'stdin' => $stdin];
        $run = $commands[$name]['run'];
        $command_args = $parsed['args'];
        $error = null;
        try {
            $out = self::caught(function () use ($run, $command_args, $context) {
                return call_user_func($run, $command_args, $context);
            }, $printed);
        } catch (Throwable $e) {
            $out = null;
            $error = $e;
        }
        if ($error !== null) {
            return self::result($printed, 'Error: ' . $error->getMessage() . "\n", 1);
        }
        if (!is_array($out) || !isset($out['stdout'], $out['stderr'], $out['exit_code'])
            || !is_string($out['stdout']) || !is_string($out['stderr']) || !is_int($out['exit_code'])) {
            return self::result($printed, "Error: The command returned no result.\n", 1);
        }
        return self::result($out['stdout'] . $printed, $out['stderr'], $out['exit_code']);
    }

    private static function result($stdout, $stderr, $exit_code)
    {
        return [
            'stdout' => WPL7_Connect_Plugin::cut_bytes($stdout, self::MAX_OUTPUT),
            'stderr' => WPL7_Connect_Plugin::cut_bytes($stderr, self::MAX_OUTPUT),
            'exit_code' => (int) $exit_code,
        ];
    }

    /**
     * When the command must be done: the request's start plus RUN_SECONDS. A shorter
     * max_execution_time is raised to 60 where the host allows; where it does not, the deadline
     * comes before PHP's own.
     */
    private static function deadline()
    {
        $start = WPL7_Connect_Server::request_start();
        $limit = (int) ini_get('max_execution_time');
        if ($limit > 0 && $limit < 60 && WPL7_Connect_Server::long_request(60)) {
            $limit = 60;
        }
        $seconds = self::RUN_SECONDS;
        if ($limit > 0 && $limit < 60) {
            $seconds = max(1, min(self::RUN_SECONDS, $limit - 5));
        }
        return $start + $seconds;
    }

    /**
     * Runs $work and returns what it returns; what it printed goes into $printed, every buffer it
     * opened closed. An exception still passes through, after the buffers are closed.
     */
    private static function caught($work, &$printed)
    {
        $printed = '';
        $level = ob_get_level();
        ob_start();
        try {
            return $work();
        } finally {
            $chunks = [];
            while (ob_get_level() > $level) {
                $chunks[] = (string) ob_get_clean();
            }
            $printed = implode('', array_reverse($chunks));
        }
    }
}
