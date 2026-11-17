import { createContext, useContext } from "react";
import type { Attachment } from "../lib/server";

type GalleryContextValue = {
  open: (file: Attachment) => void;
  load: (file: Attachment) => Promise<string>;
  /** The bytes of a file that has already loaded here, without asking again. */
  peek: (id: string) => string | undefined;
  invalidate: (id: string) => void;
};

export const GalleryContext = createContext<GalleryContextValue | null>(null);
export const useMediaGallery = () => useContext(GalleryContext);
