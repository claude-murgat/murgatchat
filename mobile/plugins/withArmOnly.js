// Expo config plugin : n'embarquer que les bibliothèques natives ARM (armeabi-v7a,
// arm64-v8a), celles des téléphones. Sans ce filtre, l'APK emporte aussi les .so
// x86/x86_64 précompilés de React Native et Hermes (émulateurs seulement), soit
// ~30 Mo de plus à chaque mise à jour téléchargée depuis l'appli.
// android.yml passe aussi -PreactNativeArchitectures pour ne compiler que l'ARM.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// murgat-abi-filters";

function patchBuildGradle(contents) {
  if (contents.includes(MARKER)) return contents; // already patched
  const defaultConfigRe = /defaultConfig\s*\{/;
  if (!defaultConfigRe.test(contents)) {
    throw new Error("[withArmOnly] `defaultConfig {` block not found in build.gradle");
  }
  return contents.replace(
    defaultConfigRe,
    (m) => `${m}\n        ${MARKER}\n        ndk { abiFilters "armeabi-v7a", "arm64-v8a" }`
  );
}

module.exports = function withArmOnly(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("[withArmOnly] expected a Groovy build.gradle");
    }
    cfg.modResults.contents = patchBuildGradle(cfg.modResults.contents);
    return cfg;
  });
};
