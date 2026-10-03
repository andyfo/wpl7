import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { CHEAP_ARGON2, productionArgon2Hash } from '../setup.js';

/**
 * test/setup.ts makes hashing cheap for every other test in the suite. That is a deliberate
 * hole, and this is the thing that keeps it visible: if production's parameters ever drift
 * down to the test ones, the suite would still be green and nobody would be any the wiser.
 */
describe('password hashing cost', () => {
  it('production hashes at the argon2id defaults, whatever the suite does to itself', async () => {
    const hash = await productionArgon2Hash('a-password-worth-protecting', { type: argon2.argon2id });
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/);
  });

  it('the suite hashes cheaply, and the two are not the same thing', async () => {
    const hash = await argon2.hash('a-password-worth-protecting', { type: argon2.argon2id });
    expect(hash).toContain(`m=${CHEAP_ARGON2.memoryCost},p=${CHEAP_ARGON2.parallelism},t=${CHEAP_ARGON2.timeCost}`);
    expect(CHEAP_ARGON2.memoryCost).toBeLessThan(65536);
  });

  it('a cheap hash still round-trips, which is all the other tests ask of it', async () => {
    const hash = await argon2.hash('a-password-worth-protecting', { type: argon2.argon2id });
    expect(await argon2.verify(hash, 'a-password-worth-protecting')).toBe(true);
    expect(await argon2.verify(hash, 'the-wrong-password')).toBe(false);
  });
});
