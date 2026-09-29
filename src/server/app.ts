import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, errorStatus } from '../errors.js';
import {
  addVersion,
  createDataset,
  findDatasetByName,
  getReport,
  listDatasets,
  listReports,
  listVersions,
} from '../repo.js';
import { analyzeGroup, compareGroups, loadFrozen } from '../service.js';
import { validateDatasetInput, type ValidatedDataset } from '../validate.js';
import type { Clock } from '../db.js';

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const json = JSON.stringify(body, (_k, v) => (v === Infinity ? null : v));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
};

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5_000_000) reject(new AppError('VALIDATION', 'request body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError('VALIDATION', 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

const parsePaging = (url: URL): { limit: number; offset: number } => {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));
  if (!Number.isInteger(limit) || !Number.isInteger(offset)) {
    throw new AppError('VALIDATION', 'limit/offset must be integers');
  }
  return { limit, offset };
};

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AppDeps,
  id?: number,
) => Promise<void>;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  { method: 'GET', pattern: /^\/health$/, handler: async (_req, res) => send(res, 200, { status: 'ok' }) },
  { method: 'GET', pattern: /^\/datasets$/, handler: listDatasetsRoute },
  { method: 'POST', pattern: /^\/datasets$/, handler: createDatasetRoute },
  { method: 'GET', pattern: /^\/datasets\/(\d+)$/, handler: getDatasetRoute },
  { method: 'GET', pattern: /^\/datasets\/(\d+)\/versions$/, handler: listVersionsRoute },
  { method: 'POST', pattern: /^\/datasets\/(\d+)\/versions$/, handler: addVersionRoute },
  { method: 'GET', pattern: /^\/versions\/(\d+)\/rows$/, handler: listRowsRoute },
  { method: 'POST', pattern: /^\/versions\/(\d+)\/analyses$/, handler: analysisRoute },
  { method: 'POST', pattern: /^\/versions\/(\d+)\/comparisons$/, handler: comparisonRoute },
  { method: 'GET', pattern: /^\/reports$/, handler: listReportsRoute },
  { method: 'GET', pattern: /^\/reports\/(\d+)$/, handler: getReportRoute },
];

async function listDatasetsRoute(_req: IncomingMessage, res: ServerResponse, url: URL, deps: AppDeps) {
  send(res, 200, listDatasets(deps.db, ...Object.values(parsePaging(url)) as [number, number]));
}

async function createDatasetRoute(req: IncomingMessage, res: ServerResponse, _url: URL, deps: AppDeps) {
  const body = (await readJson(req)) as Record<string, unknown>;
  const data = validateDatasetInput(body);
  if (findDatasetByName(deps.db, data.name)) {
    throw new AppError('CONFLICT', `dataset "${data.name}" already exists; POST a new version to revise it`);
  }
  const v = createDataset(deps.db, data, deps.clock);
  send(res, 201, { ...v, rows: data.rows.length });
}

async function getDatasetRoute(_req: IncomingMessage, res: ServerResponse, _url: URL, deps: AppDeps, id?: number) {
  const page = listVersions(deps.db, id!, 1, 0);
  if (page.total === 0) throw new AppError('NOT_FOUND', `dataset ${id} not found`);
  send(res, 200, { datasetId: id, latest: page.items[0] });
}

async function listVersionsRoute(_req: IncomingMessage, res: ServerResponse, url: URL, deps: AppDeps, id?: number) {
  if (listVersions(deps.db, id!, 1, 0).total === 0) throw new AppError('NOT_FOUND', `dataset ${id} not found`);
  send(res, 200, listVersions(deps.db, id!, ...Object.values(parsePaging(url)) as [number, number]));
}

async function addVersionRoute(req: IncomingMessage, res: ServerResponse, _url: URL, deps: AppDeps, id?: number) {
  const body = (await readJson(req)) as Record<string, unknown>;
  const data: ValidatedDataset = validateDatasetInput(body);
  const note = typeof body.changeNote === 'string' && body.changeNote.trim() ? body.changeNote.trim() : 'revised snapshot';
  const v = addVersion(deps.db, id!, data, deps.clock, note);
  send(res, 201, v);
}

async function listRowsRoute(_req: IncomingMessage, res: ServerResponse, url: URL, deps: AppDeps, id?: number) {
  const { limit, offset } = parsePaging(url);
  const { rows } = loadFrozen(deps.db, id!);
  send(res, 200, {
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  });
}

async function analysisRoute(req: IncomingMessage, res: ServerResponse, _url: URL, deps: AppDeps, id?: number) {
  const body = (await readJson(req)) as Record<string, unknown>;
  if (typeof body.group !== 'string' || !body.group.trim()) {
    throw new AppError('VALIDATION', 'group is required');
  }
  if (body.tau !== undefined && (typeof body.tau !== 'number' || !Number.isFinite(body.tau))) {
    throw new AppError('VALIDATION', 'tau must be a finite number');
  }
  const result = analyzeGroup(deps.db, id!, body.group, {
    ci: body.ci === 'linear' ? 'linear' : 'log-log',
    tau: body.tau as number | undefined,
    clock: deps.clock,
  });
  send(res, 201, result);
}

async function comparisonRoute(req: IncomingMessage, res: ServerResponse, _url: URL, deps: AppDeps, id?: number) {
  const body = (await readJson(req)) as Record<string, unknown>;
  if (typeof body.group1 !== 'string' || typeof body.group2 !== 'string') {
    throw new AppError('VALIDATION', 'group1 and group2 are required strings');
  }
  const result = compareGroups(deps.db, id!, body.group1, { group2: body.group2, clock: deps.clock });
  send(res, 201, result);
}

async function listReportsRoute(_req: IncomingMessage, res: ServerResponse, url: URL, deps: AppDeps) {
  send(res, 200, listReports(deps.db, ...Object.values(parsePaging(url)) as [number, number]));
}

async function getReportRoute(_req: IncomingMessage, res: ServerResponse, _url: URL, deps: AppDeps, id?: number) {
  const report = getReport(deps.db, id!);
  if (!report) throw new AppError('NOT_FOUND', `report ${id} not found`);
  send(res, 200, report);
}

export function createApp(deps: AppDeps): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const m = route.pattern.exec(url.pathname);
          if (!m) continue;
          const id = m[1] ? Number(m[1]) : undefined;
          await route.handler(req, res, url, deps, id);
          return;
        }
        send(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` } });
      } catch (err) {
        if (err instanceof AppError) {
          send(res, errorStatus(err.code), { error: { code: err.code, message: err.message, details: err.details ?? null } });
        } else {
          send(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } });
        }
      }
    })();
  });
}

export function startLocalServer(deps: AppDeps): Promise<{ server: Server; port: number }> {
  const server = createApp(deps);
  return new Promise((resolve) => {
    // Bind only to loopback; port 0 lets the OS assign a free port automatically.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}
