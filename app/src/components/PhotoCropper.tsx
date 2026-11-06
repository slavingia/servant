// Native pickers show their own crop screen, so this only renders on web (see PhotoCropper.web.tsx).
export type CropSource = { uri: string; width: number; height: number };
type Props = { source: CropSource | null; onCancel: () => void; onDone: (base64: string) => void };
export function PhotoCropper(_props: Props) { return null; }
