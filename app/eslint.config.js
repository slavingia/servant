// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Copied unchanged from Civic Research Studio (see its README).
    ignores: ['dist/*', 'src/lib/research-studio-vendor/*'],
  },
  {
    rules: {
      // React Native renders apostrophes in text as written; this rule is for HTML.
      'react/no-unescaped-entities': 'off',
      // Screens load data when they open; flag it, don't fail on it.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
