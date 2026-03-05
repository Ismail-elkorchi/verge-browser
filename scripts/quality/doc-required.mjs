import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import ts from "typescript";

const ENTRYPOINT_CANDIDATES = ["src/mod.ts", "src/public/mod.ts"];

function resolveEntrypointPath() {
  for (const candidate of ENTRYPOINT_CANDIDATES) {
    const absolutePath = resolve(process.cwd(), candidate);
    if (existsSync(absolutePath)) {
      return absolutePath;
    }
  }

  throw new Error(`Expected package entrypoint at one of: ${ENTRYPOINT_CANDIDATES.join(", ")}`);
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function isProjectSourceFile(filePath) {
  const normalized = normalizePath(filePath);
  return normalized.includes("/src/") && normalized.endsWith(".ts") && !normalized.endsWith(".d.ts");
}

function isTypeOnlyExportSymbol(entrypointSourceFile, exportName) {
  for (const statement of entrypointSourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      if (element.name.text !== exportName) {
        continue;
      }

      if (statement.isTypeOnly || element.isTypeOnly) {
        return true;
      }
    }
  }

  return false;
}

function resolveAlias(symbol, checker) {
  if (symbol.flags & ts.SymbolFlags.Alias) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function hasInternalTag(declaration) {
  return ts.getJSDocTags(declaration).some((tag) => tag.tagName.escapedText === "internal");
}

function isSupportedDeclarationKind(declaration) {
  return ts.isFunctionDeclaration(declaration)
    || ts.isClassDeclaration(declaration)
    || ts.isInterfaceDeclaration(declaration)
    || ts.isTypeAliasDeclaration(declaration);
}

function isMeaningfulDoc(docText) {
  const normalized = docText.replace(/\s+/g, " ").trim();
  if (normalized.length < 16) {
    return false;
  }

  if (/^(tbd|todo|description|no description)$/i.test(normalized)) {
    return false;
  }

  return normalized.split(" ").length >= 3;
}

function readSourceFileText(sourceFilePath) {
  return readFileSync(sourceFilePath, "utf8");
}

function extractNearbyDocText(sourceText, declarationStart) {
  const lookback = sourceText.slice(Math.max(0, declarationStart - 1200), declarationStart);
  const match = lookback.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (!match || typeof match[1] !== "string") {
    return "";
  }

  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function getDocumentationText(symbol, checker, declaration) {
  const symbolDoc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (symbolDoc.length > 0) {
    return symbolDoc;
  }

  const sourceFilePath = declaration.getSourceFile().fileName;
  const sourceText = readSourceFileText(sourceFilePath);
  return extractNearbyDocText(sourceText, declaration.getStart());
}

function checkEntrypointDocs(entryPath) {
  const program = ts.createProgram([entryPath], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: false,
    skipLibCheck: true
  });

  const checker = program.getTypeChecker();
  const entrypointSourceFile = program.getSourceFile(entryPath);
  if (!entrypointSourceFile) {
    throw new Error(`Unable to load source file: ${entryPath}`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(entrypointSourceFile);
  if (!moduleSymbol) {
    throw new Error(`Unable to resolve module symbol for ${relative(process.cwd(), entryPath)}`);
  }

  const exportSymbols = checker.getExportsOfModule(moduleSymbol);
  const missing = [];

  for (const exportSymbol of exportSymbols) {
    const exportName = exportSymbol.getName();
    if (isTypeOnlyExportSymbol(entrypointSourceFile, exportName)) {
      continue;
    }

    const resolvedSymbol = resolveAlias(exportSymbol, checker);
    const declarations = resolvedSymbol.getDeclarations() ?? [];

    const candidateDeclarations = declarations.filter((declaration) => {
      const filePath = declaration.getSourceFile().fileName;
      if (!isProjectSourceFile(filePath)) {
        return false;
      }
      const normalizedPath = normalizePath(filePath);
      if (normalizedPath.endsWith("/types.ts")) {
        return false;
      }
      return isSupportedDeclarationKind(declaration);
    });

    if (candidateDeclarations.length === 0) {
      continue;
    }

    let documented = false;
    for (const declaration of candidateDeclarations) {
      if (hasInternalTag(declaration)) {
        documented = true;
        break;
      }

      const declarationSymbol = checker.getSymbolAtLocation(declaration.name ?? declaration) ?? resolvedSymbol;
      const docText = getDocumentationText(declarationSymbol, checker, declaration);
      if (isMeaningfulDoc(docText)) {
        documented = true;
        break;
      }
    }

    if (!documented) {
      const declaration = candidateDeclarations[0];
      const sourceFile = declaration.getSourceFile();
      const position = sourceFile.getLineAndCharacterOfPosition(declaration.getStart());
      missing.push({
        symbol: exportName,
        file: relative(process.cwd(), sourceFile.fileName),
        line: position.line + 1,
        column: position.character + 1
      });
    }
  }

  return missing;
}

function main() {
  const entryPath = resolveEntrypointPath();
  const missing = checkEntrypointDocs(entryPath);

  if (missing.length === 0) {
    process.stdout.write("doc-required: exported public API symbols have meaningful docblocks\n");
    return;
  }

  process.stderr.write("doc-required: missing meaningful JSDoc on exported public API symbols\n");
  for (const issue of missing) {
    process.stderr.write(`- ${issue.symbol} at ${issue.file}:${issue.line}:${issue.column}\n`);
  }
  process.stderr.write("Add a meaningful JSDoc block or mark the symbol declaration as @internal.\n");
  process.exitCode = 1;
}

main();
