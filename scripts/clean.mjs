// Removes only project-local runtime artifacts: data/, tmp/ and dist/.
import { rmSync, existsSync } from "node:fs";

for (const dir of ["data", "tmp", "dist"]) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    console.log(`removed ${dir}/`);
  }
}
