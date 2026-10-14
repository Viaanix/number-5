// Interactive questions for values the user did not pass as flags. Thin wrappers
// over @clack/prompts that turn Ctrl-C / Escape into one error type, so the CLI
// has a single place that handles "the user backed out".

import * as clack from "@clack/prompts";

/** Thrown when the user cancels a prompt; the CLI exits without launching anything. */
export class LaunchCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "LaunchCancelledError";
  }
}

/** One choice in a select prompt. */
export type Choice = { value: string; label: string; hint?: string };

function unwrapAnswer<Answer>(answer: Answer | typeof clack.CANCEL_SYMBOL): Answer {
  if (clack.isCancel(answer)) {
    throw new LaunchCancelledError();
  }
  return answer;
}

/** Asks the user to pick one of the choices; returns the chosen value. */
export async function askToChoose(
  message: string,
  choices: Choice[],
  initialValue?: string,
): Promise<string> {
  const options = choices.map((choice) =>
    choice.hint === undefined
      ? { value: choice.value, label: choice.label }
      : { value: choice.value, label: choice.label, hint: choice.hint },
  );
  const answer = await clack.select<string>(
    initialValue === undefined ? { message, options } : { message, options, initialValue },
  );
  return unwrapAnswer(answer);
}

/**
 * Asks for free text, re-asking while describeProblem returns a message.
 * @param initialValue pre-filled text the user can accept with Enter or edit.
 */
export async function askForText(
  message: string,
  describeProblem: (value: string) => string | undefined,
  initialValue?: string,
): Promise<string> {
  const validate = (value: string | undefined) => describeProblem(value ?? "");
  const answer = await clack.text(
    initialValue === undefined ? { message, validate } : { message, validate, initialValue },
  );
  return unwrapAnswer(answer);
}

/** Asks a yes/no question; returns true for yes. */
export async function askToConfirm(message: string): Promise<boolean> {
  return unwrapAnswer(await clack.confirm({ message }));
}

/** Opens the prompt flow with a title line. */
export function showBanner(title: string): void {
  clack.intro(title);
}

/** Prints a titled block of text in the prompt flow. */
export function showNote(message: string, title: string): void {
  clack.note(message, title);
}
