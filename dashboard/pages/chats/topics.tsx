/**
 * A forum group's topics. Telegram doesn't let bots list topics, so new ones
 * appear when used, and older quiet ones can be added by link.
 */
import {useState} from 'react';
import {Hash, Plus} from 'lucide-react';
import {chatName, topicNumber, type Chat} from '../../lib/chats-model';
import {Badge, Button, Card, CardBody, CardHeader, Field, Input} from '../../ui/core';
import {Dialog} from '../../ui/overlay';
import {ActionError, chatHref, useAction} from './shared';

export function TopicsCard({group, topics}: {group: Chat; topics: Chat[]}) {
  const action = useAction();
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Topics"
        description="New topics show up once someone writes in them."
        action={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden /> Add an older topic
          </Button>
        }
      />
      <CardBody className="pt-3">
        {topics.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {topics.map(topic => (
              <li key={topic.space_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <Hash className="size-4 shrink-0 text-muted" aria-hidden />
                <a
                  href={chatHref(topic.space_id)}
                  className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                  dir="auto"
                >
                  {chatName(topic)}
                </a>
                {topic.closed && <Badge>Closed</Badge>}
                {topic.registered && <Badge tone="info">Added by you</Badge>}
                {!topic.observed_at && !topic.registered && <Badge>No messages yet</Badge>}
                {topic.registered && (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={action.busy === topic.space_id}
                    disabled={!!action.busy}
                    aria-label={'Remove ' + chatName(topic) + ' from the list'}
                    onClick={() =>
                      void action.run(
                        topic.space_id,
                        '/telegram/topics',
                        {action: 'remove', chat_id: group.space_id, topic_id: topicNumber(topic.space_id)},
                        {success: 'Topic removed from the list.', operation: false},
                      )
                    }
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No topics seen yet.</p>
        )}
        <ActionError text={action.error} />
      </CardBody>
      <AddTopic group={group} open={adding} onOpenChange={setAdding} />
    </Card>
  );
}

function AddTopic({group, open, onOpenChange}: {group: Chat; open: boolean; onOpenChange: (open: boolean) => void}) {
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const action = useAction();
  const submit = async () => {
    const ref = link.trim();
    const target = /^\d+$/.test(ref) ? {chat_id: group.space_id, topic_id: Number(ref)} : {link: ref};
    const result = await action.run(
      'add',
      '/telegram/topics',
      {action: 'add', name: name.trim(), ...target},
      {
        success: 'Topic added.',
        operation: false,
      },
    );
    if (result) {
      setLink('');
      setName('');
      onOpenChange(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) action.clear();
        onOpenChange(next);
      }}
      title="Add an older topic"
      description="In Telegram, open the topic and use Copy link. Adding a topic changes nobody’s access."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            busy={action.busy === 'add'}
            disabled={!link.trim() || !name.trim()}
            onClick={() => void submit()}
          >
            Add topic
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          if (link.trim() && name.trim()) void submit();
        }}
      >
        <Field label="Topic link or number" htmlFor="topic-link">
          <Input
            id="topic-link"
            value={link}
            placeholder="https://t.me/c/…/12"
            onChange={event => setLink(event.target.value)}
          />
        </Field>
        <Field label="Topic name" htmlFor="topic-name">
          <Input
            id="topic-name"
            value={name}
            dir="auto"
            maxLength={128}
            onChange={event => setName(event.target.value)}
          />
        </Field>
        <button type="submit" hidden />
      </form>
      <ActionError text={action.error} />
    </Dialog>
  );
}
