#!/usr/bin/env node

// node:sqlite prints an ExperimentalWarning on load. It's stable enough for us
// and the noise would end up in every command's output, so drop just that one.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  if (message.includes("SQLite is an experimental feature")) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// Imported after the filter is in place, since loading it triggers the warning.
const { main } = await import("./cli.ts");

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`mixtape: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
