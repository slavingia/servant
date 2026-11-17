import { Platform } from "react-native";

// In a browser and the Mac app the page itself draws the app's shape before any script runs
// (public/index.html, #launch). The app's script empties #root as soon as it starts, about a third of a
// second before it has a frame of its own: with the shape inside #root that was a blank page on every open.
// So the shape sits over the page, outside #root, and the app takes it away with its first frame, which is
// the launch screen drawing the same shape (LaunchScreen.tsx), so nothing is seen to change.

/** Called from the root layout's first frame. A phone has no page: its launch screen is the system's. */
export function removeLaunchPage() {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  document.getElementById("launch")?.remove();
}
