export function normalizedText(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function compareOracleCase(fixture, variant, native, chromium) {
  const failures = [];
  const compare = (kind, target, expected, actual) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) failures.push({ kind, target, expected, actual });
  };
  const text = normalizedText(chromium.meaningfulVisibleText.join(" ")).toLocaleLowerCase("und");
  for (const phrase of native.paintExpectations) {
    const browserVisible = text.includes(normalizedText(phrase).toLocaleLowerCase("und"));
    const nativeVisible = native.paintedPhrases.includes(phrase);
    if (!browserVisible || !nativeVisible) failures.push({ kind: "visible-text", target: phrase, chromium: browserVisible, native: nativeVisible });
  }
  for (const phrase of fixture.oracle?.suppressedText ?? []) {
    if (text.includes(normalizedText(phrase).toLocaleLowerCase("und"))) failures.push({ kind: "zero-font-visible-in-chromium", target: phrase });
  }
  if (native.zeroFontPainted > 0) failures.push({ kind: "zero-font-visible-in-native", actual: native.zeroFontPainted });
  for (const assertion of fixture.oracle?.styles ?? []) {
    if (chromium.byId[assertion.id] == null || native.byId[assertion.id] == null) {
      failures.push({ kind: "missing-style-target", target: assertion.id, chromium: chromium.byId[assertion.id] != null, native: native.byId[assertion.id] != null });
      continue;
    }
    for (const property of assertion.properties) {
      compare("computed-style", `${assertion.id}.${property}`, chromium.byId[assertion.id]?.style[property] ?? null, native.byId[assertion.id]?.style[property] ?? null);
    }
  }
  if (fixture.oracle?.formSemantics === true) {
    compare("form-control-state", "document-order controls", chromium.formSemantics?.controls ?? null, native.formSemantics?.controls ?? null);
    compare("form-entry-list", "document-order forms and submitters", chromium.formSemantics?.forms ?? null, native.formSemantics?.forms ?? null);
  }
  if (fixture.oracle?.accessibleNames === true) {
    if (chromium.accessibleNames?.status !== "complete") {
      failures.push({ kind: "accessible-name-oracle-unavailable", reason: chromium.accessibleNames?.reason ?? "missing CDP observation" });
    } else {
      const targets = native.formSemantics?.nameTargets ?? [];
      compare("accessible-name-targets", "document-order positions", chromium.formSemantics?.nameTargets ?? [], targets.map((target) => target.key));
      for (const target of targets) compare("accessible-name", target.key, chromium.accessibleNames.byKey[target.key]?.name ?? null, target.name);
    }
  }
  // Only controlled boxes opt into numeric geometry comparisons. A reference
  // subtracts the same property within each engine, so owned edges and paired
  // intrinsic/ex expressions can be checked without equating font metrics.
  for (const assertion of fixture.oracle?.geometry ?? []) {
    for (const property of assertion.properties) {
      const measure = (inspection) => {
        const value = inspection.byId[assertion.id]?.rectangle?.[property];
        const reference = assertion.referenceId === undefined ? 0 : inspection.byId[assertion.referenceId]?.rectangle?.[property];
        return Number.isFinite(value) && Number.isFinite(reference) ? value - reference : null;
      };
      const actual = measure(native);
      const expected = measure(chromium);
      if (actual === null || expected === null || Math.abs(actual - expected) > (assertion.tolerance ?? 1)) {
        const target = `${assertion.id}.${property}${assertion.referenceId === undefined ? "" : ` - ${assertion.referenceId}.${property}`}`;
        failures.push({ kind: "controlled-geometry", target, expected, actual });
      }
    }
  }
  return { id: `${fixture.id}:${variant.id}`, comparedTextPhrases: native.paintExpectations.length, failures };
}
