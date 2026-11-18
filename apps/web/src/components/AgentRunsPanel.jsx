import { Bot } from 'lucide-react';
import { useAgentRuns } from '../api/hooks.js';
import { AgentTimeline } from './AgentTimeline.jsx';
import { EmptyState, QueryState } from './ui/States.jsx';

/** Agent decision timeline for one lead. */
export function AgentRunsPanel({ leadId }) {
  const query = useAgentRuns(leadId);
  return (
    <QueryState query={query}>
      {(page) =>
        page.data.length ? (
          <AgentTimeline runs={page.data} />
        ) : (
          <EmptyState icon={Bot} title="No agent activity yet" description="Run the AI on this lead to analyse it and draft a reply." />
        )
      }
    </QueryState>
  );
}
