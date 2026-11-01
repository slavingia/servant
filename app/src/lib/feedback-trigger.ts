// Shake detection for "Something wrong here?", kept pure so it can be tested
// without a device. Samples are accelerometer readings in g (1g = gravity).

export type Sample = { x: number; y: number; z: number; t: number };

export const SHAKE = {
  // A real shake swings well past gravity; walking or a bumpy ride rarely does.
  threshold: 2.2,
  // Peaks needed inside the window, each at least `gap` apart.
  peaks: 3,
  window: 1000,
  gap: 120,
  // After a shake fires, ignore the next one for this long.
  cooldown: 3000,
};

export function createShakeDetector(options: Partial<typeof SHAKE> = {}) {
  const o = { ...SHAKE, ...options };
  let peaks: number[] = [];
  let lastFire = -Infinity;
  let aboveThreshold = false;
  return function push(s: Sample): boolean {
    const g = Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z);
    if (g < o.threshold) {
      aboveThreshold = false;
      return false;
    }
    // Count a new swing only after it settles below the threshold. Sampling
    // one sustained jolt after each gap must not turn it into several peaks.
    if (aboveThreshold) return false;
    aboveThreshold = true;
    if (s.t - lastFire < o.cooldown) return false;
    if (peaks.length && s.t - peaks[peaks.length - 1] < o.gap) return false;
    peaks = [...peaks.filter((p) => s.t - p <= o.window), s.t];
    if (peaks.length < o.peaks) return false;
    peaks = [];
    lastFire = s.t;
    return true;
  };
}

// Older Android versions need broad photo access for screenshot detection.
// Keep reporting available through shake/settings and the explicit photo picker.
export function supportsScreenshotFeedback(platform: string, version: number | string): boolean {
  return platform === "ios" || (platform === "android" && Number(version) >= 34);
}

export function feedbackGestureHint(platform: string, version: number | string): string {
  if (platform !== "ios" && platform !== "android") return "";
  return supportsScreenshotFeedback(platform, version)
    ? "You can also shake your phone or take a screenshot on the screen that's wrong."
    : "You can also shake your phone on the screen that's wrong.";
}

// Screens where the prompt would be in the way or meaningless.
export function feedbackPromptAllowed(pathname: string, paired: boolean): boolean {
  if (!paired) return false;
  return !["/feedback", "/welcome", "/pair", "/scan"].includes(pathname);
}
