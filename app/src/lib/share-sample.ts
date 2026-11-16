// Sample shares for the web build, where there is no share sheet: /share?sample=photo opens the
// Send to agent screen with made-up content, so the screen can be checked and screenshotted in a
// browser (and sent, against a test server). Native builds never use this.
import type { SharedContent, SharedFile } from "./share-payload";

export const SAMPLE_KINDS = ["photo", "photos", "files", "link", "text", "toobig", "unsupported"] as const;

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n";

const bytesOf = (base64: string) => Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

// A photo-like PNG painted in the browser, so thumbnails look real and the bytes are a real image.
function paintedPhoto(index: number): string {
  if (typeof document === "undefined") return TINY_PNG;
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 480;
  const ctx = canvas.getContext("2d");
  if (!ctx) return TINY_PNG;
  const tones = [["#1E265D", "#4E61D6"], ["#27327A", "#2E8540"], ["#171E4E", "#DEEF51"]][index % 3]!;
  const sky = ctx.createLinearGradient(0, 0, 0, 480);
  sky.addColorStop(0, tones[0]!); sky.addColorStop(1, tones[1]!);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(90 + i * 115 + (index * 37) % 50, 300 - (i % 2) * 60, 70 + (i * 13) % 40, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = "#FFFFFF"; ctx.font = "bold 36px system-ui, sans-serif"; ctx.fillText(`Sample photo ${index + 1}`, 32, 440);
  return canvas.toDataURL("image/png").split(",")[1] ?? TINY_PNG;
}

const photo = (index: number, name: string): SharedFile => {
  const base64 = paintedPhoto(index);
  return { uri: `data:image/png;base64,${base64}`, name, mime: "image/png", size: bytesOf(base64), kind: "image" };
};
const pdf = (name: string): SharedFile => {
  const base64 = typeof btoa === "function" ? btoa(PDF) : "";
  return { uri: `data:application/pdf;base64,${base64}`, name, mime: "application/pdf", size: PDF.length, kind: "file" };
};

export function sampleShare(kind: string | string[] | undefined): SharedContent | null {
  switch (Array.isArray(kind) ? kind[0] : kind) {
    case "photo": return { files: [photo(0, "IMG_4821.jpg")], text: "", url: null };
    case "photos": return { files: [photo(0, "IMG_4821.jpg"), photo(1, "IMG_4822.jpg"), photo(2, "IMG_4823.jpg")], text: "", url: null };
    case "files": return { files: [pdf("Refund timeline FY26.pdf"), photo(1, "Screenshot 2026-11-09.png")], text: "", url: null };
    case "link": return { files: [], text: "https://www.example.gov/refunds", url: "https://www.example.gov/refunds" };
    case "text": return { files: [], text: "From the 2pm call: amended returns are running 16+ weeks. Draft a short status note for the refund desk.", url: null };
    // Over the limit: the card says so before any bytes are read, and Send waits until it's removed; the PDF can still go.
    case "toobig": return { files: [{ uri: "data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", name: "Town hall recording.zip", mime: "application/zip", size: 101 * 1024 * 1024, kind: "file" }, pdf("Refund timeline FY26.pdf")], text: "", url: null };
    // A video type Servant can't send, beside a photo that can.
    case "unsupported": return { files: [{ uri: "data:video/x-msvideo;base64,", name: "Town hall clip.avi", mime: "video/x-msvideo", size: 8 * 1024 * 1024, kind: "video" }, photo(0, "IMG_4821.jpg")], text: "", url: null };
    default: return null;
  }
}
