// Web file picker for profile photos. The shared expo-image-picker web code throws on any file whose
// MIME type is blank (Windows reports none for some photos) and the caller never caught it, so
// choosing a photo did nothing. This one goes by what the browser can actually decode.
export type PickedImage = { uri: string; width: number; height: number };

export function pickImageOnWeb(): Promise<PickedImage | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.jpg,.jpeg,.jfif,.png,.webp,.gif,.bmp,.avif";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("cancel", () => { input.remove(); resolve(null); });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      const uri = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = () => resolve({ uri, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => { URL.revokeObjectURL(uri); reject(new Error("not an image")); };
      img.src = uri;
    });
    input.click();
  });
}
