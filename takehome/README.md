# intakeAI — Take-Home Assignment 2

Everything you need is in this folder. Read `ASSIGNMENT.md` first; this file
just tells you how to get the pieces running.

```
.
├── ASSIGNMENT.md              the assignment
├── esource-mock/              a mock eSource platform — run it on localhost
└── data/
    ├── screening-visit.ir.json   the input file your agent consumes
    └── README.md                 what the input file's schema means
```

---

## Running the eSource mock

**Prerequisites:** Node.js 18 or newer (20+ recommended) and npm. Nothing else.
No account, no API key, no network access after `npm install`.

```bash
cd esource-mock
npm install
npm run dev
```

Then open **http://localhost:5173/**.

You should land on a screen titled **Visit Schedule** with an empty visits
table and an **+ Add Visit** button. That empty state is correct — the study
exists as a name (`ABC-101`) and nothing else. Everything in the input file
has to be built through the UI.

### Other commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on http://localhost:5173/ (hot reload) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |

The port is pinned to 5173. If something else is already using it, change
`server.port` in `esource-mock/vite.config.ts`.

### Resetting

The mock keeps everything in memory. **A page reload wipes the study**, which
is usually what you want between runs. `http://localhost:5173/?reset=1` clears
it without a reload.

### Checking what you built

Open DevTools on the mock's tab and call:

```js
__readState()      // the SAVED study, as JSON
__exportState()    // the same thing as a formatted string
__resetState()     // clear it
```

`__readState()` reports **saved** state only — drafts, open panels and
half-typed values never appear in it. Compare its output against
`data/abc-101-study.ir.json` to check your own work.

> These hooks exist so you can verify your results by hand. They are a
> convenience of this particular mock. Real eSource systems expose nothing like
> them, and the platform we evaluate your submission against may not either.
> **An agent that calls `__readState()`, or depends on it existing, has not
> solved the problem.**

---

## A note on what this mock is

This is one eSource platform. It is not *the* eSource platform. Its navigation,
its element library, the words it uses for field types, and its DOM are all
particular to it — a different vendor's product would differ in every one of
those respects while modelling exactly the same clinical concepts.

Please read the constraint in `ASSIGNMENT.md` carefully before you start
writing selectors.
