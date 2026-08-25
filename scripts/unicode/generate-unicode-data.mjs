import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const UNICODE_VERSION = "17.0.0";
const ROOT = resolve(import.meta.dirname, "../..");
const GENERATED_PATH = resolve(ROOT, "src/presentation/text/generated/unicode-17.ts");
const FIXTURE_DIRECTORY = resolve(ROOT, "test/fixtures/unicode/17.0.0");

const SOURCES = Object.freeze({
  "DerivedBidiClass.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/extracted/DerivedBidiClass.txt`,
    sha256: "4867b4b7f0731ed1bfcd34cc6251211ff1542541fce0734b6fbda139ee80b3a4"
  },
  "DerivedGeneralCategory.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/extracted/DerivedGeneralCategory.txt`,
    sha256: "d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e"
  },
  "BidiMirroring.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/BidiMirroring.txt`,
    sha256: "a2f16fb873ab4fcdf3221cb1a8a85a134ddd6ed03603181823ff5206af3741ce"
  },
  "BidiBrackets.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/BidiBrackets.txt`,
    sha256: "dadbaf38a0d0246e5b805bf8725cb81b7c621f93d030595635f5ba2c2f179428"
  },
  "UnicodeData.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/UnicodeData.txt`,
    sha256: "2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c"
  },
  "LineBreak.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/LineBreak.txt`,
    sha256: "e6a18fa91f8f6a6f8e534b1d3f128c21ada45bfe152eb6b1bcc5e15fd8ac92e6"
  },
  "EastAsianWidth.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/EastAsianWidth.txt`,
    sha256: "ea7ce50f3444a050333448dffef1cadd9325af55cbb764b4a2280faf52170a33"
  },
  "GraphemeBreakProperty.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/auxiliary/GraphemeBreakProperty.txt`,
    sha256: "d6b51d1d2ae5c33b451b7ed994b48f1f4dc62b2272a5831e7fd418514a6bae89"
  },
  "DerivedCoreProperties.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/DerivedCoreProperties.txt`,
    sha256: "24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08"
  },
  "emoji-data.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/emoji/emoji-data.txt`,
    sha256: "2cb2bb9455cda83e8481541ecf5b6dfda66a3bb89efa3fa7c5297eccf607b72b"
  },
  "BidiTest.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/BidiTest.txt`,
    sha256: "888bdfc8090652272d1f859cdb00ae659e2dc6c26740be61ef1d03998a687620"
  },
  "BidiCharacterTest.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/BidiCharacterTest.txt`,
    sha256: "a3e6e905ab5afbe318a96df5401d0372a04cd73ef139ab5e3cf0ae241c255488"
  },
  "LineBreakTest.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/auxiliary/LineBreakTest.txt`,
    sha256: "e69884e0dde6a8724873f885d68c52dc14518abf9ae4ca9e2283b8773db3b752"
  },
  "GraphemeBreakTest.txt": {
    url: `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/auxiliary/GraphemeBreakTest.txt`,
    sha256: "e2d134d2c52919bace503ebb6a551c1855fe1a1faec18478c78fff254a1793ec"
  },
  "UNICODE-LICENSE.txt": {
    url: "https://www.unicode.org/license.txt",
    sha256: "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96"
  }
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sourceText(name, sourceDirectory) {
  const source = SOURCES[name];
  if (source === undefined) throw new Error(`Unknown Unicode source ${name}`);
  const bytes = sourceDirectory === null
    ? Buffer.from(await (await globalThis.fetch(source.url)).arrayBuffer())
    : await readFile(resolve(sourceDirectory, name));
  const actual = digest(bytes);
  if (actual !== source.sha256) {
    throw new Error(`${name} SHA-256 mismatch: expected ${source.sha256}, received ${actual}`);
  }
  return bytes.toString("utf8");
}

function codePointRange(field) {
  const [startText, endText = startText] = field.trim().split("..");
  const start = Number.parseInt(startText, 16);
  const end = Number.parseInt(endText, 16);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    throw new Error(`Invalid code-point range ${field}`);
  }
  return [start, end];
}

function propertyEntries(text, selected = null) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (line.length === 0) continue;
    const [range, property] = line.split(";").map((part) => part.trim());
    if (range === undefined || property === undefined || (selected !== null && property !== selected)) continue;
    const [start, end] = codePointRange(range);
    entries.push({ start, end, property });
  }
  return entries;
}

