// Static no-undef check: an undeclared variable (like the Weekly ATR `ticker` ReferenceError) fails CI instead of the live UI.
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('path');
const { ESLint } = require('eslint');
const root = path.join(__dirname, '..');
const lint = async (files, env, globals = {}) => {
  const eslint = new ESLint({ cwd: root, useEslintrc: false, overrideConfig: { env: { es2022: true, ...env }, parserOptions: { ecmaVersion: 2022, sourceType: 'script' }, globals, rules: { 'no-undef': 'error' } } });
  const res = await eslint.lintFiles(files);
  return res.flatMap((r) => r.messages.map((m) => path.relative(root, r.filePath) + ':' + m.line + ' ' + m.message));
};
test('no undeclared variables in the server code', async () => {
  assert.deepEqual(await lint(['server/**/*.js'], { node: true }), []);
});
test('no undeclared variables in the shared engines (browser + Node)', async () => {
  assert.deepEqual(await lint(['public/strategy-*.js'], { node: true, browser: true }), []);
});
test('no undeclared variables in the Strategy Builder page script', async () => {
  assert.deepEqual(await lint(['public/builder.js'], { browser: true }, { Strategy: 'readonly', Deriv: 'readonly' }), []);
});
