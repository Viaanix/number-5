---
name: test-quality-with-ai
description: |
  Self-contained guide to writing, reviewing, and maintaining high-quality tests with AI assistance.
  Defends against two failure modes: fig-leaf tests (pass without verifying behavior) and evasion
  (existing tests weakened to mask real bugs). Router skill — loads narrow workflow files by task
  intent. Covers single-test writing, single-file review, suite-scale audit, failing-test response,
  and framework-specific pitfalls for Vitest and bun:test.
  Use when writing new tests, reviewing tests in a PR, auditing a test suite at scale, responding
  to a failing test, or auditing existing tests for quality.
trigger_phrase:
  opus: "test quality writing reviewing"
  sonnet: "test quality writing reviewing vitest bun"
  haiku: "add a test fix this test test failing mock"
---

# Test Quality with AI

A test is a claim about behavior. The claim needs proof — a broken implementation must fail it. This skill defends against two failure modes that recur when AI assists with test writing:

1. **Fig-leaf tests** — tests that pass without verifying behavior, written so the agent can claim "I tested it" and check a box.
2. **Evasion** — existing tests modified to mask a real bug rather than fix the code.

The skill is a **router**: it states the load-bearing principles, then dispatches you to the workflow file that matches what you're actually doing. Don't try to apply everything at once.

## The four principles

These apply at every stage. Internalize them before reading any workflow.

1. **A test is a claim about behavior.** A broken implementation must fail it. If `return null` passes the test, the test is not testing.
2. **"What bug would this test catch?"** State it in one sentence per test. The sentence must name a *specific* failure mode — a particular line, condition, or contract violation — not a generic statement ("catches bugs where the function returns wrong values" is content-free). *This is the single highest-leverage discipline in this skill, and the one most prone to soft-floor evasion.* See `checklists/pre-claim.md` "Specific vs generic claims" for the falsifier.
3. **When a test fails, the default is the code is wrong, not the test.** Inverting that default requires written justification of the behavior change.
4. **Coverage is a floor, not a ceiling.** 100% coverage with permissive assertions is the fig-leaf endgame.

## Router — pick your workflow

**Writing? Reviewing? Auditing? Maintaining?** Pick one. Identify what you're actually doing and load the matching workflow file before applying its discipline. Don't load workflows you aren't using.

| You are... | Load |
|---|---|
| About to **write a new test** | `workflows/generate.md` |
| **Reviewing tests** in a single PR or file | `workflows/review-single.md` |
| **Auditing a suite** of N test files at scale | `workflows/review-at-scale.md` |
| Responding to a **failing test** | `workflows/maintain-failing.md` |

Each workflow loads the checklists and references it needs. The router itself doesn't.

## Bundled tooling

This skill ships a grep-based Tier 1 pre-screen at `scripts/check-test-quality.sh`. It catches the deterministic fig-leaf signals (committed `.only`, `@ts-expect-error`, snapshot regenerations without inspection, empty catch blocks, weak assertions) without LLM analysis. The audit workflows reference it as their first step.

See `scripts/README.md` for invocation, CI integration examples, and tuning guidance.

```bash
./scripts/check-test-quality.sh                       # scan cwd
./scripts/check-test-quality.sh --diff origin/main..HEAD --strict  # CI gating
./scripts/check-test-quality.sh --json                # structured output
```

## Conditional framework references

Identify the framework before writing code that imports from it. AI training data is heavily Jest-weighted; without explicit anchoring agents reach for `jest.fn` / `jest.mock` even in Vitest or bun:test projects.

| Project framework | Load |
|---|---|
| Vitest (`vitest.config.ts`, `vitest` in package.json) | `references/vitest-patterns.md` |
| bun:test (imports from `bun:test`, `bunfig.toml`) | `references/bun-test-patterns.md` |
| Other / unclear | Read existing tests to identify; do not guess |

These references cover what AI tools commonly get wrong for each framework — namespaces, mock APIs, watch-mode behavior, async patterns, fake timers, snapshot conventions. Load the relevant one in any workflow that produces code.

## Self-contained design

This skill does not link to or depend on other skills. All required content lives inside the skill tree. The router pattern keeps the always-loaded surface small; the linked files together cover everything a single skill would.

If this skill ever lifts into a dedicated test agent's system prompt, the agent loads SKILL.md + every workflow + every checklist + every reference. They are designed to read coherently when concatenated.

## File structure

```
test-quality-with-ai/
├── SKILL.md                              this file — router only
├── workflows/
│   ├── generate.md                       writing a new test
│   ├── review-single.md                  reviewing one PR / file
│   ├── review-at-scale.md                auditing N files
│   └── maintain-failing.md               responding to a failing test
├── checklists/
│   ├── fig-leaf-signals.md               the list of detection patterns
│   ├── mock-antipatterns.md              five named mock anti-patterns
│   └── pre-claim.md                      before declaring "tested"
├── references/
│   ├── vitest-patterns.md                Vitest-specific pitfalls
│   ├── bun-test-patterns.md              bun:test-specific pitfalls
│   └── assertion-shape.md                toMatchObject vs toEqual vs toStrictEqual
└── scripts/
    ├── check-test-quality.sh             Tier 1 grep pre-screen
    └── README.md                         script invocation + CI integration
```
