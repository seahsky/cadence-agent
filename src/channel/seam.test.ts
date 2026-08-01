import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The test the ticket actually set: this compiles and is exercised with no platform library
 * anywhere in either directory.
 *
 * It is a source scan rather than a type check because the failure it guards is a *dependency*,
 * and a dependency added to `src/channel/inbound.ts` type-checks perfectly well. The seam is what
 * makes "adding Slack touches only `src/channel/slack/`" true, and nothing else in the codebase
 * would notice it stopping being true.
 */

const SRC = join(import.meta.dirname, "..");

const PLATFORM_LIBRARIES = [/^discord\.js/, /^@discordjs\//, /^@slack\//, /^telegraf/];

const importSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );

const tsFilesIn = (dir: string, recursive: boolean): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return recursive ? tsFilesIn(path, true) : [];
    }

    return entry.name.endsWith(".ts") ? [path] : [];
  });

const seamFiles = tsFilesIn(join(SRC, "channel"), false);
const domainFiles = tsFilesIn(join(SRC, "domain"), true);

const importsOf = (files: readonly string[]): ReadonlyArray<readonly [string, string]> =>
  files.flatMap((file) =>
    importSpecifiers(readFileSync(file, "utf8")).map(
      (specifier) => [file.slice(SRC.length + 1), specifier] as const,
    ),
  );

describe("the channel seam", () => {
  it("has files to scan, so a silent empty pass cannot report success", () => {
    expect(seamFiles.length).toBeGreaterThan(0);
    expect(domainFiles.length).toBeGreaterThan(0);
  });

  it("imports no platform library", () => {
    const offenders = [...importsOf(seamFiles), ...importsOf(domainFiles)].filter(([, specifier]) =>
      PLATFORM_LIBRARIES.some((library) => library.test(specifier)),
    );

    expect(offenders).toEqual([]);
  });

  it("reaches out of its own directory only for the domain", () => {
    const offenders = importsOf(seamFiles).filter(
      ([, specifier]) => specifier.startsWith("../") && !specifier.startsWith("../domain"),
    );

    expect(offenders).toEqual([]);
  });
});

describe("the domain", () => {
  it("imports nothing from another src directory, so every seam can depend on it", () => {
    const offenders = importsOf(domainFiles).filter(([, specifier]) => specifier.startsWith("../"));

    expect(offenders).toEqual([]);
  });
});
