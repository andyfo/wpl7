// @docs databases/adminer
/**
 * Adminer's own cookies, kept in the panel, one jar per front-door session. The browser only
 * ever holds the front door's `__Host-` cookie: dev sites share the domain Adminer is on, and
 * could otherwise set or overwrite Adminer's session cookie.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  /** A response's Set-Cookie headers: kept, or forgotten when they expire the cookie. */
  take(setCookie: readonly string[] | string | undefined): void {
    const lines = setCookie === undefined ? [] : typeof setCookie === 'string' ? [setCookie] : setCookie;
    for (const line of lines) {
      const [pair = '', ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired =
        value === 'deleted' ||
        attributes.some((a) => {
          const [k = '', v = ''] = a.split('=').map((x) => x.trim());
          return (k.toLowerCase() === 'max-age' && Number(v) <= 0) || (k.toLowerCase() === 'expires' && Date.parse(v) <= Date.now());
        });
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** The Cookie header for the next request. */
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}
