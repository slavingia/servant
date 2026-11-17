// On a phone every screen's code is in the app, so the first screen is ready as soon as the account is read.
// The browser's copy is use-first-screens.web.ts.
export function useFirstScreens(_ready: boolean, _signedIn: boolean, _pathname: string, _landing: string): boolean {
  return true;
}
