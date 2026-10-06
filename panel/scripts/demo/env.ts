/**
 * The demo's environment, set before anything else is imported: the version the sidebar shows
 * is read from WPL7_VERSION when src/lib/version.ts loads, and every date is rendered in UTC so
 * the screenshots do not depend on where they were taken.
 */
process.env.WPL7_VERSION ??= '0.3.0';
process.env.WPL7_GIT_SHA ??= 'a1b2c3d';
process.env.TZ = 'UTC';
