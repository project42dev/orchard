# Repository boundary

This file states what this repository is for, what must never be added to it,
and where to look instead. It exists because two codebases previously ended up
in the wrong repositories, and both got there through a directory convention
that nobody enforced.

Governing decision: **ADR-0017**, Orchard and the Foundry layer separation.

## What this is

**Orchard, the content lifecycle tool.** It builds content, updates it, removes
it, and drives the content database.

- Visibility: **public**
- Licence: Apache-2.0
- Depends on: **an OpenAI-compatible model endpoint**, supplied by the operator

## What must never go here

| Do not add | Because | Where it belongs |
|---|---|---|
| **Content itself** | Orchard is the tool, not the library. A tool that ships content cannot be adopted by anyone with different content. | `project42-platform` |
| **Infrastructure definitions** | Orchard never provisions. Bicep, Terraform, and deployment templates invert the dependency direction. | `homestead-foundry`, or the adopter's own infrastructure repo |
| **A hard dependency on a specific Foundry, tenant, or cloud** | It would force every adopter onto one vendor and defeat the open-source goal. | Configuration supplied by the operator at run time |
| **Private planning, PMO material, or board records** | This repository is public. | `project42dev-ops`, which is private |
| **Secrets, tenant names, subscription ids, keys, vault names** | Public repository. | The operator's own secret store |
| **Learner data, or anything derived from it** | Orchard never sees learners. | The account and learner-data surfaces |

## Looking for something else?

| Looking for | It lives in |
|---|---|
| The content, the content model, the schemas | `project42-platform` |
| The public marketing and entry surface | `project-42.dev` |
| The Learn delivery surface | `learn.project-42.dev` |
| The Field Guide delivery surface | `guide.project-42.dev` |
| Learner account and profile | `account.project-42.dev` |
| Owner administration | `admin.project-42.dev` |
| An Azure AI Foundry deployment framework | `homestead-foundry` |
| One owner's Foundry instance and model registry | `my-homestead-foundry` |
| Planning, sprints, ADRs, board records | `project42dev-ops`, private |

## The rule in one line

**Orchard consumes endpoints and produces content. If a change would make it
provision something, hold something, or require a particular vendor, it does not
belong here.**
