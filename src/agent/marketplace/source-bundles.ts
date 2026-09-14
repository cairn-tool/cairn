import fs from "node:fs";
import path from "node:path";
import type { AgentBundle, AgentDiagnostic, Artifact } from "../types.js";
import { diagnostic } from "../types.js";
import { allFiles } from "../parser.js";
import type { SpecBundle } from "./spec.js";

/** Where published source bundles live, relative to the collection root. */
export const SOURCE_BUNDLES_DIRECTORY = "bundles";

/** The placeholder a release pipeline is expected to replace. */
export const VERSION_SENTINEL = "0.0.0-development";

/** A published source bundle: where it landed, and at what version. */
export interface PublishedBundle {
  name: string;
  /** Collection-relative POSIX path of the bundle root. */
  source: string;
  version: string;
}

export interface SourceBundleBuild {
  artifacts: Artifact[];
  published: PublishedBundle[];
  diagnostics: AgentDiagnostic[];
}

function error(
  code: string,
  message: string,
  extra: Partial<AgentDiagnostic> = {},
): AgentDiagnostic {
  // `diagnostic()` derives severity from quality and never returns "error", so
  // an error is built by spreading and overriding — the idiom manifest.ts,
  // package/index.ts and spec.ts all use.
  return { ...diagnostic(code, message, "unsupported", extra), severity: "error" };
}

const posix = (value: string): string => value.split(path.sep).join("/");

/**
 * Rewrites the `version:` line of an `agent-bundle.yaml` buffer.
 *
 * A line rewrite rather than a YAML round-trip, deliberately: these manifests
 * are comment-heavy — several carry a header explaining that the version is a
 * sentinel — and a round-trip would discard every one of those comments. This
 * is the same edit `release-build.sh` makes with `sed`, except that it happens
 * on the emitted copy and never on the working tree, so the whole class of
 * "a stamped version escaped into a commit" bug cannot occur.
 */
export function stampVersion(content: Buffer, version: string): Buffer {
  const text = content.toString("utf8");
  const stamped = text.replace(/^version:[^\r\n]*$/m, `version: ${version}`);
  return stamped === text ? content : Buffer.from(stamped, "utf8");
}

/**
 * The source bundles a release tree publishes, plus the files they reach for
 * outside themselves.
 *
 * Publishing the sources is what makes a release branch installable for *every*
 * target rather than only the three that declare a marketplace catalog:
 * `agent install` takes a bundle root and renders it in memory, so a host with
 * no catalog concept is served straight off the branch.
 *
 * Only the resource files a bundle actually references are published, and each
 * lands at the same path relative to its bundle that it had in the source
 * repository. Both halves matter: publishing a whole `docs/` tree would put an
 * unrelated documentation site on a branch people clone for plugins, and
 * publishing at a different depth would break the `../../..` references the
 * bundle already carries, which are not rewritten.
 */
export function buildSourceBundles(
  entries: SpecBundle[],
  bundles: Map<string, AgentBundle>,
): SourceBundleBuild {
  const artifacts: Artifact[] = [];
  const published: PublishedBundle[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  // Output path -> the absolute source it came from, so a collision is reported
  // against both origins rather than silently resolved.
  const claimed = new Map<string, string>();

  const claim = (output: string, origin: string, artifact: Artifact): void => {
    const prior = claimed.get(output);
    if (prior !== undefined) {
      // The same file reached by several bundles is one artifact, not a clash:
      // kps-ai-plugins' shared standards are referenced by three bundles.
      if (prior === origin) return;
      diagnostics.push(
        error("AB910", `'${prior}' and '${origin}' both publish to '${output}'`, {
          path: origin,
          remediation: "Rename one of them, or narrow a resourceRoot.",
        }),
      );
      return;
    }
    claimed.set(output, origin);
    artifacts.push(artifact);
  };

  for (const entry of entries) {
    const bundle = bundles.get(entry.path)!;
    const root = `${SOURCE_BUNDLES_DIRECTORY}/${bundle.name}`;
    // Already stamped in memory by the caller when --stamp-version was given, so
    // the catalogs, the rendered manifests and the published source all carry
    // one version by construction rather than by three agreeing rewrites.
    const version = bundle.version;

    if (version === VERSION_SENTINEL)
      diagnostics.push(
        error(
          "AB908",
          `Source bundle '${bundle.name}' would publish the ${VERSION_SENTINEL} sentinel`,
          {
            path: entry.path,
            remediation: "Pass --stamp-version, or set a real version in agent-bundle.yaml.",
          },
        ),
      );

    for (const file of allFiles(bundle.root)) {
      const relative = posix(file.path);
      const content =
        relative === "agent-bundle.yaml" ? stampVersion(file.content, version) : file.content;
      claim(`${root}/${relative}`, path.join(bundle.root, file.path), {
        path: `${root}/${relative}`,
        content,
        mode: file.mode,
      });
    }

    // Referenced resources, placed relative to the published bundle exactly as
    // they sit relative to the source bundle. Both KPS repositories keep their
    // bundles one level down and publish them one level down, so `../../shared`
    // normalizes back to `shared/` at the collection root with nothing rewritten.
    const reached = new Set<string>();
    for (const resource of bundle.externalResources) {
      if (reached.has(resource.absolute)) continue;
      reached.add(resource.absolute);

      const fromBundle = posix(path.relative(bundle.root, resource.absolute));
      const output = path.posix.normalize(`${root}/${fromBundle}`);
      if (output.startsWith("../") || output === "..") {
        diagnostics.push(
          error(
            "AB909",
            `'${resource.declared}' cannot be published: it resolves above the collection root`,
            {
              component: resource.component,
              path: resource.absolute,
              remediation:
                "Move the resource under a directory nearer the bundle, or vendor it into the bundle.",
            },
          ),
        );
        continue;
      }

      // Read directly: the parser already proved this path exists, is a regular
      // file, and does not escape its root through a symlink. Walking the
      // containing directory to find one known file would re-read a whole docs
      // tree per reference.
      claim(output, resource.absolute, {
        path: output,
        content: fs.readFileSync(resource.absolute),
        mode: fs.statSync(resource.absolute).mode & 0o777,
      });
    }

    // A root nothing reaches through publishes no directory, and the published
    // bundle then fails AB155 the moment a consumer renders it. Invisible until
    // then, which is why it is worth saying now.
    for (const declared of bundle.resourceRoots)
      if (!bundle.externalResources.some((resource) => resource.hostRoot === declared))
        diagnostics.push(
          diagnostic(
            "AB911",
            `'${bundle.name}' declares a resourceRoot nothing references; the published bundle will not render`,
            "unsupported",
            {
              path: declared,
              remediation: "Reference a file under it, or drop it from resourceRoots.",
            },
          ),
        );

    published.push({ name: bundle.name, source: root, version });
  }

  return { artifacts, published, diagnostics };
}
