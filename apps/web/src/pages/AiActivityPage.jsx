import { Bot } from 'lucide-react';
import { useState } from 'react';
import { useAllAgentRuns } from '../api/hooks.js';
import { AgentTimeline } from '../components/AgentTimeline.jsx';
import { Card } from '../components/ui/Card.jsx';
import { Select } from '../components/ui/Field.jsx';
import { PageHeader, Pagination } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/States.jsx';

const AGENTS = [
  ['', 'All agents'],
  ['orchestrator', 'Sales Orchestrator'],
  ['lead_intelligence', 'Lead Intelligence'],
  ['conversation', 'Conversation'],
  ['follow_up', 'Follow-up'],
  ['meeting', 'Meeting'],
  ['policy', 'Policy & Approval'],
  ['sales_intelligence', 'Sales Intelligence'],
  ['website', 'Website Intelligence'],
];

/**
 * Agent decision timeline: every AI execution, what triggered it, what it
 * decided and why, and each tool call with its input and result. Explanations
 * are the recorded decisions and tool outcomes, not hidden model reasoning.
 */
export function AiActivityPage() {
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const query = useAllAgentRuns({ agent: agent || undefined, status: status || undefined, page, pageSize: 20 });

  return (
    <>
      <PageHeader title="AI activity" description="What RevenuePilot's agents did, why, and every action they took. Updates live." />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Select aria-label="Agent" value={agent} onChange={(e) => { setAgent(e.target.value); setPage(1); }} className="w-auto">
            {AGENTS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-auto">
            <option value="">Any status</option>
            <option value="SUCCEEDED">Completed</option>
            <option value="FAILED">Failed</option>
            <option value="RUNNING">Running</option>
          </Select>
        </div>
        {query.isPending ? (
          <LoadingRows rows={6} label="Loading AI activity" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load AI activity" />
        ) : query.data.data.length === 0 ? (
          <EmptyState icon={Bot} title="No agent executions yet" description="Agent runs appear here as leads arrive or when you run the AI." />
        ) : (
          <div className={query.isPlaceholderData ? 'px-5 opacity-60' : 'px-5'}>
            <AgentTimeline runs={query.data.data} showLead />
            <Pagination meta={query.data.meta} onPage={setPage} />
          </div>
        )}
      </Card>
    </>
  );
}
