import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const action = readFileSync(join(root, 'action.yml'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

test('release contract: package version has a matching changelog section', () => {
  assert.match(
    changelog,
    new RegExp(`^## \\[${packageJson.version.replaceAll('.', '\\.')}\\]`, 'm'),
  );
});

test('release contract: composite Action runs a supported Node version', () => {
  const engineMinimum = Number(packageJson.engines.node.match(/\d+/)?.[0]);
  const actionNode = Number(action.match(/node-version:\s*(\d+)/)?.[1]);

  assert.ok(Number.isFinite(engineMinimum), 'package engine minimum must be numeric');
  assert.ok(Number.isFinite(actionNode), 'Action node-version must be numeric');
  assert.ok(actionNode >= engineMinimum, `Action Node ${actionNode} is below package minimum ${engineMinimum}`);
  assert.match(action, /uses: actions\/setup-node@v7/);
  assert.match(action, /GITHUB_ACTION_PATH\/dist\/cli\.js/);
  assert.doesNotMatch(action, /npx --yes/);
});

test('release contract: hosted Action output redacts paths by default', () => {
  const redactInput = action.match(/\n  redact:\n([\s\S]*?)\n  max-depth:/)?.[1] ?? '';
  const tokenInput = action.match(/\n  github-token:\n([\s\S]*?)\n\noutputs:/)?.[1] ?? '';

  assert.match(redactInput, /default:\s*'paths'/);
  assert.match(redactInput, /reduce file paths/);
  assert.match(tokenInput, /default:\s*''/);
  assert.match(tokenInput, /Required when/);
  assert.doesNotMatch(tokenInput, /\$\{\{/);
});
