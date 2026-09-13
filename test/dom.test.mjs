/**
 * main.js grabs every element by id at module load and immediately binds
 * listeners, so a single typo'd or renamed id crashes the whole app on boot.
 * This checks the markup and the script agree, without needing a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const main = readFileSync(join(root, 'js/main.js'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...main.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

test('every id main.js looks up exists in index.html', () => {
  const missing = [...usedIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `main.js references ids not in the markup: ${missing.join(', ')}`);
});

test('index.html has no duplicate ids', () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], []);
});

test('every screen the router shows is a real section with class "screen"', () => {
  const shown = new Set([...main.matchAll(/show\('([^']+)'\)/g)].map((m) => m[1]));
  const screens = new Set(
    [...html.matchAll(/<section id="([^"]+)" class="screen/g)].map((m) => m[1]),
  );
  const bad = [...shown].filter((id) => !screens.has(id));
  assert.deepEqual(bad, [], `show() targets that are not .screen sections: ${bad.join(', ')}`);
});

test('the autocomplete listbox and input are wired to each other', () => {
  assert.ok(html.includes('aria-controls="guess-list"'));
  assert.ok(htmlIds.has('guess-list'));
  assert.ok(htmlIds.has('guess-input'));
});

test('css defines the state classes the scripts toggle', () => {
  for (const cls of ['is-current', 'is-done', 'is-active', 'is-playing', 'is-error', 'is-wrong']) {
    assert.ok(css.includes(`.${cls}`), `missing style for .${cls}`);
  }
});

test('scripts load as modules so the import graph resolves', () => {
  assert.match(html, /<script type="module" src="js\/main\.js">/);
});
