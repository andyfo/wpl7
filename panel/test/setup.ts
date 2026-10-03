import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import argon2 from 'argon2';

/**
 * Argon2 is deliberately expensive - 64 MiB and three passes per hash - which is the entire
 * point in production and about 70% of this suite's CPU in CI. `seed()` mints one hash per
 * `makeWorld()` and there are 239 of those, on a two-core runner.
 *
 * Tests need a hash that round-trips, not one that costs anything, so every hash minted under
 * vitest uses the cheapest parameters argon2 accepts. `verify()` reads its cost from the encoded
 * hash rather than from options, so patching `hash()` makes both ends cheap on its own.
 *
 * Nothing in src/ changes: production has no knob here to set wrong. The pristine function is
 * kept so one test can still assert what production actually spends - see
 * test/unit/passwordHashing.test.ts, which fails if these two ever become the same thing.
 *
 * Test files share a process (`isolate: false` in vitest.config.ts), and this file runs again
 * before each of them, by then with argon2 patched already. The pristine function is taken from
 * the first run, so a later one never mistakes the patch for production.
 */
const PRISTINE = Symbol.for('wpl7.test.productionArgon2Hash');
const saved = globalThis as { [PRISTINE]?: typeof argon2.hash };
export const productionArgon2Hash: typeof argon2.hash = (saved[PRISTINE] ??= argon2.hash.bind(argon2));

export const CHEAP_ARGON2 = { memoryCost: 512, timeCost: 1, parallelism: 1 } as const;

argon2.hash = ((password: Parameters<typeof argon2.hash>[0], options?: Record<string, unknown>) =>
  productionArgon2Hash(password, { ...options, ...CHEAP_ARGON2 })) as typeof argon2.hash;

/**
 * RSA keys are the suite's other expensive mint: every server FTP is set up on gets a 3072-bit
 * host key and a 2048-bit certificate, and every DKIM key is 2048 bits - a prime search of 50 ms
 * to over a second each, and most of test/unit/ftpSync.test.ts's runtime.
 *
 * A test needs a real key of the size asked for, and one that differs from the key before it -
 * not a fresh one. So the first few RSA keys of each kind (size and encoding) a process asks for
 * are generated for real, and after that the same ones are handed out again in turn. Every other
 * key type is generated as usual. Patched once per process, for the reason argon2 is above.
 */
const RSA_KEYS_PER_KIND = 4;
const RSA_PATCHED = Symbol.for('wpl7.test.rsaKeyReuse');
const patchState = globalThis as { [RSA_PATCHED]?: true };
if (!patchState[RSA_PATCHED]) {
  patchState[RSA_PATCHED] = true;
  type Pair = { publicKey: unknown; privateKey: unknown };
  const kinds = new Map<string, { keys: Pair[]; served: number }>();
  const kindOf = (options: unknown) => {
    const key = JSON.stringify(options ?? {});
    let kind = kinds.get(key);
    if (!kind) kinds.set(key, (kind = { keys: [], served: 0 }));
    return kind;
  };
  // A DER public key is a Buffer, which a caller could write to; strings and KeyObjects cannot be.
  const handOut = (kind: { keys: Pair[]; served: number }): Pair => {
    const pair = kind.keys[kind.served++ % kind.keys.length]!;
    const copy = (v: unknown) => (Buffer.isBuffer(v) ? Buffer.from(v) : v);
    return { publicKey: copy(pair.publicKey), privateKey: copy(pair.privateKey) };
  };

  const realSync = crypto.generateKeyPairSync.bind(crypto) as (type: string, options?: unknown) => Pair;
  crypto.generateKeyPairSync = ((type: string, options?: unknown) => {
    if (type !== 'rsa') return realSync(type, options);
    const kind = kindOf(options);
    if (kind.keys.length >= RSA_KEYS_PER_KIND) return handOut(kind);
    const pair = realSync(type, options);
    kind.keys.push(pair);
    kind.served++;
    return pair;
  }) as typeof crypto.generateKeyPairSync;

  type Callback = (err: Error | null, publicKey?: unknown, privateKey?: unknown) => void;
  const realAsync = crypto.generateKeyPair.bind(crypto) as (type: string, options: unknown, cb: Callback) => void;
  const generateKeyPair = (type: string, options: unknown, cb: Callback): void => {
    if (type !== 'rsa') return realAsync(type, options, cb);
    const kind = kindOf(options);
    if (kind.keys.length >= RSA_KEYS_PER_KIND) {
      const pair = handOut(kind);
      process.nextTick(cb, null, pair.publicKey, pair.privateKey);
      return;
    }
    kind.served++;
    realAsync(type, options, (err, publicKey, privateKey) => {
      if (!err && kind.keys.length < RSA_KEYS_PER_KIND) kind.keys.push({ publicKey, privateKey });
      cb(err, publicKey, privateKey);
    });
  };
  // What util.promisify(crypto.generateKeyPair) resolves to: both halves, by name.
  Object.defineProperty(generateKeyPair, promisify.custom, {
    value: (type: string, options: unknown) =>
      new Promise<Pair>((resolve, reject) =>
        generateKeyPair(type, options, (err, publicKey, privateKey) => (err ? reject(err) : resolve({ publicKey, privateKey }))),
      ),
  });
  crypto.generateKeyPair = generateKeyPair as typeof crypto.generateKeyPair;
  // Named imports of node:crypto are a separate binding; bring them in line with the patch.
  syncBuiltinESMExports();
}
