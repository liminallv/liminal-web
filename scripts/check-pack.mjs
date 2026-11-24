import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const forbidden = /(^|\/)(test|tests|__tests__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?(\.map)?$|\.d\.(test|spec)\./;
const root = join(import.meta.dirname, "..", "packages");
let leaked = 0;

for (const name of readdirSync(root)) {
  const dir = join(root, name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (pkg.private) continue;
  const out = execSync("npm pack --dry-run --json", { cwd: dir, encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const path of files.filter((p) => forbidden.test(p))) {
    console.error(`${pkg.name}: ${path}`);
    leaked++;
  }
  console.log(`${pkg.name}: ${files.length} files`);
}

if (leaked) {
  console.error(`${leaked} test file(s) would be published`);
  process.exit(1);
}
