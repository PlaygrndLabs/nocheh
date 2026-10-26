/**
 * A small, safe Markdown view for task notes: headings, lists, quotes, code,
 * bold, italic, inline code and web links. Text is never read as HTML.
 */
import * as React from 'react';

function inline(text: string, key: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const id = key + '-' + match.index;
    if (match[1])
      parts.push(
        <code key={id} className="rounded bg-subtle px-1 font-mono text-[0.9em]">
          {match[1].slice(1, -1)}
        </code>,
      );
    else if (match[2]) parts.push(<strong key={id}>{inline(match[2].slice(2, -2), id)}</strong>);
    else if (match[3]) parts.push(<em key={id}>{inline(match[3].slice(1, -1), id)}</em>);
    else
      parts.push(
        <a key={id} href={match[5]} target="_blank" rel="noreferrer noopener" className="text-accent-text underline">
          {match[4]}
        </a>,
      );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({text, className}: {text: string; className?: string}) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const key = 'b' + i;
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      i++;
      blocks.push(
        <pre key={key} className="overflow-x-auto rounded-lg bg-subtle p-3 font-mono text-xs">
          {code.join('\n')}
        </pre>,
      );
    } else if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = (['h3', 'h4', 'h5'] as const)[level - 1]!;
      blocks.push(
        <Tag key={key} className={level === 1 ? 'text-base font-semibold' : 'text-sm font-semibold'}>
          {inline(line.replace(/^#+\s/, ''), key)}
        </Tag>,
      );
      i++;
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: React.ReactNode[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]!); i++) {
        const item = lines[i]!.replace(/^\s*([-*]|\d+\.)\s/, '');
        const box = item.match(/^\[([ xX])\]\s(.*)$/);
        items.push(
          <li key={'i' + i}>
            {box ? (
              <span className={box[1] === ' ' ? '' : 'text-muted line-through'}>
                {box[1] === ' ' ? '☐ ' : '☑ '}
                {inline(box[2]!, 'i' + i)}
              </span>
            ) : (
              inline(item, 'i' + i)
            )}
          </li>,
        );
      }
      blocks.push(
        ordered ? (
          <ol key={key} className="list-decimal space-y-0.5 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={key} className="list-disc space-y-0.5 pl-5">
            {items}
          </ul>
        ),
      );
    } else if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={key} className="border-l-2 border-line-strong pl-3 text-muted">
          {inline(quote.join(' '), key)}
        </blockquote>,
      );
    } else if (!line.trim()) i++;
    else {
      const paragraph: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && !/^(```|#{1,3}\s|\s*([-*]|\d+\.)\s|>)/.test(lines[i]!); i++)
        paragraph.push(lines[i]!);
      blocks.push(
        <p key={key} className="whitespace-pre-line">
          {inline(paragraph.join('\n'), key)}
        </p>,
      );
    }
  }
  return (
    <div dir="auto" className={'space-y-2 text-sm break-words ' + (className ?? '')}>
      {blocks}
    </div>
  );
}
