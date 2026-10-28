# Spectrum Orbs

A kinetic sculpture gallery ordering puzzle. Move the top orb between tubes
until every tube holds a single color.

A StarHermit engine script game (engine 1.20.1, `engine.minor=20`): one
package played natively by the StarHermit client and in browsers by the
engine's web runtime (the `index.html` loader). See `spec.md`.

## Run and check

```
STARHERMIT=~/sh/runtime/1.20.1/starhermit-1.20.1-linux-x86_64/starhermit
$STARHERMIT .            # play natively
npm run package          # after every change: web loader + starhermit-files.json
npm test                 # unit tests + native checks and play scripts
npm run test:browser     # the packaged game in GPU Chrome (desktop, phone, landscape)
npm run css              # tools/ui-style.css → assets/ui-style.json
npm run plays            # regenerate tests/native/*.play from the solver
npm run textures         # rebake assets/terrazzo-*.png
npm start                # local dev server (server.js)
```

## Layout

- `native/*.ts` — the client: state machine (`main.ts`), screens (`screens.ts`),
  the 3D gallery (`render.ts`), sound, save/platform, quality tiers, styles, i18n
- `js/rng.js`, `rules.js`, `content.js`, `session.js` — the pure rules, content and
  session, shared with `server.js` and the tests
- `js/progress.js` — save model and migrations; `js/strings.js`, `lang.js`,
  `sh-strings.js` — the nine locales
- `score-script.js` — the platform script that range-checks posted scores
