const fs = require("fs");
const path = require("path");

// Dynamic Expo config. Expo reads app.json first and passes its `expo` content
// here as `config`; we override only what the release pipeline needs to inject:
//   - ANDROID_VERSION_CODE: monotonic integer derived from the git tag in CI
//     (app.json's android.versionCode stays the local/default fallback).
//   - APP_VERSION: versionName (tag minus the leading "v").
//   - google-services.json (FCM): wired only when the file exists, so builds
//     without it don't fail at prebuild. In CI it's materialized from a secret
//     before prebuild; locally, drop it into mobile/.
// With neither env var set (local dev / prebuild), app.json values are used as-is.
module.exports = ({ config }) => {
  if (process.env.APP_VERSION) {
    config.version = process.env.APP_VERSION;
  }
  if (process.env.ANDROID_VERSION_CODE) {
    config.android = {
      ...config.android,
      versionCode: Number(process.env.ANDROID_VERSION_CODE),
    };
  }
  if (fs.existsSync(path.join(__dirname, "google-services.json"))) {
    config.android = {
      ...config.android,
      googleServicesFile: "./google-services.json",
    };
  }
  return config;
};
