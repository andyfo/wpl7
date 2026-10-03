import { describe, expect, it } from 'vitest';
import {
  canonicalizeVersion,
  compareVersions,
  matchRange,
  versionSatisfies,
} from '../../src/lib/wpVersions.js';

/**
 * These are PHP's own version_compare semantics, which is what both wp-cli and
 * wpvulnerability.net assume. Getting them wrong does not produce a slightly odd sort - it
 * produces "this site is not affected" for a site that is.
 *
 * The implementation was checked against a real `php -r version_compare(...)` over ~10k
 * pairs, including deliberately malformed ones; the cases below are the ones that were
 * wrong on the first attempt, kept as regressions.
 */
describe('compareVersions (PHP version_compare)', () => {
  it('orders plain dotted versions', () => {
    expect(compareVersions('1.0', '1.1')).toBe(-1);
    expect(compareVersions('6.8.2', '6.8.10')).toBe(-1);
    expect(compareVersions('6.8.2', '6.8.2')).toBe(0);
    expect(compareVersions('2.0', '1.9.9')).toBe(1);
  });

  it('treats a longer numeric tail as newer, a pre-release tail as older', () => {
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
    // 1.0-beta is BEFORE 1.0: the release is the fix, the beta is not.
    expect(compareVersions('1.0-beta', '1.0')).toBe(-1);
    expect(compareVersions('1.0', '1.0-beta')).toBe(1);
  });

  it('ranks the special forms dev < alpha < beta < RC < release < pl', () => {
    expect(compareVersions('1.0-dev', '1.0-alpha1')).toBe(-1);
    expect(compareVersions('1.0-alpha1', '1.0-beta1')).toBe(-1);
    expect(compareVersions('1.0-beta1', '1.0-RC1')).toBe(-1);
    expect(compareVersions('1.0-RC1', '1.0')).toBe(-1);
    expect(compareVersions('1.0', '1.0-pl1')).toBe(-1);
  });

  it('canonicalizes separators and digit boundaries the way PHP does', () => {
    expect(canonicalizeVersion('1.0.0-beta2')).toBe('1.0.0.beta.2');
    expect(canonicalizeVersion('5.3rc1')).toBe('5.3.rc.1');
    expect(canonicalizeVersion('1_2+3')).toBe('1.2.3');
    // Equal after canonicalization, so the separator a plugin author chose is irrelevant.
    expect(compareVersions('1.0.0-beta2', '1.0.0beta2')).toBe(0);
  });

  it('handles a version that ends in a separator (PHP stops at the empty segment)', () => {
    // Canonicalization turns "1.0-" into "1.0.", whose trailing empty segment PHP never
    // compares as a part - it falls through to the leftovers rule instead.
    expect(compareVersions('1.0-', '1.0')).toBe(-1);
    expect(compareVersions('8rR', '8.')).toBe(-1);
    expect(compareVersions('3ab2er', '3_')).toBe(-1);
  });

  it('treats an empty version as older than anything', () => {
    expect(compareVersions('', '1.0')).toBe(-1);
    expect(compareVersions('1.0', '')).toBe(1);
    expect(compareVersions('', '')).toBe(0);
  });

  it('applies the word operators the feed publishes', () => {
    expect(versionSatisfies('5.3.1', 'lt', '5.3.2')).toBe(true);
    expect(versionSatisfies('5.3.2', 'lt', '5.3.2')).toBe(false);
    expect(versionSatisfies('5.3.2', 'le', '5.3.2')).toBe(true);
    expect(versionSatisfies('5.4', 'gt', '5.3.2')).toBe(true);
    expect(versionSatisfies('5.3.2', 'ge', '5.3.2')).toBe(true);
    expect(versionSatisfies('5.3.2', 'eq', '5.3.2')).toBe(true);
    expect(versionSatisfies('5.3.1', 'ne', '5.3.2')).toBe(true);
    // PHP's symbolic spellings are accepted too, in case an advisory ever uses one.
    expect(versionSatisfies('5.3.1', '<', '5.3.2')).toBe(true);
    expect(versionSatisfies('5.3.2', '>=', '5.3.2')).toBe(true);
    expect(versionSatisfies('5.3.2', 'nonsense', '5.3.2')).toBe(false);
  });
});

describe('matchRange', () => {
  it('matches an "affected below X" advisory', () => {
    const range = { maxVersion: '5.3.2', maxOperator: 'lt' };
    expect(matchRange('5.3.1', range)).toBe('match');
    expect(matchRange('5.3.2', range)).toBe('no-match');
    expect(matchRange('6.0', range)).toBe('no-match');
  });

  it('matches a two-sided range', () => {
    const range = { minVersion: '2.0', minOperator: 'ge', maxVersion: '2.5', maxOperator: 'le' };
    expect(matchRange('1.9', range)).toBe('no-match');
    expect(matchRange('2.0', range)).toBe('match');
    expect(matchRange('2.5', range)).toBe('match');
    expect(matchRange('2.5.1', range)).toBe('no-match');
  });

  it('matches everything when the advisory gives no bounds (core entries)', () => {
    expect(matchRange('6.8.2', {})).toBe('match');
    expect(matchRange(null, {})).toBe('match');
  });

  it('reports "unknown" rather than dropping an advisory it cannot evaluate', () => {
    // An operator the feed invented since this was written, or a missing one.
    expect(matchRange('1.0', { maxVersion: '2.0', maxOperator: 'between' })).toBe('unknown');
    expect(matchRange('1.0', { maxVersion: '2.0', maxOperator: null })).toBe('unknown');
    // No installed version to compare against is also unknown, never "clean".
    expect(matchRange('', { maxVersion: '2.0', maxOperator: 'lt' })).toBe('unknown');
  });

  it('still rules out a definite miss when only one bound is unclear', () => {
    expect(
      matchRange('3.0', { minVersion: '1.0', minOperator: 'weird', maxVersion: '2.0', maxOperator: 'lt' }),
    ).toBe('no-match');
  });
});
