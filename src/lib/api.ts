const SESSION_TOKEN_KEY = 'aph_session_token';

export function getStoredSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Ignore storage quota / sandbox restrictions
  }
}

export function clearStoredSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Ignore storage restrictions
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getStoredSessionToken();

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const resp = await fetch(input, {
    ...init,
    credentials: 'include',
    headers,
  });

  const refreshedToken = resp.headers.get('X-Aph-Session-Token');
  if (refreshedToken) {
    setStoredSessionToken(refreshedToken);
  }

  return resp;
}
