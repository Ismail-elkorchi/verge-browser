import { existsSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

function getEntrypointPath() {
  const entryPath = resolve(process.cwd(), "src/mod.ts");
  if (!existsSync(entryPath)) {
    throw new Error("Expected package entrypoint at src/mod.ts");
  }
  return entryPath;
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

function hasDocumentation(declaration, symbol, checker) {
  if (hasInternalTag(declaration)) {
    return true;
  }

  const docs = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  return docs.length > 0;
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
  const sourceFile = program.getSourceFile(entryPath);
  if (!sourceFile) {
    throw new Error(`Unable to load source file: ${entryPath}`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error("Unable to resolve module symbol for src/mod.ts");
  }

  const exportSymbols = checker.getExportsOfModule(moduleSymbol);
  const missing = [];

  for (const exportSymbol of exportSymbols) {
    const symbol = resolveAlias(exportSymbol, checker);
    const declarations = symbol.getDeclarations() ?? [];
    const localDeclarations = declarations.filter((declaration) => declaration.getSourceFile().fileName === entryPath);

    if (localDeclarations.length === 0) {
      continue;
    }

    const documented = localDeclarations.some((declaration) => hasDocumentation(declaration, symbol, checker));

    if (!documented) {
      const declaration = localDeclarations[0];
      const position = declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart());
      missing.push({
        symbol: exportSymbol.getName(),
        line: position.line + 1,
        column: position.character + 1
      });
    }
  }

  return missing;
}

function main() {
  const entryPath = getEntrypointPath();
  const missing = checkEntrypointDocs(entryPath);

  if (missing.length === 0) {
    process.stdout.write("doc-required: all entrypoint-owned exports have docblocks\n");
    return;
  }

  process.stderr.write("doc-required: missing JSDoc on exported entrypoint symbols\n");
  for (const issue of missing) {
    process.stderr.write(`- ${issue.symbol} at src/mod.ts:${issue.line}:${issue.column}\n`);
  }
  process.stderr.write("Add a JSDoc block or mark the export as @internal.\n");
  process.exitCode = 1;
}

main();
