// Expo config plugin: wire a `release` signing config into the Android project
// that `expo prebuild` generates, WITHOUT committing android/ or sed-ing blindly.
//
// Design goals:
//  - In CI, the release APK is signed with our stable upload keystore (so updates
//    install over each other). The keystore path + passwords come from Gradle
//    properties MURGAT_UPLOAD_* (fed by ORG_GRADLE_PROJECT_* env vars in the job).
//  - Locally (no MURGAT_UPLOAD_* properties), the build must still work: the
//    release buildType falls back to the debug signingConfig. So `assembleRelease`
//    on a dev machine keeps producing a debug-signed (but functional) APK.
//  - Idempotent: re-running prebuild won't double-insert.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// murgat-release-signing";

// A `release` signingConfig guarded by hasProperty so it's inert without the
// upload-keystore Gradle properties (local builds don't define them).
const RELEASE_SIGNING_BLOCK = `        release {
            ${MARKER}
            if (project.hasProperty('MURGAT_UPLOAD_STORE_FILE')) {
                storeFile file(MURGAT_UPLOAD_STORE_FILE)
                storePassword MURGAT_UPLOAD_STORE_PASSWORD
                keyAlias MURGAT_UPLOAD_KEY_ALIAS
                keyPassword MURGAT_UPLOAD_KEY_PASSWORD
            }
        }`;

function patchBuildGradle(contents) {
  if (contents.includes(MARKER)) return contents; // already patched

  // 1. Add the `release` signingConfig right after `signingConfigs {`.
  //    The Expo/RN template always defines `signingConfigs { debug { … } }`.
  const signingConfigsRe = /signingConfigs\s*\{/;
  if (!signingConfigsRe.test(contents)) {
    throw new Error("[withReleaseSigning] `signingConfigs {` block not found in build.gradle");
  }
  contents = contents.replace(signingConfigsRe, (m) => `${m}\n${RELEASE_SIGNING_BLOCK}\n`);

  // 2. Point the release buildType at signingConfigs.release when the upload
  //    keystore is available, else keep debug. The template's release buildType
  //    ships `signingConfig signingConfigs.debug`; we swap that exact line, but
  //    only the one inside `buildTypes { … release { … } }`.
  const buildTypesIdx = contents.indexOf("buildTypes");
  if (buildTypesIdx === -1) {
    throw new Error("[withReleaseSigning] `buildTypes` block not found in build.gradle");
  }
  const head = contents.slice(0, buildTypesIdx);
  let tail = contents.slice(buildTypesIdx);
  const ternary =
    "signingConfig project.hasProperty('MURGAT_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug";
  // Replace the FIRST debug-signingConfig occurrence within buildTypes (that's
  // the release buildType's line in the RN template; the debug buildType above
  // it lives before this slice only if ordered debug-first — RN orders debug
  // then release, so the first match inside `buildTypes` is release's). To be
  // safe against ordering, target the line that is NOT inside a `debug {` body
  // by matching the release block specifically.
  tail = tail.replace(
    /(release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug/s,
    `$1${ternary}`
  );
  return head + tail;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("[withReleaseSigning] expected a Groovy build.gradle");
    }
    cfg.modResults.contents = patchBuildGradle(cfg.modResults.contents);
    return cfg;
  });
};
