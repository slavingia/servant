import Constants from "expo-constants";

export const appName = Constants.expoConfig?.name || "Servant";
export const nativePushConfigured = Constants.expoConfig?.extra?.nativePushConfigured !== false;
