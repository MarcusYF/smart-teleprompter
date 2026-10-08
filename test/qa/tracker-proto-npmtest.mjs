// Runs the app's own test suite (every test/*.test.mjs, unmodified)
// against the prototype fixes in test/qa/proto-tracker/, by redirecting
// imports of public/lib/{tracker,follower}.js.
//
//   node test/qa/tracker-proto-npmtest.mjs
//
// (Not a *.test.mjs file on purpose: `node --test test/qa/` should not run
// the main suite a second time.)
import { registerHooks } from 'node:module';

const LIB = new URL('../../public/lib/', import.meta.url).href;
const PROTO = new URL('./proto-tracker/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    for (const m of ['tracker.js', 'follower.js']) {
      if (r.url === LIB + m) return { ...r, url: PROTO + m };
    }
    return r;
  },
});
const { readdirSync } = await import('node:fs');
const files = readdirSync(new URL('..', import.meta.url)).filter((f) => f.endsWith('.test.mjs')).sort();
console.log(`running ${files.map((f) => 'test/' + f).join(', ')} with`, PROTO);
for (const f of files) await import(new URL('../' + f, import.meta.url));
