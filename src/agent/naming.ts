import type { AgentProfile, AgentTarget } from "./types.js";
import type { ReferenceKind } from "./targets/schema.js";
import { profileFor } from "./targets/index.js";

/**
 * Component identity, in one place.
 *
 * Two questions live here, and they have to be answered by the same data: what
 * a component is *called* in a rendered tree, and what another document must
 * *write* to name it. They used to be answered apart — a `namespacePluginSkills`
 * boolean prefixed a Cursor skill's directory while `metadataFor` left its
 * frontmatter `name` alone — so `skills/cr-review/SKILL.md` shipped saying
 * `name: review`. A component with two identities is why Cursor's skill support
 * is `approximate`, and it is the bug {@link emittedName} closes.
 *
 * The inverse matters as much as the forward direction: `agent import` has to
 * undo exactly what the renderer did, and a second `startsWith` written
 * somewhere else would eventually disagree. {@link stripEmittedPrefix} is that
 * inverse.
 */

type NamespacedKind = "skills" | "agents";

const PLURAL: Record<"skill" | "agent", NamespacedKind> = { skill: "skills", agent: "agents" };

function prefixFor(
  kind: "skill" | "agent",
  target: AgentTarget,
  profile: AgentProfile,
  bundleName: string,
): string {
  const { namespace } = profileFor(target).naming;
  if (!namespace.prefixed[PLURAL[kind]].includes(profile)) return "";
  return `${bundleName}${namespace.separator}`;
}

/** What a component is called in the rendered tree — its path and its `name:`. */
export function emittedName(
  kind: "skill" | "agent",
  name: string,
  target: AgentTarget,
  profile: AgentProfile,
  bundleName: string,
): string {
  return `${prefixFor(kind, target, profile, bundleName)}${name}`;
}

/**
 * The exact inverse of {@link emittedName}.
 *
 * Removes **one** occurrence, never a repeated one: a skill legitimately named
 * `cr-review` in a bundle named `cr` renders as `cr-cr-review`, and stripping
 * greedily would import it as `review`. A remainder that is empty or is not a
 * component name means the text was never this prefix, so it is left alone.
 */
export function stripEmittedPrefix(
  kind: "skill" | "agent",
  name: string,
  target: AgentTarget,
  profile: AgentProfile,
  bundleName: string,
): string {
  const prefix = prefixFor(kind, target, profile, bundleName);
  if (!prefix || !name.startsWith(prefix)) return name;
  const remainder = name.slice(prefix.length);
  return remainder.length ? remainder : name;
}

/**
 * What another document writes to name this component on this host.
 *
 * `exact: false` says the host has no such surface and the bare name was used.
 * The caller turns that into `AB303`; returning a boolean rather than pushing a
 * diagnostic is what keeps this module free of the diagnostic vocabulary.
 */
export function referenceIdentifier(
  kind: ReferenceKind,
  name: string,
  target: AgentTarget,
  profile: AgentProfile,
  bundleName: string,
): { text: string; exact: boolean } {
  const { namespace, references } = profileFor(target).naming;
  const form = references.forms[kind]?.[profile];
  if (!form) return { text: name, exact: false };
  return {
    text: form
      .replace(/\{bundle\}/g, bundleName)
      .replace(/\{separator\}/g, namespace.separator)
      .replace(/\{name\}/g, name),
    exact: true,
  };
}
