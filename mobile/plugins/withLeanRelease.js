// Expo config plugin : une APK de release plus légère, et plus rapide à construire.
//  - n'embarquer que les bibliothèques natives ARM (armeabi-v7a, arm64-v8a), celles
//    des téléphones. Sans ce filtre, l'APK emporte aussi les .so x86/x86_64
//    précompilés de React Native et Hermes (émulateurs seulement), soit ~30 Mo de
//    plus à chaque mise à jour téléchargée depuis l'appli. android.yml passe aussi
//    -PreactNativeArchitectures pour ne compiler que l'ARM ;
//  - pas de « lint vital » pendant assembleRelease (une analyse par module, à
//    chaque release) : l'appli est gelée, ce contrôle n'apprend plus rien.
const { withAppBuildGradle } = require("expo/config-plugins");

const ABI_MARKER = "// murgat-abi-filters";
const LINT_MARKER = "// murgat-no-release-lint";

function patchBuildGradle(contents) {
  if (!contents.includes(ABI_MARKER)) {
    const defaultConfigRe = /defaultConfig\s*\{/;
    if (!defaultConfigRe.test(contents)) {
      throw new Error("[withLeanRelease] `defaultConfig {` block not found in build.gradle");
    }
    contents = contents.replace(
      defaultConfigRe,
      (m) => `${m}\n        ${ABI_MARKER}\n        ndk { abiFilters "armeabi-v7a", "arm64-v8a" }`
    );
  }
  if (!contents.includes(LINT_MARKER)) {
    const androidRe = /^android\s*\{/m;
    if (!androidRe.test(contents)) {
      throw new Error("[withLeanRelease] top-level `android {` block not found in build.gradle");
    }
    contents = contents.replace(
      androidRe,
      (m) => `${m}\n    ${LINT_MARKER}\n    lint { checkReleaseBuilds false }`
    );
  }
  return contents;
}

module.exports = function withLeanRelease(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("[withLeanRelease] expected a Groovy build.gradle");
    }
    cfg.modResults.contents = patchBuildGradle(cfg.modResults.contents);
    return cfg;
  });
};
