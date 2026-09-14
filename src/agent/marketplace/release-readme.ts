import type { Artifact } from "../types.js";
import type { ReleaseManifest } from "./release-manifest.js";

/**
 * The landing page of a published release branch.
 *
 * Generated here rather than by each publishing repository, because otherwise
 * every repository that publishes a release branch writes the same document
 * generator — which is the duplication this layout exists to remove. The one
 * thing cairn cannot know is which repository it is being published from, so
 * that is the single input.
 */
export function buildReleaseReadme(manifest: ReleaseManifest, repository: string): Artifact {
  const ssh = `git@github.com:${repository}.git`;
  const tag = `release-v${manifest.version}`;

  const rows = manifest.bundles.map((bundle) => {
    const hosts = Object.keys(bundle.targets).join(", ");
    // Pipes and newlines would break the row; a description is free text.
    const description = bundle.description.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
    return `| \`${bundle.name}\` | ${hosts || "—"} | ${description} |`;
  });

  const sections: string[] = [
    `# ${manifest.marketplace} — release ${manifest.version}`,
    "",
    "**Generated branch. Do not edit.** The source lives on `main`; this tree is built by CI and",
    `pushed here. See https://github.com/${repository}.`,
    "",
    "| Plugin | Hosts | Description |",
    "| ------ | ----- | ----------- |",
    ...rows,
    "",
  ];

  const claude = manifest.targets["claude-code"];
  if (claude?.catalog) {
    const first = manifest.bundles.find((bundle) => "claude-code" in bundle.targets);
    sections.push(
      "## Claude Code",
      "",
      "```text",
      `/plugin marketplace add ${ssh}#release`,
      ...(first ? [`/plugin install ${first.name}@${manifest.marketplace}`] : []),
      "```",
      "",
    );
  }

  const codex = manifest.targets["codex"];
  if (codex?.catalog) {
    const first = manifest.bundles.find((bundle) => "codex" in bundle.targets);
    sections.push(
      "## Codex",
      "",
      "`--ref` is what pins the marketplace to this branch; without it Codex fetches the",
      "repository's default branch, which carries the bundle sources and no catalog at its root.",
      "",
      "```bash",
      `codex plugin marketplace add ${repository} --ref release`,
      ...(first ? [`codex plugin add ${first.name}@${manifest.marketplace}`] : []),
      "```",
      "",
      "Codex installs from a local snapshot of this catalog, so a later release reaches an existing",
      `install only through \`codex plugin marketplace upgrade ${manifest.marketplace}\`.`,
      "",
    );
  }

  const cursor = manifest.targets["cursor"];
  if (cursor?.catalog) {
    sections.push(
      "## Cursor",
      "",
      "```bash",
      `agent plugin marketplace add ${ssh} --git-ref release`,
      "```",
      "",
    );
  }

  // Every host with no catalog, and every host at all as a fallback: the source
  // bundles are the one install route that works for all of them.
  const sourceOnly = Object.entries(manifest.targets)
    .filter(([, entry]) => entry.catalog === null)
    .map(([name]) => name);
  if (sourceOnly.length > 0) {
    const first = manifest.bundles[0]?.name ?? "<bundle>";
    sections.push(
      `## ${sourceOnly.map(titleCase).join(", ")}`,
      "",
      `${sourceOnly.length === 1 ? "This host declares" : "These hosts declare"} no marketplace catalog, so the published source`,
      "bundles are the install route. `cairn agent install` takes a bundle root and renders it in",
      "memory, so nothing else is needed:",
      "",
      "```bash",
      `git clone --branch release ${ssh}`,
      `cairn agent install ${repository.split("/")[1]}/bundles/${first} --target ${sourceOnly[0]} --scope user`,
      "```",
      "",
    );
  }

  sections.push(
    "## Pinning",
    "",
    `To pin an exact release, use the tag rather than the branch: \`#${tag}\` for Claude Code,`,
    `\`--git-ref ${tag}\` for Cursor, \`--ref ${tag}\` for Codex. Pinning also opts out of`,
    "background auto-update.",
    "",
    "Prefer the SSH URL where one is shown. Claude Code's background refresh disables git",
    "credential helpers for its `git pull`, so HTTPS auto-update against a private repository can",
    "fail silently; a key loaded in `ssh-agent` authenticates background pulls the same as",
    "foreground ones.",
    "",
  );

  return {
    path: "README.md",
    content: Buffer.from(sections.join("\n")),
    mode: 0o644,
  };
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
