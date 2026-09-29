import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AppError, type ErrorCode } from "../errors.js";
import { generateParts, type GeneratorConfig } from "../synthetic.js";
import { AnalysisService } from "../service.js";
import type { TimeUnit } from "../types.js";

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  DUPLICATE_SUBJECT: 409,
  VERSION_CONFLICT: 409,
  NOT_FOUND: 404,
  MISSING_GROUP: 404,
  INCOMPARABLE_GROUPS: 422,
  EMPTY_DATA: 422,
  ZERO_VARIANCE: 422,
};

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: string[],
    query: URLSearchParams
  ) => Promise<void>;
}

export function buildApp(service: AnalysisService): Server {
  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/health$/,
      handler: async (_req, res) => json(res, 200, { status: "ok" }),
    },
    {
      method: "POST",
      pattern: /^\/api\/generate$/,
      handler: async (req, res) => {
        const body = await readJson(req);
        const subjects = generateParts(body as unknown as GeneratorConfig);
        json(res, 200, { subjects, count: subjects.length });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/datasets$/,
      handler: async (req, res) => {
        const body = await readJson(req);
        require(body, ["name", "timeUnit"]);
        const row = service.createDataset(
          String(body.name),
          body.timeUnit as TimeUnit,
          body.description ? String(body.description) : ""
        );
        json(res, 201, row);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/datasets$/,
      handler: async (_req, res, _p, query) => {
        const { limit, offset } = paging(query);
        json(res, 200, service.listDatasets(limit, offset));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/datasets\/(\d+)$/,
      handler: async (_req, res, params) => {
        json(res, 200, service.getDataset(Number(params[0])));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/datasets\/(\d+)\/versions$/,
      handler: async (req, res, params) => {
        const body = await readJson(req);
        require(body, ["subjects", "changeNote"]);
        const result = service.freezeVersion(
          Number(params[0]),
          body.subjects as never,
          String(body.changeNote),
          {
            expectedVersion:
              body.expectedVersion === undefined ? undefined : Number(body.expectedVersion),
            idempotencyKey:
              body.idempotencyKey === undefined ? undefined : String(body.idempotencyKey),
          }
        );
        json(res, result.created ? 201 : 200, result.version);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/datasets\/(\d+)\/versions$/,
      handler: async (_req, res, params) => {
        json(res, 200, { versions: service.listVersions(Number(params[0])) });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/datasets\/(\d+)\/curves$/,
      handler: async (req, res, params) => {
        const body = await readJson(req);
        require(body, ["group"]);
        const result = service.curve(Number(params[0]), {
          group: String(body.group),
          version: body.version === undefined ? undefined : Number(body.version),
          ciMethod: body.ciMethod as never,
          confidenceLevel:
            body.confidenceLevel === undefined ? undefined : Number(body.confidenceLevel),
          horizon: body.horizon === undefined ? undefined : Number(body.horizon),
        });
        json(res, 200, result);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/datasets\/(\d+)\/compare$/,
      handler: async (req, res, params) => {
        const body = await readJson(req);
        require(body, ["groupA", "groupB"]);
        const result = service.compare(
          Number(params[0]),
          String(body.groupA),
          String(body.groupB),
          body.version === undefined ? undefined : Number(body.version)
        );
        json(res, 200, result);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/datasets\/(\d+)\/censoring$/,
      handler: async (_req, res, params, query) => {
        const group = query.get("group") ?? undefined;
        const versionParam = query.get("version");
        const version = versionParam === null ? undefined : Number(versionParam);
        json(res, 200, service.censoring(Number(params[0]), group, version));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/subjects$/,
      handler: async (_req, res, params, query) => {
        const { limit, offset } = paging(query);
        json(res, 200, service.listSubjectsPage(Number(params[0]), limit, offset));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/reports$/,
      handler: async (_req, res, params, query) => {
        const { limit, offset } = paging(query);
        json(res, 200, service.listReports(Number(params[0]), limit, offset));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/reports\/(\d+)$/,
      handler: async (_req, res, params) => {
        const row = service.getReport(Number(params[0]));
        json(res, 200, {
          id: row.id,
          version_id: row.version_id,
          kind: row.kind,
          params: JSON.parse(row.params_json),
          result: JSON.parse(row.result_json),
        });
      },
    },
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = url.pathname.match(route.pattern);
        if (!match) continue;
        await route.handler(req, res, match.slice(1), url.searchParams);
        return;
      }
      json(res, 404, {
        error: {
          code: "NOT_FOUND",
          message: `no route for ${req.method} ${url.pathname}`,
        },
      });
    } catch (err) {
      sendError(res, err);
    }
  });
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startLocal(service: AnalysisService): Promise<StartedServer> {
  const server = buildApp(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

function paging(query: URLSearchParams): { limit: number; offset: number } {
  const limit = Number(query.get("limit") ?? "50");
  const offset = Number(query.get("offset") ?? "0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError("VALIDATION_ERROR", "limit must be an integer in [1, 500]");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError("VALIDATION_ERROR", "offset must be a non-negative integer");
  }
  return { limit, offset };
}

function require(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null) {
      throw new AppError("VALIDATION_ERROR", `missing required field '${field}'`);
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) {
      throw new AppError("BAD_REQUEST", "request body too large (max 2 MB)");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AppError("VALIDATION_ERROR", "request body must be a JSON object");
    }
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("BAD_REQUEST", "invalid JSON body");
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    json(res, HTTP_STATUS[err.code] ?? 500, {
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  json(res, 500, { error: { code: "BAD_REQUEST", message } });
}
