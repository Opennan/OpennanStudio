import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { en } from "./en";

const SRC = resolve(__dirname, "..");
const SKIP = /(\.test\.tsx?$|\/test-utils\/|\/compat\/|\/i18n\/)/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !SKIP.test(full) ? [full] : [];
  });
}

it("every literal message key used in components exists in the English defaults", () => {
  const table = en as unknown as Record<string, Record<string, string>>;
  const missing: string[] = [];
  for (const file of sources(SRC)) {
    const code = readFileSync(file, "utf8");
    for (const [, name, namespace] of code.matchAll(/const\s+(\w+)\s*=\s*useTimelineMessages\(\s*"(\w+)"\s*\)/g)) {
      for (const [, key] of code.matchAll(new RegExp(`\\b${name}\\(\\s*"([A-Za-z0-9_]+)"`, "g"))) {
        if (!(key in (table[namespace] ?? {}))) missing.push(`${file.slice(SRC.length + 1)}: ${namespace}.${key}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
