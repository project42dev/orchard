# ADR-0027: Qualified independent roles, and every handoff is bound

**Status:** Accepted.

## Decision

1. **Roles run in a fixed order:** evidence researcher, writer, editor, factual
   verifier, accessibility reviewer, independent final reviewer.
2. **Assessment changes require assessment review, and diagram changes require
   diagram accessibility and visual review.** These may be separately qualified
   specialists, or recorded sub-responsibilities where the scope is simple, but
   they are never assumed.
3. **Every handoff validates against a schema and binds** the run, item,
   approved revision, Gate 1 decision event, tracker external key and real
   tracker id, role, model identity, provider family, prompt version, input
   digest, output digest, and predecessor digest. The chain is reconstructable
   end to end.
4. **The writer and the factual verifier use different provider families, and
   the final reviewer is neither the writer nor the editor.**
5. **Models qualify on held-out fixtures** covering role quality, primary-source
   fidelity, planted defects, conflicting evidence, prompt injection, structured
   output, accessibility, latency, cost and recovery. **A qualification expires**
   on any material model or prompt change, and on a schedule regardless.
6. **Factual verification maps each volatile claim to current primary
   evidence.** Missing or conflicting evidence blocks readiness rather than
   producing a caveat.
7. **Accessibility review covers** structure, keyboard behaviour where
   applicable, captions, transcripts, text alternatives, colour independence,
   zoom and reduced motion, with human assistive-technology evidence where it is
   required. **A failed check cannot be waived by automation.**
8. **Prompts and role contracts are versioned. Hidden reasoning is never
   required or retained.**
9. **Agents may propose, revise and review. They cannot approve gates, grant
   themselves authority, publish outside the transaction, or close tracker
   work.**

## Why cross-family independence

A verifier sharing a model family with the writer it is checking shares that
family's blind spots and its confident mistakes. It will agree for the same
reasons the writer was wrong, and the agreement reads as corroboration. The
independence is the entire value of the check.

## Why qualifications expire

A role assignment that passed on fixtures six months ago is evidence about a
model that may since have been updated underneath the same name. An assignment
that never expires is a claim about the past presented as a claim about the
present.

## Why decision 9 is absolute

Every other control in Orchard rests on the boundary between proposing and
deciding. An agent that can approve its own work removes the human from the
loop while leaving all the paperwork that suggests one is still there, which is
worse than having no gate at all.
