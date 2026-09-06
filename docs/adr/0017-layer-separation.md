# ADR-0017: Orchard is a separate repository, and the model layer is a read-only dependency

**Status:** Accepted.

## Decision

**1. Orchard is its own repository**, not a directory inside a platform or
inside whatever stands up the models.

**2. The dependency direction is one way and never reverses.** The content
platform depends on Orchard. Orchard depends on a model endpoint. The model
layer depends on nothing above it and does not know Orchard exists.

**3. Orchard is read only toward the model layer.** It consumes deployed
endpoints. It never requests a deployment, never triggers one, never edits a
model registry, and has no feedback path of any kind downward.

**4. Adding a model is a human act, performed elsewhere.** When a job needs a
model that is not deployed, a person adds it and deploys it. Orchard's job on
meeting an undeployed model is to stop and say so, which is
[ADR-0018](0018-model-to-job-map.md).

**5. Orchard requires an OpenAI-compatible endpoint, never a particular
cloud.** Models are reached over the OpenAI wire format. Naming a specific
provider here would force every adopter onto it and defeat the point of
publishing this at all. A specific Foundry deployment is a supported and
documented way to stand one up, and is the worked example in the install guide.
It is not a requirement.

**6. Only Orchard touches the model layer.** Discovery, selection, the content
database, the learner surfaces and manual content creation have no relationship
to it. A statement that the content platform depends on a particular model
deployment is wrong, and has been made and corrected more than once.

## Why a repository rather than a directory

The directory was cheaper day to day and lost on one argument: an adopter has
to be able to clone the tool without taking a whole platform with it, and the
install guide has to describe connecting it to **their** endpoint. Both are far
easier to trust when the boundary is physical rather than a convention.

That was not hypothetical. Two codebases were in the wrong repositories when
this was written, and both got there through a directory convention nobody
enforced.

See also: [Repository boundary](https://github.com/project42dev/orchard/blob/main/REPO-BOUNDARY.md).
