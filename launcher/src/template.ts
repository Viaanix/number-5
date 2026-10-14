// Message and worktree-name templates in workflow.yaml use `{name}` placeholders.
// Only names declared in the manifest (plus the built-in `repo`) may appear; an
// unknown name is a manifest bug, so filling a template never silently leaves
// `{typo}` in a prompt sent to an agent.

const PLACEHOLDER_PATTERN = /\{([a-z][a-z0-9_-]*)\}/g;

/**
 * Returns every placeholder name used in a template, in order of first appearance.
 */
export function extractPlaceholderNames(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const placeholderName = match[1];
    if (placeholderName !== undefined && !names.includes(placeholderName)) {
      names.push(placeholderName);
    }
  }
  return names;
}

/**
 * Replaces every `{name}` in the template with its value.
 * @throws Error when the template uses a placeholder that has no value.
 */
export function fillTemplate(template: string, valuesByName: Record<string, string>): string {
  return template.replace(PLACEHOLDER_PATTERN, (wholeMatch, placeholderName: string) => {
    const value = valuesByName[placeholderName];
    if (value === undefined) {
      throw new Error(`template placeholder ${wholeMatch} has no value`);
    }
    return value;
  });
}
