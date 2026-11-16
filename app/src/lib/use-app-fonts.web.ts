import { FontDisplay, useFonts } from "expo-font";
import { APP_FONT, APP_FONT_FACES } from "./fonts";

// A browser and the Mac app have no embedded fonts: load Allo's faces and show the system font until they arrive.
export function useAppFonts() {
  useFonts([{ fontFamily: APP_FONT, fontDefinitions: APP_FONT_FACES.map(face => ({ ...face, display: FontDisplay.SWAP })) }]);
}
