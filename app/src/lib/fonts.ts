// Allo (https://allo.joshpuckett.me) is the app's typeface, under the SIL Open Font License (assets/fonts/OFL.txt).
// A phone build embeds these faces with the expo-font plugin in app.json; a browser and the Mac app load them
// with useAppFonts. Text picks a face with fontWeight and fontStyle, so every role keeps its weight.
export const APP_FONT = "Allo";

export const APP_FONT_FACES = [
  { path: require("../../assets/fonts/Allo-Regular.otf"), weight: 400 },
  { path: require("../../assets/fonts/Allo-Oblique.otf"), weight: 400, style: "italic" },
  { path: require("../../assets/fonts/Allo-Medium.otf"), weight: 500 },
  { path: require("../../assets/fonts/Allo-MediumOblique.otf"), weight: 500, style: "italic" },
  { path: require("../../assets/fonts/Allo-SemiBold.otf"), weight: 600 },
  { path: require("../../assets/fonts/Allo-SemiBoldOblique.otf"), weight: 600, style: "italic" },
  { path: require("../../assets/fonts/Allo-Bold.otf"), weight: 700 },
  { path: require("../../assets/fonts/Allo-BoldOblique.otf"), weight: 700, style: "italic" },
] as const;
