// Message and worktree-name templates in workflow.yaml use `{name}` placeholders.
// Only names declared in the manifest (plus the built-in `repo`) may appear; an
// unknown name is a manifest bug, so filling a template never silently leaves
// `{typo}` in a prompt sent to an agent.
//
// `{{` and `}}` are literal braces. A message that carries a whole prompt needs them
// for text such as `gh api repos/{{owner}}/{{repo}}/pulls`: without escaping, `{repo}`
// would be filled with the project's directory name and `{owner}` would be rejected.

// One alternation, scanned left to right, so `{{repo}}` is read as `{{`, `repo`, `}}`
// and never as the placeholder `{repo}`. Group 1 is set only for a placeholder.
const TOKEN_PATTERN = /\{\{|\}\}|\{([a-z][a-z0-9_-]*)\}/g;
const ESCAPED_OPENING_BRACE = "{{";

/**
 * Returns every placeholder name used in a template, in order of first appearance.
 */
export function extractPlaceholderNames(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const placeholderName = match[1];
    if (placeholderName !== undefined && !names.includes(placeholderName)) {
      names.push(placeholderName);
    }
  }
  return names;
}

/**
 * Replaces every `{name}` in the template with its value, and `{{` / `}}` with a
 * single brace.
 * @throws Error when the template uses a placeholder that has no value.
 */
export function fillTemplate(template: string, valuesByName: Record<string, string>): string {
  return template.replace(TOKEN_PATTERN, (wholeMatch, placeholderName: string | undefined) => {
    if (placeholderName === undefined) {
      return wholeMatch === ESCAPED_OPENING_BRACE ? "{" : "}";
    }
    const value = valuesByName[placeholderName];
    if (value === undefined) {
      throw new Error(`template placeholder ${wholeMatch} has no value`);
    }
    return value;
  });
}
