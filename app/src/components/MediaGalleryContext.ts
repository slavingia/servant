import { createContext, useContext } from "react";
import type { Attachment } from "../lib/server";

type GalleryContextValue = {
  open: (file: Attachment) => void;
  load: (file: Attachment) => Promise<string>;
  invalidate: (id: string) => void;
};

export const GalleryContext = createContext<GalleryContextValue | null>(null);
export const useMediaGallery = () => useContext(GalleryContext);