function missingPropertyEntries(text) {
  const entries = [];
  const aliases = new Map([
    ["Left_To_Right", "L"],
    ["Right_To_Left", "R"],
    ["Arabic_Letter", "AL"],
    ["European_Terminator", "ET"]
  ]);
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = /^#\s*@missing:\s*([^;]+);\s*([^#]+?)(?:\s*#.*)?$/u.exec(rawLine);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const [start, end] = codePointRange(match[1]);
    const property = match[2].trim();
    entries.push({ start, end, property: aliases.get(property) ?? property });
  }
  return entries;
}

function flatPropertyTable(entries, properties) {
  const propertyIndex = new Map(properties.map((property, index) => [property, index]));
  return entries.flatMap(({ start, end, property }) => {
    const index = propertyIndex.get(property);
    if (index === undefined) throw new Error(`Unregistered Unicode property value ${property}`);
    return [start, end, index];
  });
}

function propertyTable(text) {
  const entries = propertyEntries(text).sort((left, right) => left.start - right.start || left.end - right.end);
  const properties = [...new Set(entries.map(({ property }) => property))].sort();
  return { properties, ranges: flatPropertyTable(entries, properties) };
}

function missingPropertyTable(text) {
  const entries = missingPropertyEntries(text);
  const properties = [...new Set(entries.map(({ property }) => property))].sort();
  return { properties, ranges: flatPropertyTable(entries, properties) };
}

function mappingTable(text, fields) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (line.length === 0) continue;
    const parts = line.split(";").map((part) => part.trim());
    if (parts.length < fields) continue;
    entries.push(parts.slice(0, fields));
  }
  return entries;
}

function indicConjunctBreakTable(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (line.length === 0) continue;
    const [range, property, value] = line.split(";").map((part) => part.trim());
    if (range === undefined || property !== "InCB" || value === undefined) continue;
    const [start, end] = codePointRange(range);
    entries.push({ start, end, property: value });
  }
  entries.sort((left, right) => left.start - right.start || left.end - right.end);
  const properties = [...new Set(entries.map(({ property }) => property))].sort();
  return { properties, ranges: flatPropertyTable(entries, properties) };
}

function numericLiteral(values) {
  const rows = [];
  for (let index = 0; index < values.length; index += 24) rows.push(`  ${values.slice(index, index + 24).join(", ")}`);
  return rows.join(",\n");
}

