import type { FileAggregate, ParsedFile, TranscriptKind } from "../events.js";

/**
 * What a provider can report on.
 *
 * This is data the renderer reads, exactly as `TargetProfile` is for
 * `src/agent/render.ts`. `src/commands/usage.ts` must never branch on
 * `provider.name`: a report a provider cannot serve is decided here, so adding
 * a second LLM's logs is a new module plus a registry line and nothing else.
 */
export interface ProviderCapabilities {
  tokens: boolean;
  /** Cache read and cache write counters, separately from plain input tokens. */
  cacheTokens: boolean;
  tools: boolean;
  skills: boolean;
  subagents: boolean;
  hooks: boolean;
  mcp: boolean;
  slashCommands: boolean;
  /** Whether records carry the working directory a session ran in. */
  projects: boolean;
}

/** A transcript found on disk, described without opening it. */
export interface TranscriptFile {
  /** Absolute path. */
  file: string;
  /** Path relative to the provider root; the index shard keys on this. */
  relative: string;
  /** Shard the aggregate belongs to; a filesystem-safe slug. */
  shard: string;
  kind: TranscriptKind;
  size: number;
  mtimeMs: number;
}

export interface DiscoverOptions {
  /** Include subagent transcripts. */
  subagents: boolean;
  /**
   * Drop files last modified before this instant.
   *
   * A transcript is append-only, so an mtime older than the window start cannot
   * contain a record inside it. This is the difference between opening a handful
   * of files and opening every one of them.
   */
  modifiedSince?: number;
}

export interface ProviderEnvironment {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Explicit `--logs <dir>` override, which wins over every discovery rule. */
  override?: string;
}

export interface UsageProvider {
  readonly name: string;
  readonly title: string;
  /** One line describing where this provider's logs come from. */
  readonly source: string;
  readonly capabilities: ProviderCapabilities;
  /** The log root, or null when this provider has left nothing on this machine. */
  root(context: ProviderEnvironment): string | null;
  /** Enumerate candidate transcripts under a root, without parsing them. */
  discover(root: string, options: DiscoverOptions): TranscriptFile[];
  /** Reduce one transcript to its aggregate. Never throws on malformed content. */
  read(file: TranscriptFile): Promise<FileAggregate>;
  /**
   * The same single pass as {@link read}, also returning the per-occurrence
   * event decomposition the usage store keeps.
   *
   * `read` is the aggregate half of this and stays on the interface because
   * every rollup wants only that; a caller that needs neither the events nor a
   * second pass should keep calling it.
   */
  parse(file: TranscriptFile): Promise<ParsedFile>;
}
