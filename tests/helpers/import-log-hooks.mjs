// Records every specifier the CLI resolves, so a test can assert which modules
// an invocation actually loads. Registered by import-log-register.mjs, which is
// what `node --import` is pointed at; hooks run on their own thread, so the log
// is handed back through a file rather than a return value.
import fs from "node:fs";

let logPath;

export function initialize(data) {
  logPath = data.log;
}

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  fs.appendFileSync(logPath, `${resolved.url}\n`);
  return resolved;
}
