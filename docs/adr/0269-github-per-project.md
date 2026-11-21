# ADR-0269: A project's GitHub repositories

<status>
Accepted on 2026-11-21, as step 3 (part 1) of the shared and private connectors plan.
The owner decided, on 2026-11-20: GitHub connects to a project, never to a group;
only the owner adds a project's connection. On 2026-11-21 the owner also asked for live
lookups in the project's replies "if needed", which part 2 adds. Extends
[ADR-0209](0209-owner-approved-jobs-read-a-github-copy-in-their-box.md) and
[ADR-0210](0210-github-access-goes-through-nochehs-own-github-app.md) (one GitHub app, copies
in the box). Amends [ADR-0205](0205-owner-approved-jobs-work-in-a-sealed-box.md)
(the box only for jobs asked in the owner's private chat) for one case. Follows
[ADR-0268](0268-notion-per-project-or-person.md).
</status>

## Context

One GitHub app per install reads the repositories the owner chose on GitHub. A box job
asked in the owner's private chat may read a copy of one. The owner wants a project,
such as one company, to use its own repositories in its groups, apart from the owner's
other repositories and from every other project's.

## Decision

1. **Linked by name.** `github_projects(repo, project_id)` in the control store links
   a repository, in lower case, to one project, copied or not, so part 2's lookups need
   no copy. Any repository not linked is the owner's own. A Remove of a copy keeps its
   link.
2. **Owner only.** `GET/POST /v1/github-projects` (`{repo, project|null}`) is an owner
   route. A link names an active project (404 `project_not_found`); a bad body is 400
   `invalid_github_repo`.
3. **Code jobs in a project's group.** The owner's own job, asked in their own message
   (not a follow-up) in a group of an active project, gets the sealed box only to read
   one of that project's copies (`job_box_not_allowed` without one,
   `job_repo_not_allowed` for any other copy). A member's job still never gets the box.
   The owner's private chat reads any copy, as before.
4. **Checked again while it runs.** A run of such a job gets its box only while the
   copy is still linked to the active project its group is in (`projectBoxJob`, and
   the launcher's live boxes). Unlinking or moving a repository withdraws the group jobs
   that pinned its copy and have not started; a running one loses its box, as a Remove
   does.
5. **What a job sees.** The job tool's status lists, in the owner's private chat, every
   copy with its project; for the owner's own turn in a project's group, only that
   project's copies.
6. **Dashboard.** Settings › Connections › GitHub: each repository has a "You only /
   Project" picker. Each project's drawer in Memory › Projects has "GitHub for this
   project": its repositories, Link and Unlink, each saving at once.

## Consequences

- Known gaps, accepted for now: members can't start code jobs in groups yet (step 5);
  a reset-setup or export does not carry the links (copies are not carried either).
- Checks: `test/store-job-repo-project.test.ts`, `test/store-job-repo.test.ts`, the
  dashboard browser test.
