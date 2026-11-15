import type { ReactNode } from "react";

// In a browser there is no gesture library to set up (see GestureRoot.tsx).
export function GestureRoot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
