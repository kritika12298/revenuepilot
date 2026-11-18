import clsx from 'clsx';
import { AlertTriangle, Bot, Check, CheckCheck, Inbox, PenLine, Send, X } from 'lucide-react';
import { useState } from 'react';
import { useApprove, useLogInbound, useReject, useSendReply } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { formatDateTime } from '../lib/format.js';
import { Badge } from './ui/Badge.jsx';
import { Button } from './ui/Button.jsx';
import { Field, Textarea } from './ui/Field.jsx';
import { EmptyState } from './ui/States.jsx';
import { useToast } from './ui/Toast.jsx';

const AUTHOR = { LEAD: 'Lead', AI: 'AI assistant', OWNER: 'You', SYSTEM: 'Automatic email' };

function MessageMeta({ m, timeZone }) {
  const when = formatDateTime(m.sentAt ?? m.createdAt, timeZone);
  switch (m.status) {
    case 'SENT':
      return (
        <span className="inline-flex items-center gap-1">
          <CheckCheck className="h-3.5 w-3.5" aria-hidden /> Sent {when}
        </span>
      );
    case 'APPROVED':
      return <span>Approved · queued for sending</span>;
    case 'FAILED':
      return (
        <span className="inline-flex items-center gap-1 text-critical">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Not delivered
        </span>
      );
    case 'REJECTED':
    case 'CANCELLED':
      return <span>{m.status === 'REJECTED' ? 'Rejected' : 'Cancelled'} · never sent</span>;
    case 'PENDING_APPROVAL':
      return <span>Drafted {when}</span>;
    default:
      return <span>{when}</span>;
  }
}

/** Approve / edit / reject an AI draft, right where it appears in the thread. */
function DraftActions({ approvalId, message }) {
  const { isOwner } = useAuth();
  const toast = useToast();
  const approve = useApprove();
  const reject = useReject();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(message.body);

  if (!isOwner) return <p className="mt-3 text-xs text-muted">Waiting for the owner to approve.</p>;

  const onApprove = () =>
    approve.mutate(
      { id: approvalId, ...(editing && body !== message.body ? { body } : {}) },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success('Approved', 'The message is queued and will be sent within its window.');
        },
        onError: (e) => toast.error('Could not approve', e.message),
      },
    );
  const onReject = () =>
    reject.mutate({ id: approvalId }, { onSuccess: () => toast.success('Draft rejected'), onError: (e) => toast.error('Could not reject', e.message) });

  return (
    <div className="mt-3 space-y-3">
      {editing && (
        <Field label="Edit before approving">{(p) => <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} rows={8} />}</Field>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={Check} loading={approve.isPending} onClick={onApprove}>
          {editing ? 'Save & approve' : 'Approve & send'}
        </Button>
        {!editing && (
          <Button size="sm" icon={PenLine} onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        <Button variant="ghost" size="sm" icon={X} loading={reject.isPending} onClick={onReject}>
          Reject
        </Button>
      </div>
    </div>
  );
}

export function ConversationThread({ lead, timeZone }) {
  const messages = (lead.conversations ?? []).flatMap((c) => c.messages).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const approvalByMessage = Object.fromEntries((lead.approvals ?? []).filter((a) => a.messageId).map((a) => [a.messageId, a.id]));

  if (!messages.length) {
    return <EmptyState icon={Inbox} title="No messages yet" description="When this lead writes in, or you reply, the conversation appears here." />;
  }

  return (
    <ol className="space-y-4">
      {messages.map((m) => {
        const inbound = m.direction === 'INBOUND';
        const pending = m.status === 'PENDING_APPROVAL';
        const muted = m.status === 'REJECTED' || m.status === 'CANCELLED';
        return (
          <li key={m.id} className={clsx('flex', inbound ? 'justify-start' : 'justify-end')}>
            <article
              className={clsx(
                'max-w-[85%] rounded-2xl border px-4 py-3 shadow-sm',
                inbound ? 'rounded-tl-sm border-line bg-surface' : 'rounded-tr-sm border-transparent bg-accent-soft',
                pending && 'border-dashed border-warning-mark bg-surface',
                muted && 'opacity-60',
              )}
              aria-label={`${AUTHOR[m.author]} message`}
            >
              <header className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-ink">{inbound ? lead.name : AUTHOR[m.author]}</span>
                {m.author === 'AI' && (
                  <Badge tone="accent" icon={Bot}>
                    AI generated
                  </Badge>
                )}
                {pending && (
                  <Badge tone="warning" icon={AlertTriangle}>
                    Needs approval
                  </Badge>
                )}
              </header>
              {m.subject && <p className="mb-1 text-sm font-medium text-ink">{m.subject}</p>}
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{m.body}</p>
              <p className="mt-2 text-xs text-muted">
                <MessageMeta m={m} timeZone={timeZone} />
              </p>
              {pending && approvalByMessage[m.id] && <DraftActions approvalId={approvalByMessage[m.id]} message={m} />}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

/** Reply box: send an email as the owner, or log a reply received elsewhere. */
export function Composer({ lead }) {
  const toast = useToast();
  const [mode, setMode] = useState('reply');
  const [body, setBody] = useState('');
  const send = useSendReply(lead.id);
  const log = useLogInbound(lead.id);
  const busy = send.isPending || log.isPending;
  const blocked = lead.status === 'OPTED_OUT' || !lead.email;

  const submit = (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    const mutation = mode === 'reply' ? send : log;
    mutation.mutate(
      { body },
      {
        onSuccess: () => {
          setBody('');
          toast.success(mode === 'reply' ? 'Reply queued' : 'Reply logged', mode === 'reply' ? 'It will be emailed shortly.' : 'Pending follow-ups were stopped.');
        },
        onError: (err) => toast.error('Could not save', err.message),
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-2 border-t border-line pt-4">
      <div className="flex gap-1 text-sm" role="tablist" aria-label="Message type">
        {[
          ['reply', 'Email reply'],
          ['inbound', 'Log their reply'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={clsx('rounded-md px-2.5 py-1 font-medium', mode === value ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
      <Textarea
        aria-label={mode === 'reply' ? 'Reply to the lead' : 'What the lead said'}
        placeholder={
          mode === 'reply'
            ? blocked
              ? 'This lead cannot be emailed (opted out or no email address).'
              : `Write to ${lead.name.split(' ')[0]}…`
            : 'Paste a reply you received by phone or in your own inbox…'
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={mode === 'reply' && blocked}
        rows={3}
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
          {mode === 'reply' ? 'Consent and opt-out are re-checked before sending.' : 'Logging a reply stops any pending follow-ups.'}
        </p>
        <Button type="submit" variant="primary" size="sm" icon={mode === 'reply' ? Send : Inbox} loading={busy} disabled={!body.trim() || (mode === 'reply' && blocked)}>
          {mode === 'reply' ? 'Send' : 'Log reply'}
        </Button>
      </div>
    </form>
  );
}
