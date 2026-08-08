# Delivery role prompts

Version-controlled prompt templates for the delivery platform, per section 8.3
of `pmo/plans/foundry-powered-project-42.md`.

**These are the system prompts. They are not suggestions to a model, they are
the contract for what each role must produce**, and the harness depends on the
verdict lines they mandate.

## The roles

| File | Role | Must differ from |
|---|---|---|
| `researcher.md` | Gathers evidence before drafting begins | n/a |
| `drafter.md` | Produces the candidate artifact | n/a |
| `verifier.md` | Checks claims against cited sources | Drafter, by **provider family** |
| `adversary.md` | Tries to refute the draft | Drafter and verifier, by deployment |
| `arbiter.md` | Resolves a split, on human request only | All three |
| `finalizer.md` | Reviews the complete package before human handoff | n/a |

## Rules that apply to every prompt

1. **Verdict lines are parsed by the harness.** The verifier must end with
   `VERDICT: PASS` or `VERDICT: FAIL`. The adversary must end with
   `VERDICT: REFUTED` or `VERDICT: STANDS`. Changing that wording breaks
   agreement detection.
2. **The verifier prompt states whether URLs can be fetched.** If they cannot,
   it must report `CANNOT VERIFY` rather than `PASS` for anything it could not
   check. A text-only second opinion must never be recorded as fact-checking.
3. **No em-dashes.** House rule, applies to generated prose as well as ours.
4. **UNKNOWN over estimation.** Every role marks what it cannot establish
   rather than producing a plausible number.
5. **Changing a prompt changes the meaning of the metrics.** Record the change
   and the date, because catch rate before and after are not comparable.

## Changing these

A prompt edit is a change to the quality bar. Treat it as one: state what
changed, why, and what you expect it to do to the section 8.5 metrics.
