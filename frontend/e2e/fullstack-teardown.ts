import { execFileSync } from "node:child_process";
import path from "node:path";

export default function teardown() {
  execFileSync("/bin/zsh", ["-lc", "set -a; source .env; set +a; pnpm exec ts-node test/fullstack-fixture.ts cleanup"], {
    cwd: path.resolve(__dirname, "../../backend"),
    stdio: "inherit",
  });
}
