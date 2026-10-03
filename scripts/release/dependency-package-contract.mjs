const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const TERMINAL_UI = "@ismail-elkorchi/terminal-ui";
const SOURCE = /^(?:github:Ismail-elkorchi\/terminal-ui|git\+https:\/\/github\.com\/Ismail-elkorchi\/terminal-ui\.git|git\+ssh:\/\/git@github\.com\/Ismail-elkorchi\/terminal-ui\.git)#([a-f0-9]{40})$/u;

/** Bind each declared dependency to its lock and npm's actual installation record. */
export function validateDependencyInstall({ name, dependencySpec, lockEntry, installedManifest, installedLockEntry }) {
  const revision = name === TERMINAL_UI && typeof dependencySpec === "string"
    ? SOURCE.exec(dependencySpec)?.[1] : undefined;
  if (revision === undefined && (typeof dependencySpec !== "string" || !EXACT_VERSION.test(dependencySpec))) {
    throw new Error(`${name} requires an exact registry version or, for terminal-ui, an exact 40-hex upstream Git revision`);
  }
  const resolvedRevision = typeof lockEntry?.resolved === "string" ? SOURCE.exec(lockEntry.resolved)?.[1] : undefined;
  const expectedTarball = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${dependencySpec}.tgz`;
  if (
    typeof lockEntry?.version !== "string"
    || (revision === undefined
      ? lockEntry.version !== dependencySpec || lockEntry.resolved !== expectedTarball
      : resolvedRevision !== revision)
    || typeof lockEntry.integrity !== "string" || !SHA512.test(lockEntry.integrity)
    || lockEntry.dev === true || lockEntry.link === true
  ) {
    throw new Error(`${name} lock must match its exact source and include SHA-512 integrity`);
  }
  if (
    installedManifest?.name !== name || installedManifest.version !== lockEntry.version
    || installedLockEntry?.version !== lockEntry.version
    || installedLockEntry.resolved !== lockEntry.resolved
    || installedLockEntry.integrity !== lockEntry.integrity
    || installedLockEntry.link === true
  ) {
    throw new Error(`installed ${name} does not match its locked source`);
  }
  return Object.freeze({ name, version: installedManifest.version, resolved: lockEntry.resolved,
    integrity: lockEntry.integrity, ...(revision === undefined ? {} : { revision }) });
}