function stringLiteral(values) {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

async function main() {
  const check = process.argv.includes("--check");
  const argument = process.argv.find((value) => value.startsWith("--source-directory="));
  const sourceDirectory = argument === undefined
    ? check ? FIXTURE_DIRECTORY : null
    : resolve(argument.slice("--source-directory=".length));
  const loaded = new Map();
  for (const name of Object.keys(SOURCES)) loaded.set(name, await sourceText(name, sourceDirectory));

  const bidi = propertyTable(loaded.get("DerivedBidiClass.txt"));
  const bidiDefaults = missingPropertyTable(loaded.get("DerivedBidiClass.txt"));
  const generalCategory = propertyTable(loaded.get("DerivedGeneralCategory.txt"));
  const grapheme = propertyTable(loaded.get("GraphemeBreakProperty.txt"));
  const indicConjunctBreak = indicConjunctBreakTable(loaded.get("DerivedCoreProperties.txt"));
  const lineBreak = propertyTable(loaded.get("LineBreak.txt"));
  const eastAsianWidth = propertyTable(loaded.get("EastAsianWidth.txt"));
  const extendedPictographic = propertyEntries(loaded.get("emoji-data.txt"), "Extended_Pictographic")
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .flatMap(({ start, end }) => [start, end]);
  const mirrored = [];
  const canonicalDecomposition = new Map();
  for (const line of loaded.get("UnicodeData.txt").split(/\r?\n/u)) {
    const fields = line.split(";");
    if (fields[0] !== undefined && fields[9] === "Y") {
      const point = Number.parseInt(fields[0], 16);
      mirrored.push(point, point);
    }
    const decomposition = fields[5];
    if (fields[0] !== undefined && decomposition !== undefined && /^[0-9A-F]+$/u.test(decomposition)) {
      canonicalDecomposition.set(Number.parseInt(fields[0], 16), Number.parseInt(decomposition, 16));
    }
  }
  const mirroring = mappingTable(loaded.get("BidiMirroring.txt"), 2)
    .flatMap(([point, mapped]) => [Number.parseInt(point, 16), Number.parseInt(mapped, 16)]);
  const brackets = mappingTable(loaded.get("BidiBrackets.txt"), 3)
    .flatMap(([point, paired, kind]) => [Number.parseInt(point, 16), Number.parseInt(paired, 16), kind === "o" ? 1 : 2]);
  const canonicalBrackets = [];
  for (let index = 0; index < brackets.length; index += 3) {
    const point = brackets[index];
    const canonical = point === undefined ? undefined : canonicalDecomposition.get(point);
    if (point !== undefined && canonical !== undefined) canonicalBrackets.push(point, canonical);
  }

  const generated = `/* Generated by scripts/unicode/generate-unicode-data.mjs. Do not edit. */\n`
    + `export const UNICODE_VERSION = ${JSON.stringify(UNICODE_VERSION)} as const;\n`
    + `export const BIDI_CLASS_VALUES = [${stringLiteral(bidi.properties)}] as const;\n`
    + `export const BIDI_CLASS_RANGES: readonly number[] = [\n${numericLiteral(bidi.ranges)}\n];\n`
    + `export const BIDI_DEFAULT_VALUES = [${stringLiteral(bidiDefaults.properties)}] as const;\n`
    + `export const BIDI_DEFAULT_RANGES: readonly number[] = [\n${numericLiteral(bidiDefaults.ranges)}\n];\n`
    + `export const GENERAL_CATEGORY_VALUES = [${stringLiteral(generalCategory.properties)}] as const;\n`
    + `export const GENERAL_CATEGORY_RANGES: readonly number[] = [\n${numericLiteral(generalCategory.ranges)}\n];\n`
    + `export const GRAPHEME_BREAK_VALUES = [${stringLiteral(grapheme.properties)}] as const;\n`
    + `export const GRAPHEME_BREAK_RANGES: readonly number[] = [\n${numericLiteral(grapheme.ranges)}\n];\n`
    + `export const INDIC_CONJUNCT_BREAK_VALUES = [${stringLiteral(indicConjunctBreak.properties)}] as const;\n`
    + `export const INDIC_CONJUNCT_BREAK_RANGES: readonly number[] = [\n${numericLiteral(indicConjunctBreak.ranges)}\n];\n`
    + `export const LINE_BREAK_VALUES = [${stringLiteral(lineBreak.properties)}] as const;\n`
    + `export const LINE_BREAK_RANGES: readonly number[] = [\n${numericLiteral(lineBreak.ranges)}\n];\n`
    + `export const EAST_ASIAN_WIDTH_VALUES = [${stringLiteral(eastAsianWidth.properties)}] as const;\n`
    + `export const EAST_ASIAN_WIDTH_RANGES: readonly number[] = [\n${numericLiteral(eastAsianWidth.ranges)}\n];\n`
    + `export const EXTENDED_PICTOGRAPHIC_RANGES: readonly number[] = [\n${numericLiteral(extendedPictographic)}\n];\n`
    + `export const BIDI_MIRRORED_RANGES: readonly number[] = [\n${numericLiteral(mirrored)}\n];\n`
    + `export const BIDI_MIRRORING_MAP: readonly number[] = [\n${numericLiteral(mirroring)}\n];\n`
    + `export const BIDI_BRACKET_MAP: readonly number[] = [\n${numericLiteral(brackets)}\n];\n`
    + `export const BIDI_BRACKET_CANONICAL_MAP: readonly number[] = [\n${numericLiteral(canonicalBrackets)}\n];\n`;

  const metadata = `${JSON.stringify({
    unicodeVersion: UNICODE_VERSION,
    sources: SOURCES
  }, null, 2)}\n`;
  if (check) {
    if (await readFile(GENERATED_PATH, "utf8") !== generated) {
      throw new Error("Generated Unicode tables are not deterministic; run npm run unicode:generate.");
    }
    if (await readFile(resolve(FIXTURE_DIRECTORY, "sources.json"), "utf8") !== metadata) {
      throw new Error("Unicode source metadata is stale; run npm run unicode:generate.");
    }
    return;
  }
  await mkdir(resolve(GENERATED_PATH, ".."), { recursive: true });
  await mkdir(FIXTURE_DIRECTORY, { recursive: true });
  await writeFile(GENERATED_PATH, generated);
  for (const [name, value] of loaded) await writeFile(resolve(FIXTURE_DIRECTORY, basename(name)), value);
  await writeFile(resolve(FIXTURE_DIRECTORY, "sources.json"), metadata);
}

await main();
