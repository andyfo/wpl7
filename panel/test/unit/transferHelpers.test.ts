import { describe, expect, it } from 'vitest';
import { sameSecret } from '../../src/lib/crypto.js';
import { CHUNK_MAX, CHUNK_MIN, CHUNK_START, nextChunkSize } from '../../shared/transferPlan.js';
import * as uploadPlan from '../../web/src/lib/uploadPlan.js';

describe('sameSecret', () => {
  it('is true only for the same string', () => {
    const token = 'n3Q8m1X0pR6tYv2Lk9Hs4Wd7Fg5Jc0Bz1Ae8Uq3Ti6O';
    expect(sameSecret(token, token)).toBe(true);
    expect(sameSecret(token, `${token.slice(0, -1)}P`)).toBe(false);
    expect(sameSecret(token, token.slice(0, -1))).toBe(false);
    expect(sameSecret('', '')).toBe(true);
    expect(sameSecret('', 'x')).toBe(false);
  });

  it('compares bytes, not characters', () => {
    // Same length in UTF-16 code units, different in UTF-8 bytes.
    expect(sameSecret('é', 'e')).toBe(false);
    expect(sameSecret('é', 'é')).toBe(true);
  });
});

describe('transfer plan', () => {
  it('is the one the uploads use', () => {
    expect(uploadPlan.nextChunkSize).toBe(nextChunkSize);
    expect(uploadPlan.CHUNK_START).toBe(CHUNK_START);
  });

  it('stays inside a smaller ceiling when one is given', () => {
    const ceiling = 512 * 1024;
    expect(nextChunkSize(CHUNK_START, 100, ceiling)).toBe(ceiling);
    expect(nextChunkSize(ceiling, 60_000, ceiling)).toBe(CHUNK_MIN);
    expect(nextChunkSize(64 * 1024, 100, 100 * 1024)).toBe(100 * 1024);
    expect(nextChunkSize(64 * 1024, 60_000, 100 * 1024)).toBe(100 * 1024);
    expect(nextChunkSize(CHUNK_MAX, 100)).toBe(CHUNK_MAX);
  });
});
