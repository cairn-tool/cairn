import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { packageName, packageVersion } from "../version.js";
import { toolFailure } from "./errors.js";
import { SERVE_TOOLS, TOOL_BY_NAME, type ServeContext, type ServeTool } from "./tools.js";

/** The advertised `tools/list` payload — the tool table minus its handlers. */
export function toolManifest(): Tool[] {
  return SERVE_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * One compiled validator per tool, built once at startup.
 *
 * Compiling per call would put schema compilation on the request path for every
 * invocation, and a malformed schema should fail the server's own startup
 * rather than surface as a runtime error to a client.
 */
export function compileValidators(): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;
  addFormats(ajv);
  return new Map(SERVE_TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
}

function describeErrors(validate: ValidateFunction): string {
  const errors = validate.errors ?? [];
  return errors
    .map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

/**
 * Runs one tool call.
 *
 * The split matters: an unknown tool or arguments that fail their schema are the
 * client's protocol mistakes and are raised as JSON-RPC errors, while anything
 * the workspace itself reports comes back as an `isError` result the model can
 * read and correct.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  context: ServeContext,
  validators: Map<string, ValidateFunction>,
): Promise<CallToolResult> {
  const tool: ServeTool | undefined = TOOL_BY_NAME.get(name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

  const validate = validators.get(name);
  if (validate && !validate(args)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for ${name}: ${describeErrors(validate)}`,
    );
  }

  try {
    const payload = await tool.handler(args, context);
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    if (error instanceof McpError) throw error;
    return toolFailure(error, context.root);
  }
}

export interface RunningServer {
  server: Server;
  /** Resolves once no tool call is still in flight. */
  idle: () => Promise<void>;
}

export function createServer(
  context: ServeContext,
  validators: Map<string, ValidateFunction> = compileValidators(),
): RunningServer {
  const server = new Server(
    { name: packageName, version: packageVersion },
    // Declared up front: the SDK asserts the capability when a handler is
    // registered, so omitting it fails at startup rather than at request time.
    { capabilities: { tools: {} } },
  );

  // Tool calls are tracked so shutdown can drain them. The SDK dispatches
  // requests concurrently, and a client that has sent its last frame and closed
  // stdin would otherwise lose the responses still being computed.
  const pending = new Set<Promise<unknown>>();
  const idle = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolManifest() }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const call = callTool(request.params.name, request.params.arguments ?? {}, context, validators);
    pending.add(call);
    return call.finally(() => pending.delete(call));
  });

  return { server, idle };
}

/** Serves until the client closes the transport. */
export async function serveStdio(context: ServeContext): Promise<void> {
  const { server, idle } = createServer(context);
  const transport = new StdioServerTransport();

  // stdout is the protocol channel, so every diagnostic goes to stderr, which
  // MCP treats as the server's log. A single malformed frame or a failure while
  // writing a response must not take down a session that is otherwise healthy,
  // so these are reported rather than thrown.
  const report = (label: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cairn serve: ${label}: ${message}\n`);
  };
  server.onerror = (error) => report("protocol error", error);
  const onRejection = (reason: unknown): void => report("unhandled rejection", reason);
  process.on("unhandledRejection", onRejection);

  try {
    await server.connect(transport);
    // A client disconnecting shows up as EOF on stdin, which does not
    // necessarily reach `onclose`; waiting on `onclose` alone leaves the process
    // hanging on an unsettled promise until Node notices and warns.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transport.onclose = finish;
      process.stdin.once("end", finish);
      process.stdin.once("close", finish);
    });
    // Requests already dispatched still need their responses written.
    await idle();
    await server.close();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}
