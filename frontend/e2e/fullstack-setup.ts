import { execFileSync } from "node:child_process";
import path from "node:path";

const backend = path.resolve(__dirname, "../../backend");

export default function setup() {
  const output = execFileSync("/bin/zsh", ["-lc", "set -a; source .env; set +a; pnpm exec ts-node test/fullstack-fixture.ts seed"], { cwd: backend, encoding: "utf8" });
  const fixture = JSON.parse(output) as { sessionToken: string; organizationId: string };
  process.env.OPES_FULLSTACK_SESSION_TOKEN = fixture.sessionToken;
  process.env.OPES_FULLSTACK_ORGANIZATION_ID = fixture.organizationId;
}
