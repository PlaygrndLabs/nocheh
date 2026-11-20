/**
 * A board's shared columns in the members' app, as the page's `columns` name them (MemberTaskPage): a value as text, and
 * a field to set one. Only those columns: the owner's private columns and person columns never reach the page, and a
 * value under any other key is not shown. A choice shows by its option's name, never its id.
 */
import * as React from 'react';
import type {MemberTaskColumn} from '../../src/member-app-wire';
import {Field, Input, Select} from '../ui/core';
import {Plain, safeHref, useWords, type Board} from './shared';

/** The column types the page shows and sets; a column of any other type is left out. */
const known = new Set(['text', 'number', 'checkbox', 'date', 'url', 'select', 'multi_select']);
export const boardColumns = (board: Board) => board.columns.filter(column => known.has(column.type));

/** A column's value as a form holds it. */
export type Draft = string | boolean | string[];
const optionIds = (column: MemberTaskColumn) => new Set((column.options ?? []).map(option => option.id));

/** A stored value as the form holds it; a value the column cannot hold is left empty. */
export function draftOf(column: MemberTaskColumn, value: unknown): Draft {
  if (column.type === 'checkbox') return value === true;
  if (column.type === 'multi_select')
    return Array.isArray(value) ? value.filter((item): item is string => optionIds(column).has(item)) : [];
  if (column.type === 'select') return typeof value === 'string' && optionIds(column).has(value) ? value : '';
  if (column.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value : '';
}

/** What a form sends for a column: null clears it, and undefined says a number can't be read. */
export function valueOf(column: MemberTaskColumn, draft: Draft): unknown {
  if (column.type === 'checkbox') return draft === true;
  if (column.type === 'multi_select') return Array.isArray(draft) && draft.length ? [...draft] : null;
  const text = String(draft).trim();
  if (!text) return null;
  if (column.type === 'number') {
    const number = Number(text);
    return Number.isFinite(number) ? number : undefined;
  }
  return text;
}

/** A form's drafts for every column, from a task's values (or none). */
export const draftsOf = (board: Board, values: Record<string, unknown> = {}) =>
  Object.fromEntries(boardColumns(board).map(column => [column.id, draftOf(column, values[column.id])]));

/**
 * The `properties` a form sends: on a new task the values set, on an edit the values that changed from `values`; or the
 * column whose number can't be read.
 */
export function columnPatch(
  board: Board,
  drafts: Record<string, Draft>,
  values?: Record<string, unknown>,
): {properties: Record<string, unknown>} | {invalid: string} {
  const properties: Record<string, unknown> = {};
  for (const column of boardColumns(board)) {
    const value = valueOf(column, drafts[column.id] ?? draftOf(column, undefined));
    if (value === undefined) return {invalid: column.name};
    if (values) {
      const before = valueOf(column, draftOf(column, values[column.id]));
      if (JSON.stringify(before) !== JSON.stringify(value)) properties[column.id] = value;
    } else if (value !== null && value !== false) properties[column.id] = value;
  }
  return {properties};
}

/** A column's value as text, or null when it holds nothing the page can show. */
export function ColumnValue({column, value}: {column: MemberTaskColumn; value: unknown}) {
  const {day} = useWords();
  const draft = draftOf(column, value);
  if (column.type === 'checkbox') return value === true || value === false ? <span>{value ? '✓' : '–'}</span> : null;
  if (column.type === 'select' || column.type === 'multi_select') {
    const chosen = (Array.isArray(draft) ? draft : draft ? [draft as string] : []).map(
      id => column.options?.find(option => option.id === id)?.name ?? '',
    );
    return chosen.filter(Boolean).length ? <span dir="auto">{chosen.filter(Boolean).join(', ')}</span> : null;
  }
  if (draft === '') return null;
  if (column.type === 'number') return <span>{new Intl.NumberFormat('en').format(Number(draft))}</span>;
  if (column.type === 'date') return <span>{day(String(draft))}</span>;
  if (column.type === 'url') {
    const href = safeHref(String(draft));
    if (href)
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-accent-text underline">
          {String(draft)}
        </a>
      );
  }
  return <Plain text={String(draft)} />;
}

/** A field to set one column, labelled with its name. */
export function ColumnField({
  column,
  id,
  value,
  onChange,
}: {
  column: MemberTaskColumn;
  id: string;
  value: Draft;
  onChange: (value: Draft) => void;
}) {
  const {t} = useWords();
  if (column.type === 'checkbox')
    return (
      <label className="flex items-center gap-2 text-[13px] font-medium" dir="auto">
        <input
          id={id}
          type="checkbox"
          className="size-4 accent-[var(--accent)]"
          checked={value === true}
          onChange={event => onChange(event.target.checked)}
        />
        {column.name}
      </label>
    );
  if (column.type === 'multi_select') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="space-y-1.5">
        <legend className="text-[13px] font-medium" dir="auto">
          {column.name}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {(column.options ?? []).map(option => (
            <label key={option.id} className="flex items-center gap-2 text-sm" dir="auto">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={chosen.includes(option.id)}
                onChange={event =>
                  onChange(event.target.checked ? [...chosen, option.id] : chosen.filter(item => item !== option.id))
                }
              />
              {option.name}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <Field label={<span dir="auto">{column.name}</span>} htmlFor={id}>
      {column.type === 'select' ? (
        <Select id={id} value={text} onChange={event => onChange(event.target.value)}>
          <option value="">{t('column_none')}</option>
          {(column.options ?? []).map(option => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          dir={column.type === 'text' ? 'auto' : undefined}
          type={
            column.type === 'number'
              ? 'number'
              : column.type === 'date'
                ? 'date'
                : column.type === 'url'
                  ? 'url'
                  : 'text'
          }
          step={column.type === 'number' ? 'any' : undefined}
          inputMode={column.type === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={event => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/** Every shared column's field, for New task and Edit. */
export function ColumnFields({
  board,
  prefix,
  drafts,
  onChange,
}: {
  board: Board;
  prefix: string;
  drafts: Record<string, Draft>;
  onChange: (drafts: Record<string, Draft>) => void;
}) {
  return (
    <>
      {boardColumns(board).map((column, index) => (
        <ColumnField
          key={column.id}
          column={column}
          id={`${prefix}-column-${index}`}
          value={drafts[column.id] ?? draftOf(column, undefined)}
          onChange={value => onChange({...drafts, [column.id]: value})}
        />
      ))}
    </>
  );
}

/** A status choice from the board's statuses, for New task and Edit. */
export function StatusField({
  board,
  id,
  value,
  onChange,
}: {
  board: Board;
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const {t} = useWords();
  if (!board.statuses.length) return null;
  return (
    <Field label={t('field_status')} htmlFor={id}>
      <Select id={id} value={value} onChange={event => onChange(event.target.value)}>
        {!board.statuses.some(item => item.id === value) && <option value={value}>{t('column_none')}</option>}
        {board.statuses.map(item => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
