import { fetch as expoFetch } from 'expo/fetch';
import { getRandomBytesAsync } from 'expo-crypto';
import { encryptedFetch } from './tunnel-client';
export type { SecureResponse } from './tunnel-client';

// X-Servant-Reverify: this build has the confirm-it's-you screen, so a session that ended may be
// answered with 401 session_expired (older builds get a 403 they show as a message, never a sign-out).
export const secureFetch = (base: string, key: string | undefined, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('X-Servant-Reverify', '1');
  return encryptedFetch(base, key, path, { ...init, headers }, expoFetch as typeof fetch, getRandomBytesAsync);
};
