// The j5 banner: "J5" in block letters with a tagline beside it, in the Johnny 5
// (Short Circuit, 1986) theme of the rest of the launcher's flavor text. Shown at the
// top of --help and of the interactive flow; never in --print or `j5 list` output,
// which people paste and scripts read.
//
// Only full blocks and box-drawing characters, no ░▒▓ shading: they render the same
// in every terminal font, and each is one column wide, so padEnd lines the tagline up.

const ART_LINES = [
  "    ██╗████████╗",
  "    ╚═╝██╔═════╝",
  "    ██╗██████╗",
  "    ██║╚═════██╗",
  "    ██║██████╔═╝",
  "██╗ ██║╚═════╝",
  "╚═██╔═╝",
  "  ╚═╝",
];

// One entry per art line; empty where the art stands alone.
const TAGLINE_LINES = [
  "",
  "",
  "Number 5 is alive.",
  "Agent teams for any checkout:",
  "issue in, pull request out.",
  "",
  "",
  "",
];

// Columns between the widest art line and the tagline.
const TAGLINE_GAP = "    ";

/** The banner: the art with the tagline to its right, trailing spaces removed. */
export function formatBanner(): string {
  const artWidth = Math.max(...ART_LINES.map((line) => line.length));
  return ART_LINES.map((artLine, index) =>
    `${artLine.padEnd(artWidth)}${TAGLINE_GAP}${TAGLINE_LINES[index] ?? ""}`.trimEnd(),
  ).join("\n");
}
