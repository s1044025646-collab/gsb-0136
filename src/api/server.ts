import { resolve } from "node:path";
import { openDatabase, defaultClock } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { AnalysisService } from "../service.js";
import { startLocal } from "./http.js";

const dbPath = process.env.LIFETRIAL_DB
  ? resolve(process.env.LIFETRIAL_DB)
  : resolve("data/lifetrial.db");

const db = openDatabase(dbPath);
const service = new AnalysisService(new Repository(db, defaultClock), defaultClock);

const started = await startLocal(service);
console.log(`lifetrial API listening on http://127.0.0.1:${started.port}`);
console.log(`database: ${dbPath}`);

const shutdown = async () => {
  await started.close();
  db.close();
  console.log("lifetrial API stopped");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
