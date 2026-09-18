module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
  globals: {
    wx: 'readonly',
    App: 'readonly',
    Page: 'readonly',
    Component: 'readonly',
    Behavior: 'readonly',
    getApp: 'readonly',
    getCurrentPages: 'readonly',
  },
  extends: 'eslint:recommended',
  rules: {
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    'no-console': 'off',
  },
  ignorePatterns: ['**/node_modules/', 'miniprogram_npm/', '*.min.js'],
};
