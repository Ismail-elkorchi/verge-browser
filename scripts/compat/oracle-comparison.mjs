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
  // Only controlled boxes opt into numeric geometry comparisons. Terminal
  // cells and Chromium fonts intentionally have different text metrics.
  for (const assertion of fixture.oracle?.geometry ?? []) {
    for (const property of assertion.properties) {
      const actual = native.byId[assertion.id]?.rectangle?.[property];
      const expected = chromium.byId[assertion.id]?.rectangle?.[property];
      if (actual === undefined || expected === undefined || Math.abs(actual - expected) > (assertion.tolerance ?? 1)) {
        failures.push({ kind: "controlled-geometry", target: `${assertion.id}.${property}`, expected: expected ?? null, actual: actual ?? null });
      }
    }
  }
  return { id: `${fixture.id}:${variant.id}`, comparedTextPhrases: native.paintExpectations.length, failures };
}
