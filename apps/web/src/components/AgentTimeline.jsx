import clsx from 'clsx';
import { Bot, ChevronRight, CircleAlert, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAgentRun } from '../api/hooks.js';
import { formatDateTime } from '../lib/format.js';
import { AgentStateBadge } from './AgentActivity.jsx';
import { Badge } from './ui/Badge.jsx';
import { RelativeTime } from './ui/Misc.jsx';
import { Spinner, ErrorState } from './ui/States.jsx';

const RUN_STATE = { SUCCEEDED: 'completed', FAILED: 'failed', RUNNING: 'running', PENDING: 'scheduled' };
const OUTCOME = {
  EXECUTED: { tone: 'good', label: 'Executed' },
  VALIDATION_FAILED: { tone: 'warning', label: 'Invalid input, rejected' },
  PERMISSION_DENIED: { tone: 'critical', label: 'Permission denied' },
  POLICY_BLOCKED: { tone: 'warning', label: 'Blocked by policy' },
  ERROR: { tone: 'critical', label: 'Error' },
};

const TOOL_TEXT = {
  get_lead_details: 'Read the lead and conversation',
  get_business_pricing: 'Read services and published prices',
  search_business_knowledge: 'Searched the approved knowledge base',
  record_lead_analysis: 'Saved the requirements, budget, timeline and intent',
  update_lead_score: 'Saved the lead score',
  update_lead_status: 'Changed the lead status',
  send_customer_email: 'Prepared an email to the customer',
  notify_business_owner: 'Alerted the owner',
  request_owner_approval: 'Asked the owner to approve',
  run_lead_intelligence: 'Asked the Lead Intelligence Agent',
  run_conversation_agent: 'Asked the Conversation Agent',
  run_meeting_agent: 'Asked the Meeting Agent',
  record_next_action: 'Recorded the decision',
  check_calendar_availability: 'Checked calendar availability',
  book_appointment: 'Booked or proposed an appointment',
  schedule_followup: 'Scheduled a follow-up',
  cancel_followup: 'Cancelled a follow-up',
  record_follow_up_decision: 'Recorded the follow-up decision',
  get_sales_facts: 'Computed pipeline facts',
  record_insights: 'Saved insights',
  evaluate_policy: 'Evaluated autonomy and approval policy',
  extract_business_knowledge: 'Extracted business knowledge',
};

function Json({ value }) {
  return <pre className="max-h-56 overflow-auto rounded-md bg-surface-2 p-2 text-[11px] leading-snug text-ink-2">{JSON.stringify(value, null, 2)}</pre>;
}

function ToolCall({ call }) {
  const o = OUTCOME[call.outcome] ?? OUTCOME.ERROR;
  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="h-3.5 w-3.5 text-muted" aria-hidden />
        <span className="text-sm text-ink">{TOOL_TEXT[call.toolName] ?? call.toolName}</span>
        <code className="text-[11px] text-muted">{call.toolName}</code>
        <Badge tone={o.tone}>{o.label}</Badge>
        <span className="ml-auto text-xs text-muted tabular">{call.durationMs} ms</span>
      </div>
      {call.error && <p className="mt-1 text-xs text-ink-2">{call.error}</p>}
      <div className="mt-1 grid gap-1 sm:grid-cols-2">
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Input</summary>
          <Json value={call.input} />
        </details>
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Result</summary>
          <Json value={call.result} />
        </details>
      </div>
    </li>
  );
}

function RunBody({ run }) {
  return (
    <div className="space-y-3">
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="inline text-muted">Trigger: </dt>
          <dd className="inline text-ink">{run.triggerDetail ?? run.trigger?.toLowerCase()}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Model: </dt>
          <dd className="inline text-ink">{run.model ?? '–'}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Started: </dt>
          <dd className="inline text-ink">{formatDateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Duration: </dt>
          <dd className="inline text-ink">{run.latencyMs != null ? `${(run.latencyMs / 1000).toFixed(1)}s · ${run.iterations} model call${run.iterations === 1 ? '' : 's'}` : '–'}</dd>
        </div>
        {run.jobAttempt > 1 && (
          <div>
            <dt className="inline text-muted">Attempt: </dt>
            <dd className="inline text-ink">{run.jobAttempt} (retried)</dd>
          </div>
        )}
      </dl>
      {run.error && (
        <p className="flex items-start gap-1.5 rounded-md bg-critical-soft px-2.5 py-1.5 text-xs text-critical">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {run.errorCode}: {run.error}
        </p>
      )}
      {run.input && Object.keys(run.input).length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Input context</summary>
          <Json value={run.input} />
        </details>
      )}
      {run.toolCalls?.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Actions ({run.toolCalls.length} tool calls)</p>
          <ol className="space-y-1.5">
            {run.toolCalls.map((c) => (
              <ToolCall key={c.id} call={c} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function RunHeader({ run, showLead }) {
  const Icon = run.kind === 'POLICY_CHECK' ? ShieldCheck : Bot;
  return (
    <>
      <span className="mt-0.5 rounded-full bg-accent-soft p-1.5 text-accent-ink">
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{run.agentName}</span>
          <AgentStateBadge state={RUN_STATE[run.status] ?? 'idle'} />
          {showLead && run.lead && <span className="text-xs text-muted">· {run.lead.name}</span>}
        </span>
        {run.decision && (
          <span className="mt-0.5 block text-sm text-ink">
            {run.decision}
            {run.reason && <span className="text-ink-2"> · {run.reason}</span>}
          </span>
        )}
        <span className="mt-0.5 block text-xs text-muted">
          {run.triggerDetail ?? 'Triggered automatically'} · <RelativeTime date={run.startedAt ?? run.createdAt} />
        </span>
      </span>
    </>
  );
}

/** One workflow: the top-level run, expandable to its tool calls and sub-agent runs. */
function Workflow({ run, showLead, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const detail = useAgentRun(run.id, open);
  return (
    <li className="py-3">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-start gap-3 rounded-md text-left">
        <RunHeader run={run} showLead={showLead} />
        <ChevronRight className={clsx('mt-1 h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {!open && run.childRuns?.length > 0 && (
        <p className="mt-1 ml-10 text-xs text-muted">
          Coordinated: {run.childRuns.map((c) => c.agentName).join(' → ')}
        </p>
      )}
      {open && (
        <div className="mt-3 ml-10 space-y-4">
          {detail.isPending ? (
            <Spinner className="h-4 w-4 text-muted" />
          ) : detail.isError ? (
            <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
          ) : (
            <>
              <RunBody run={detail.data} />
              {detail.data.childRuns?.map((child, i) => (
                <div key={child.id} className="border-l-2 border-line pl-4">
                  <p className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Step {i + 1}</p>
                  <div className="mb-2 flex items-start gap-3">
                    <RunHeader run={child} />
                  </div>
                  <RunBody run={child} />
                </div>
              ))}
              {showLead && run.lead && (
                <Link to={`/leads/${run.lead.id}`} className="inline-block text-sm font-medium text-accent hover:underline">
                  Open {run.lead.name}
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function AgentTimeline({ runs, showLead = false }) {
  return (
    <ol className="divide-y divide-line">
      {runs.map((run) => (
        <Workflow key={run.id} run={run} showLead={showLead} defaultOpen={false} />
      ))}
    </ol>
  );
}
