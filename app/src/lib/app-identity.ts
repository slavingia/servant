import Constants from "expo-constants";

export const appName = Constants.expoConfig?.name || "Servant";
// The UX research and design features (Design Studio, Research Studio and
// study readouts) are grouped in the app under this name.
export const studioName = "Servant Studio";
export const nativePushConfigured = Constants.expoConfig?.extra?.nativePushConfigured !== false;
