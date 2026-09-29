# lifetrial

Windows-local backend for **life-testing survival curves and censoring analysis** on
anonymous synthetic **part** lifetime data. API + CLI + reproducible data generator +
automated tests only. There is deliberately **no web UI, no medical/diagnostic logic,
and no connection to real test equipment**.

Scope: independent specimens, a single event type, observation origin at time 0
(no delayed entry), event times or right-censoring times with a recorded censor reason.

## Statistical methods (implemented from scratch)

- **Kaplan–Meier** product-limit curve with per-time risk set `n(t)`, events `d(t)`
  and censored `c(t)`.
- **Tie rule (documented):** when failures and right-censoring share a time, failures
  are counted first. All units at that time are in the risk set; `S` jumps by
  `(n-d)/n`, then censored units leave. Censoring is **never** treated as a failure.
- **Greenwood variance** `S(t)^2 · Σ d_j/(n_j(n_j-d_j))`.
- **Confidence intervals** with an explicit method choice:
  `loglog` (Kalbfleisch–Prentice log(-log), default) or `linear` Greenwood.
- **Median survival** = first event time with `S(t) ≤ 0.5`; if the curve never reaches
  0.5 the median is reported as **not reached** (max observed time is never substituted).
- **RMST** = area under the KM step curve up to an explicit truncation horizon
  (defaults to the last observed time; the tail beyond the data is held flat and noted).
- **Two-group log-rank test** (unstratified Mantel–Haenszel): per-event-time observed,
  expected (`d·n1/n`) and hypergeometric variance
  `n1·n2·d·(n-d)/(n²·(n-1))`; `χ² = (Σ(O₁-E₁))²/V` on 1 df with a p-value.
  Zero variance (all-censored or every risk set failing completely) yields
  `chiSquare = null` with an explicit note; a missing group is a `MISSING_GROUP` error.

## Data governance

- Each analysis runs on a **frozen immutable snapshot** (`dataset_versions`).
  Correcting an endpoint or event status creates a **new version**; prior versions
  and their reports stay intact.
- Repeated submissions are **idempotent**: snapshots via `idempotencyKey`,
  reports via a parameter hash.
- A dataset has one time unit (`hours|cycles|days|weeks`) and one origin, so group
  comparisons cannot mix time units or observation orientations.

## Requirements

- Node.js **>= 22.5** (uses built-in `node:sqlite`; tested on Node 25 on Windows).
- No native modules; dev dependencies are TypeScript tooling only.

## Install

```powershell
npm install
```

## Tests

```powershell
npm test                 # all unit + persistence + HTTP end-to-end tests
npm run typecheck        # strict TypeScript check
```

Fixtures cover: no censoring, all censored, event/censor ties, zero-time events,
crossing and non-crossing curves, tiny samples, hand-checked step values/area/test
statistics, decreasing risk sets, interval boundaries, duplicate imports and
restart reproduction. Transaction rollback and persistence after restart are tested.

## Reproducible end-to-end demo

```powershell
npm run demo
```

Generates seeded synthetic shaft data, freezes a snapshot, computes curves/RMST,
explains censoring, runs the log-rank comparison and exports a frozen report.
Outputs (`tmp/demo-subjects.json`, `tmp/demo-report.json`) are byte-identical across runs.

## HTTP API (start / stop)

```powershell
npm start
```

The server binds **127.0.0.1 only** on an **OS-assigned free port** (printed at
startup, e.g. `http://127.0.0.1:53124`). Stop it with `Ctrl+C` (SIGINT/SIGTERM
closes the server and database cleanly). Set a custom database file with
`$env:LIFETRIAL_DB="data/custom.db"`.

Endpoints (JSON; list endpoints accept `?limit=&offset=`):

- `GET  /health`
- `POST /api/generate` — seeded synthetic generator
  body: `{ perGroup, groups:[{label,failureRate}], censorRate, maxTime, seed }`
- `POST /api/datasets` — `{ name, timeUnit, description? }`
- `GET  /api/datasets` / `GET /api/datasets/:id`
- `POST /api/datasets/:id/versions` — freeze snapshot
  body: `{ subjects:[{anonId,group,time,status,censorReason?}], changeNote, idempotencyKey?, expectedVersion? }`
- `GET  /api/datasets/:id/versions`
- `GET  /api/versions/:vid/subjects` — paginated
- `POST /api/datasets/:id/curves` — `{ group, version?, ciMethod?, confidenceLevel?, horizon? }`
- `POST /api/datasets/:id/compare` — `{ groupA, groupB, version? }`
- `GET  /api/datasets/:id/censoring?group=&version=`
- `GET  /api/versions/:vid/reports` — paginated
- `GET  /api/reports/:id` — frozen report with params and result

Errors return `{ error: { code, message, details } }` with codes such as
`VALIDATION_ERROR`, `BAD_REQUEST`, `NOT_FOUND`, `MISSING_GROUP`,
`VERSION_CONFLICT`, `DUPLICATE_SUBJECT`.

## CLI

```powershell
npx tsx src/cli/index.ts --help

npx tsx src/cli/index.ts init      --name shafts --unit hours
npx tsx src/cli/index.ts generate  --seed 7 --per-group 30 --rates A:0.02,B:0.05 --out tmp/parts.json
npx tsx src/cli/index.ts import    --dataset 1 --file examples/shafts.csv --note "fixture"
npx tsx src/cli/index.ts list
npx tsx src/cli/index.ts curve     --dataset 1 --group control --horizon 200
npx tsx src/cli/index.ts risk-table --dataset 1 --group control
npx tsx src/cli/index.ts compare   --dataset 1 --a control --b treated
npx tsx src/cli/index.ts censoring --dataset 1
npx tsx src/cli/index.ts report    --id 1 --out tmp/report.json
```

CSV columns: `anon_id,group,time,status,censor_reason` (`status` is `event` or
`censored`; `censor_reason` is required for censored rows). Mutating CLI commands
print `[before]`/`[after]` state. Re-importing the same file is an idempotent replay.

## Data locations & cleanup

All databases and generated files stay inside this project (`data/`, `tmp/`).
Startup/cleanup never touches processes outside this project.

```powershell
npm run clean            # removes only ./data, ./tmp and ./dist
```
