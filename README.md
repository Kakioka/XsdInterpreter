# XsdInterpreter
A tool to interpret an XSD schema as a GUI and create a valid XML for that schema

Github pages link: https://kakioka.github.io/XsdInterpreter/

## Development

No build step, no bundler, **no dependencies** — plain ES modules loaded by `index.html`.
Serve the folder over HTTP (the VS Code *Live Server* extension is what this is developed
against); `file://` does not work, because ES modules and the theme `fetch()` calls both
require it.

- **App:** `index.html` — load a folder of `.xsd` files to begin (try `sample-schemas/`).
- **Headless tests:** `npm test` (`node --test`) covers `js/core/`. Nothing is installed;
  `package.json` exists only so Node treats `.js` as ESM and has somewhere to put the script.
- **Browser tests:** `dev/phase1-check.html` … `dev/phase9-check.html`, one per implementation
  phase; each prints PASS/FAIL rows with a summary count.

`CLAUDE.md` documents the architecture, the testing setup, and the behavioral invariants;
`web-implementation-spec.md` is the source of truth for algorithms and behavior.
