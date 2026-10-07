import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'test/**/*.js'],
    ignores: ['server/wwwroot/**'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['server/wwwroot/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
];
