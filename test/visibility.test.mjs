/**
 * The `hidden` attribute only hides things because of the user-agent rule
 * `[hidden] { display: none }`. Author styles beat the UA stylesheet in the
 * cascade regardless of specificity, so ANY class rule of ours that sets
 * `display` silently overrides `hidden` and leaves the element on screen.
 *
 * The other DOM tests assert the `hidden` *property* and jsdom does not model
 * cascade origin, so neither can catch this. This checks the stylesheet itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');

const OVERRIDE = /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/;

/** Every class named on an element that starts out hidden. */
function hiddenClasses() {
  const out = new Map();
  for (const tag of html.matchAll(/<(\w+)([^>]*\bhidden\b[^>]*)>/g)) {
    const attrs = tag[2];
    const id = attrs.match(/\bid="([^"]+)"/)?.[1] || `<${tag[1]}>`;
    const classes = (attrs.match(/\bclass="([^"]+)"/)?.[1] || '').split(/\s+/).filter(Boolean);
    for (const c of classes) {
      if (!out.has(c)) out.set(c, []);
      out.get(c).push(id);
    }
  }
  return out;
}

/** Class selectors in our stylesheet whose block sets `display`. */
function classesThatSetDisplay() {
  const found = new Map();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const display = body.match(/(?:^|[;\s])display\s*:\s*([^;]+)/);
    if (!display) continue;
    for (const cls of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      if (!found.has(cls[1])) found.set(cls[1], display[1].trim());
    }
  }
  return found;
}

test('no class rule quietly overrides the hidden attribute', () => {
  const setsDisplay = classesThatSetDisplay();
  const conflicts = [];
  for (const [cls, ids] of hiddenClasses()) {
    if (setsDisplay.has(cls)) conflicts.push(`.${cls} sets display:${setsDisplay.get(cls)} on #${ids.join(', #')}`);
  }
  assert.ok(
    conflicts.length === 0 || OVERRIDE.test(css),
    'author styles outrank the UA stylesheet, so these hidden elements would still render:\n  ' +
    conflicts.join('\n  ') + '\nAdd `[hidden] { display: none !important; }` to styles.css.',
  );
});

test('the loading overlay starts hidden and the attribute actually wins', () => {
  assert.match(html, /<div id="loading"[^>]*\bhidden\b/);
  assert.match(css, OVERRIDE);
});
