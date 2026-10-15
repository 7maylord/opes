import { execFileSync } from "node:child_process";
import path from "node:path";

export default function teardown() {
  execFileSync("/bin/sh", ["-c", "set -a; [ ! -f .env ] || . ./.env; set +a; DATABASE_URL=${OPES_TEST_DATABASE_URL:-$DATABASE_URL} pnpm exec ts-node test/fullstack-fixture.ts cleanup"], {
    cwd: path.resolve(__dirname, "../../backend"),
    stdio: "inherit",
  });
}
