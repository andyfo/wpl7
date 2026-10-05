import { loginFor } from '../lib/loginNext';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let unsavedWork = 0;

/**
 * The sign-in page, with the trailing slash react-router also accepts. A 401 there is an answer
 * (a wrong password) to show; anywhere else, /login/x included, it means signing in.
 */
const SIGN_IN_PAGE = /^\/login\/?$/;

/**
 * Say the page holds work that is not saved (the file editor's text) until the returned
 * function is called. Meanwhile a 401 does not send the browser to /login - a background
 * poll finding the session expired must not throw the work away, or ask "Leave site?" every
 * few seconds. The 401 is thrown as usual; the editor tells the operator to sign in again
 * in another tab and then save.
 */
export function holdOffLoginRedirect(): () => void {
  unsavedWork++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsavedWork--;
  };
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; formData?: FormData } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET' && method !== 'HEAD') headers['x-csrf'] = '1';
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, { method, headers, body, credentials: 'same-origin' });

  if (res.status === 401 && !SIGN_IN_PAGE.test(location.pathname)) {
    // The approval page an AI app sent its admin to comes back after the sign-in, request
    // and all; every other page starts again from the dashboard.
    if (unsavedWork === 0) location.href = loginFor(location.pathname, location.search);
    throw new ApiError(401, 'unauthorized', 'Session expired');
  }
  if (res.status === 204) return undefined as T;

  const json = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string; details?: unknown } }
    | null;
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(res.status, err?.code ?? 'internal', err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return json as T;
}
