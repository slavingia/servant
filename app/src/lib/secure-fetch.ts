import { fetch as expoFetch } from 'expo/fetch';
import { getRandomBytesAsync } from 'expo-crypto';
import { encryptedFetch } from './tunnel-client';
export type { SecureResponse } from './tunnel-client';

export const secureFetch = (base: string, key: string | undefined, path: string, init: RequestInit = {}) =>
  encryptedFetch(base, key, path, init, expoFetch as typeof fetch, getRandomBytesAsync);
