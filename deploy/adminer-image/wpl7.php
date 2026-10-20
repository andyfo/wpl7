<?php
/**
 * WPL7's changes to Adminer (deploy/adminer-image). It signs in only as the panel signs it in,
 * always to this server's MariaDB, and calls nobody.
 */
class Wpl7Adminer extends \Adminer\Plugin
{
    /** This server's MariaDB, whatever server a URL names. */
    function credentials()
    {
        return ['mariadb', (string) ($_GET['username'] ?? ''), \Adminer\get_password()];
    }

    /**
     * A change the panel tags (X-Wpl7-Request: only the panel can send it) takes a lock named
     * after the tag on its connection. MariaDB holds it until the connection ends, so the panel
     * can ask who holds it - a change still running, which it can stop - after the browser or the
     * relay has gone (panel/src/adminer, settle()).
     */
    function afterConnect()
    {
        $tag = (string) ($_SERVER['HTTP_X_WPL7_REQUEST'] ?? '');
        if (preg_match('~^[A-Za-z0-9_-]{16,40}$~', $tag)) {
            \Adminer\connection()->query("SELECT GET_LOCK('wpl7_adminer_$tag', 0)");
        }
    }

    /** MariaDB checks the password: the panel only ever signs in with the site's own. */
    function login($login, $password)
    {
        return true;
    }

    /** The sign-in comes from the panel, not a form: router.php demands the panel's key instead. */
    function verifyLoginToken()
    {
        return false;
    }

    /** No sign-in form: a session that ended is opened again from the panel. */
    function loginForm()
    {
        echo "<p>This Adminer session has ended. Open the database again from the panel.</p>\n";
        return true;
    }

    /**
     * Failed sign-ins counted per session, not per address: every request comes through the
     * panel's relay from 127.0.0.1, so failures anywhere would lock every site out. No browser
     * can try a password here anyway (router.php).
     */
    function bruteForceKey()
    {
        $id = session_id();
        return $id !== '' ? "session:$id" : 'user:' . (string) ($_GET['username'] ?? '');
    }

    function verifyVersion()
    {
        return false;
    }

    function serviceWorker()
    {
        return true;
    }

    function manifest()
    {
        return [];
    }

    /** No importing from a file on the server: there are none to import. */
    function importServerPath()
    {
        return '';
    }
}
