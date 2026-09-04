import { register } from "node:module";
import process from "node:process";

register("./import-log-hooks.mjs", import.meta.url, { data: { log: process.env.IMPORT_LOG } });
