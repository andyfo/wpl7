/**
 * WPL7's tuning of AMWScan (docs/security.md, "What the scanner is not asked to say"). The
 * scanner itself runs unmodified; this is what the panel hands it and what it leaves out of
 * its report, each with the reason. Every part steps aside when the scanner it was written for
 * changes under it - it never hides more than it was tested to hide:
 *
 *   exploit overrides  a tighter pattern for an exploit of AMWScan's, in its own local-rules
 *                      folder; applied only while AMWScan's pattern is still the one replaced
 *   signature ids      a signature finding is named after the signature itself, not after its
 *                      place in AMWScan's merged list - which moves with every definitions
 *                      update and would reopen every ignored finding
 *   inert signatures   signatures that cannot match anything that runs on the sites' PHP;
 *                      dropped by the reducer, by the signature's own id
 *   presence checks    "this file calls eval()": dropped at the warning level they are reported
 *                      at; the same function hidden behind an encoding (danger) is kept
 *   oversized scripts  a note on the scan, not a finding
 *
 * Bump TUNING_VERSION with any change here: the catalog's zips are checked again.
 * docs/internal/watchlist.md says what to run when AMWScan moves.
 */

export const TUNING_VERSION = 1;

export interface ExploitOverride {
  /** AMWScan's name for the exploit. */
  name: string;
  /** AMWScan's own pattern, exactly: the override applies only while it is still this. */
  replaces: string;
  pattern: string;
  why: string;
}

/**
 * Two of AMWScan's exploit patterns reach too far: each matched ordinary plugin code, and
 * each tightened one still matches the backdoor it was written for (test/unit/scanTuning.test.ts).
 */
export const EXPLOIT_OVERRIDES: readonly ExploitOverride[] = [
  {
    name: 'str_replace_eval',
    replaces: String.raw`/str_replace[\s]*\([^,]+,[\s]*["']["'][\s]*,.*?\)[\s]*;[^;]*eval[\s]*\(/si`,
    pattern: String.raw`/str_replace[\s]*\([^,;]+,[\s]*["']["'][\s]*,[^;]*?\)[\s]*;(?:[^;]*;){0,2}[^;]*eval[\s]*\(/si`,
    why:
      "Its `.*?` crosses statements, so any str_replace(x, '', y) with an eval( anywhere after it matched - one 433 lines further on. " +
      'Kept: the str_replace in one statement, the eval within the next three.',
  },
  {
    name: 'execution2',
    replaces: String.raw`/\b(array_filter|array_reduce|array_walk(_recursive)?|array_walk|assert_options|uasort|uksort|usort|preg_replace_callback|iterator_apply)[\s]*\([\s]*[^,]+,[\s]*(base64_decode|php:\/\/input|str_rot13|gz(inflate|uncompress)|getenv|pack|\\?@?\$_(GET|REQUEST|POST|COOKIE|SERVER)).*?(?=\))\)/`,
    pattern: String.raw`/\b(array_filter|array_reduce|array_walk(_recursive)?|array_walk|assert_options|uasort|uksort|usort|preg_replace_callback|iterator_apply)[\s]*\([\s]*(?:[^,()]++|\((?:[^()]++|\([^()]*+\))*+\))++,[\s]*(base64_decode|php:\/\/input|str_rot13|gz(inflate|uncompress)|getenv|pack|\\?@?\$_(GET|REQUEST|POST|COOKIE|SERVER)).*?(?=\))\)/`,
    why:
      "Its first argument `[^,]+` runs into a call nested in it, so array_filter(array_map('intval', $_POST[...])) read as a callback taken from $_POST. " +
      'Kept: the first argument may hold whole calls, never half of one.',
  },
];

export interface InertSignature {
  /**
   * The signature's own id: crc32b of its pattern, the name AMWScan gives it inside the merged
   * regexes it runs. Only a finding read back to exactly this id is dropped; one that cannot be
   * read back is kept.
   */
  id: string;
  /** The signature itself, for whoever reads this. */
  signature: string;
  why: string;
}

export const INERT_SIGNATURES: readonly InertSignature[] = [
  {
    id: '22c684e7',
    signature: '@preg_replace (literal)',
    why:
      "Matches the text @preg_replace and nothing more. It was written for preg_replace's /e modifier, which ran the replacement as PHP - " +
      'PHP 7.0 removed /e, and every site runs PHP 8.',
  },
];

/** What the scanner's container is handed: the prelude writes the overrides, the reducer drops the rest. */
export function tuningArg(): string {
  return JSON.stringify({
    overrides: EXPLOIT_OVERRIDES.map(({ name, replaces, pattern }) => ({ name, replaces, pattern })),
    inert: INERT_SIGNATURES.map(({ id }) => id),
  });
}
