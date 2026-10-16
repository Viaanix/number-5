// Best-effort detection of credentials in text a team is about to post to GitHub. The text is
// model-written from untrusted content (a pull request, an issue), and a comment can be read by
// everyone with access to the repository. Shared so no team imports another's helper.

/**
 * Best-effort credential shapes. A match blocks posting; no match is not proof the text is
 * clean, so each team's instructions also forbid quoting secrets.
 */
const CREDENTIAL_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Anthropic or OpenAI API key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  { name: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

/** The name of the first credential shape found in the text, or undefined when none matches. */
export function findCredentialShape(text: string): string | undefined {
  return CREDENTIAL_PATTERNS.find(({ pattern }) => pattern.test(text))?.name;
}
