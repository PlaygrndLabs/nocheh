/**
 * "Role and skills": who Nocheh is in a chat and the skills it may use there.
 * They live in the chat's own Hermes profile (its SOUL.md and skills folder);
 * `default` holds the ones every chat starts from. Only the owner sets them.
 */
import {useState} from 'react';
import {Plus, Trash2} from 'lucide-react';
import {apiPost, type ApiError} from '../../lib/api';
import {useDraftSource} from '../../lib/drafts';
import {refreshResources, useResource} from '../../lib/resource';
import {Button, Card, CardHeader, Field, Input, LoadError, LoadingRows, Textarea} from '../../ui/core';

export type Skill = {name: string; description: string; body: string};
type Persona = {scope: string; role: string; skills: Skill[]; revision: string};

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const LIMITS = {role: 20000, skills: 30, description: 1024, body: 20000};

/** Plain-language problems with the edits, keyed by skill position; `role` for the role. */
export function personaProblems(role: string, skills: Skill[]): Record<string, string> {
  const problems: Record<string, string> = {};
  if (role.length > LIMITS.role) problems.role = `Keep the role under ${LIMITS.role.toLocaleString()} characters.`;
  if (skills.length > LIMITS.skills) problems.skills = `Use at most ${LIMITS.skills} skills.`;
  const seen = new Set<string>();
  skills.forEach((skill, index) => {
    const name = skill.name.trim();
    if (!NAME.test(name))
      problems[index] = 'Name it with lower-case English letters, digits and dashes, like weekly-menu.';
    else if (seen.has(name)) problems[index] = 'Two skills have this name. Give each its own.';
    else if (!skill.description.trim()) problems[index] = 'Say when Nocheh should use this skill.';
    else if (skill.description.length > LIMITS.description)
      problems[index] = `Keep “When to use it” under ${LIMITS.description.toLocaleString()} characters.`;
    else if (!skill.body.trim()) problems[index] = 'Write what Nocheh should do.';
    else if (skill.body.length > LIMITS.body)
      problems[index] = `Keep the instructions under ${LIMITS.body.toLocaleString()} characters.`;
    seen.add(name);
  });
  return problems;
}

const same = (a: Skill[], b: Skill[]) => JSON.stringify(a) === JSON.stringify(b);

export function RoleAndSkills({scope, where, description}: {scope: string; where: string; description: string}) {
  const persona = useResource<Persona>('/memory/persona?scope=' + encodeURIComponent(scope));
  const data = persona.data && persona.data.scope === scope ? persona.data : null;
  const [role, setRole] = useState<string | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const currentRole = role ?? data?.role ?? '';
  const currentSkills = skills ?? data?.skills ?? [];
  const problems = personaProblems(currentRole, currentSkills);
  const roleChanged = !!data && role !== null && role.trim() !== data.role;
  const skillsChanged = !!data && skills !== null && !same(skills, data.skills);
  const start = () => setRevision(current => current ?? data?.revision ?? null);
  const reset = () => {
    setRole(null);
    setSkills(null);
    setRevision(null);
    setChecked(false);
  };
  const editSkill = (index: number, change: Partial<Skill>) => {
    start();
    setSkills(currentSkills.map((skill, at) => (at === index ? {...skill, ...change} : skill)));
  };

  useDraftSource({
    id: 'persona:' + scope,
    labels: [...(roleChanged ? ['Role (' + where + ')'] : []), ...(skillsChanged ? ['Skills (' + where + ')'] : [])],
    save: async () => {
      setChecked(true);
      if (Object.keys(problems).length) throw new Error('Fix the marked role and skills fields, then save again.');
      try {
        await apiPost('/memory/persona', {
          scope,
          role: currentRole.trim(),
          skills: currentSkills.map(skill => ({
            name: skill.name.trim(),
            description: skill.description.trim(),
            body: skill.body.trim(),
          })),
          revision: revision ?? data?.revision,
        });
        reset();
        await refreshResources();
      } catch (e) {
        throw new Error(
          /conflict|changed/.test((e as ApiError)?.message ?? '')
            ? 'The role or skills were changed somewhere else. Your edits are kept; check them and save again.'
            : 'Couldn’t save the role and skills.',
        );
      }
    },
    discard: reset,
  });

  return (
    <Card>
      <CardHeader title="Role and skills" description={description} />
      <div className="px-5 pt-3 pb-5">
        {persona.error && !data ? (
          <LoadError what="the role and skills" />
        ) : !data ? (
          <LoadingRows rows={2} />
        ) : (
          <div className="space-y-5">
            <Field
              label="Role"
              htmlFor={'role-' + scope}
              error={checked ? problems.role : undefined}
              hint="Who Nocheh is here and how it behaves: its tone, language and what it helps with."
            >
              <Textarea
                id={'role-' + scope}
                dir="auto"
                rows={4}
                value={currentRole}
                placeholder={
                  scope === 'default' ? 'No role set. Nocheh uses its built-in one.' : 'Uses the role for every chat.'
                }
                onChange={event => {
                  start();
                  setRole(event.target.value);
                }}
              />
            </Field>
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[13px] font-medium">Skills</h3>
                <p className="text-xs text-muted">
                  {scope === 'default'
                    ? 'Every chat can use these.'
                    : 'Added to the skills for every chat. A skill with the same name replaces that one here.'}
                </p>
              </div>
              {checked && problems.skills && (
                <p className="text-xs text-bad" role="alert">
                  {problems.skills}
                </p>
              )}
              {!currentSkills.length && <p className="text-[13px] text-muted">No skills yet.</p>}
              {currentSkills.map((skill, index) => (
                <div key={index} className="space-y-3 rounded-lg border border-line p-3.5">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
                    <Field label="Name" htmlFor={`skill-${scope}-${index}-name`}>
                      <Input
                        id={`skill-${scope}-${index}-name`}
                        value={skill.name}
                        placeholder="weekly-menu"
                        autoCapitalize="none"
                        spellCheck={false}
                        onChange={event => editSkill(index, {name: event.target.value})}
                      />
                    </Field>
                    <Field label="When to use it" htmlFor={`skill-${scope}-${index}-when`}>
                      <Input
                        id={`skill-${scope}-${index}-when`}
                        dir="auto"
                        value={skill.description}
                        placeholder="When someone asks what to cook this week."
                        onChange={event => editSkill(index, {description: event.target.value})}
                      />
                    </Field>
                    <Button
                      size="icon"
                      aria-label={`Remove skill ${skill.name || index + 1}`}
                      title="Remove this skill"
                      onClick={() => {
                        start();
                        setSkills(currentSkills.filter((_, at) => at !== index));
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  <Field
                    label="Instructions"
                    htmlFor={`skill-${scope}-${index}-body`}
                    error={checked ? problems[index] : undefined}
                  >
                    <Textarea
                      id={`skill-${scope}-${index}-body`}
                      dir="auto"
                      rows={4}
                      value={skill.body}
                      placeholder="What Nocheh should do when this skill applies."
                      onChange={event => editSkill(index, {body: event.target.value})}
                    />
                  </Field>
                </div>
              ))}
              <Button
                size="sm"
                disabled={currentSkills.length >= LIMITS.skills}
                onClick={() => {
                  start();
                  setSkills([...currentSkills, {name: '', description: '', body: ''}]);
                }}
              >
                <Plus aria-hidden /> Add skill
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
