// Over-the-air updates are off unless the build is told where the server's
// update address is. Set SERVANT_OTA_URL (for example https://servant.example/ota/manifest)
// when building. The address is fixed in the build; the app never changes it
// at runtime, so the version built into the app always remains as the fallback
// if the server is unreachable or has nothing for this build. See docs/ota.md.
module.exports = ({ config }) => {
  const url = (process.env.SERVANT_OTA_URL || "").trim();
  if (!url) return config;
  if (!/^https:\/\/[^\s/]+\/ota\/manifest$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/ota\/manifest$/.test(url)) {
    throw new Error("SERVANT_OTA_URL must be https://<host>/ota/manifest (http only for localhost)");
  }
  return { ...config, updates: { ...config.updates, enabled: true, url } };
};
