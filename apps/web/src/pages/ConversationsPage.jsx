import clsx from 'clsx';
import { ArrowLeft, Bot, ExternalLink, MessagesSquare, Search, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useConversations, useLead, useRunAgent } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AgentRunsPanel } from '../components/AgentRunsPanel.jsx';
import { Composer, ConversationThread } from '../components/ConversationThread.jsx';
import { ScoreMeter } from '../components/ScoreMeter.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card } from '../components/ui/Card.jsx';
import { Input } from '../components/ui/Field.jsx';
import { Avatar, PageHeader, Pagination, RelativeTime, Segmented } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { NEXT_ACTION_LABELS } from '../lib/constants.js';

function ConversationList({ selectedId, onSelect }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const query = useConversations({ q: q || undefined, needsReply: filter === 'reply' ? 'true' : undefined, page, pageSize: 25 });

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted" aria-hidden />
          <Input aria-label="Search conversations" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Segmented
          label="Conversation filter"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'reply', label: 'Awaiting reply' },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {query.isPending ? (
          <LoadingRows rows={6} label="Loading conversations" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.data.data.length === 0 ? (
          <EmptyState icon={MessagesSquare} title={q || filter === 'reply' ? 'Nothing matches' : 'No conversations yet'} description={filter === 'reply' ? 'Every lead who wrote last has had a reply.' : undefined} />
        ) : (
          <ul className={clsx('divide-y divide-line', query.isPlaceholderData && 'opacity-60')}>
            {query.data.data.map((c) => (
              <li key={c.lead.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.lead.id)}
                  aria-current={selectedId === c.lead.id ? 'true' : undefined}
                  className={clsx('flex w-full gap-3 px-4 py-3 text-left hover:bg-surface-2', selectedId === c.lead.id && 'bg-accent-soft/60')}
                >
                  <Avatar name={c.lead.name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink">{c.lead.name}</span>
                      <RelativeTime date={c.lastActivityAt} className="shrink-0 text-xs text-muted" />
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted">
                      {c.lastMessage?.direction === 'OUTBOUND' && (c.lastMessage.author === 'AI' ? 'AI: ' : 'You: ')}
                      {c.lastMessage?.body}
                    </span>
                    {c.pendingDrafts > 0 && (
                      <Badge tone="warning" className="mt-1.5">
                        {c.pendingDrafts} draft{c.pendingDrafts > 1 ? 's' : ''} to approve
                      </Badge>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {query.data && <Pagination meta={query.data.meta} onPage={setPage} />}
    </div>
  );
}

function ConversationDetail({ leadId, onBack }) {
  const { business } = useAuth();
  const toast = useToast();
  const query = useLead(leadId);
  const runAgent = useRunAgent(leadId);
  const [tab, setTab] = useState('messages');

  if (query.isPending) return <LoadingRows rows={5} label="Loading conversation" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const lead = query.data;
  const closed = ['WON', 'LOST', 'OPTED_OUT'].includes(lead.status);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <button type="button" onClick={onBack} className="rounded-md p-1 text-muted hover:text-ink lg:hidden" aria-label="Back to conversations">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Avatar name={lead.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-ink">{lead.name}</p>
          <div className="mt-0.5 flex items-center gap-2">
            <StatusBadge status={lead.status} />
            <ScoreMeter score={lead.score} />
          </div>
        </div>
        <Button
          size="sm"
          variant="primary"
          icon={Sparkles}
          loading={runAgent.isPending}
          disabled={closed}
          onClick={() =>
            runAgent.mutate(
              { agent: 'orchestrator' },
              {
                onSuccess: (run) => toast.success('AI finished', NEXT_ACTION_LABELS[run.output?.nextAction]),
                onError: (e) => toast.error('AI run failed', e.message),
              },
            )
          }
        >
          {runAgent.isPending ? 'Working…' : 'Run AI'}
        </Button>
        <Link to={`/leads/${lead.id}`} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Open lead">
          <ExternalLink className="h-4 w-4" />
        </Link>
      </header>
      <div className="border-b border-line px-5 py-2">
        <Segmented
          label="Conversation sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'messages', label: 'Messages' },
            { value: 'agents', label: 'Agent activity' },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {tab === 'messages' ? (
          <div className="space-y-4">
            <ConversationThread lead={lead} timeZone={business?.timezone} />
            <Composer lead={lead} />
          </div>
        ) : (
          <AgentRunsPanel leadId={lead.id} />
        )}
      </div>
    </div>
  );
}

export function ConversationsPage() {
  const { leadId } = useParams();
  const navigate = useNavigate();
  const select = (id) => navigate(`/conversations/${id}`);

  return (
    <>
      <PageHeader title="Conversations" description="Customer messages, AI drafts awaiting approval, and what each agent did." />
      <Card className="grid h-[calc(100vh-11rem)] min-h-[32rem] grid-cols-1 overflow-hidden lg:grid-cols-[22rem_1fr]">
        <div className={clsx('min-h-0 border-line lg:border-r', leadId && 'hidden lg:block')}>
          <ConversationList selectedId={leadId} onSelect={select} />
        </div>
        <div className={clsx('min-h-0', !leadId && 'hidden lg:block')}>
          {leadId ? (
            <ConversationDetail key={leadId} leadId={leadId} onBack={() => navigate('/conversations')} />
          ) : (
            <EmptyState icon={Bot} title="Select a conversation" description="Pick a lead to read the thread, approve AI drafts and see agent activity." className="h-full" />
          )}
        </div>
      </Card>
    </>
  );
}
