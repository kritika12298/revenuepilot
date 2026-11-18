import { Lock, ShieldCheck } from 'lucide-react';
import { useAllAgentRuns, useAutonomy, useUpdateAutonomy } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AgentTimeline } from '../components/AgentTimeline.jsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { Field, Input, Switch } from '../components/ui/Field.jsx';
import { PageHeader } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows, QueryState } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';

const SETTINGS = [
  ['autoScoreLeads', 'Score new leads automatically', 'New website enquiries and replies are analysed and scored by the Lead Intelligence Agent as they arrive.'],
  ['autoGenerateResponses', 'Write replies automatically', 'The Conversation Agent drafts a reply for every new enquiry. When off, the AI flags the lead for you instead.'],
  ['autoSendResponses', 'Send replies without my approval', 'Permitted replies (published prices only, no commitments, lead consent checked) are emailed immediately. When off, every reply waits for you.'],
  ['autoScheduleFollowUps', 'Plan follow-ups automatically', 'The Follow-up Agent decides whether and when to follow up after each email, within your cadence and working hours.'],
  ['autoApproveFollowUps', 'Send follow-ups without my approval', 'AI-written follow-ups go out at their scheduled time without review.'],
  ['autoBookAppointments', 'Book appointments without my approval', 'The Meeting Agent confirms bookings in free slots during working hours. When off, it proposes a time for you to confirm.'],
];
const LOCKED = [
  ['discounts', 'Discounts'],
  ['quotations', 'Quotations'],
  ['contracts', 'Contracts'],
  ['customPricing', 'Custom pricing and other financial commitments'],
];
const GUARDRAILS = [
  'Email consent, opt-outs and unsubscribes are checked immediately before every send.',
  'Only prices from your price list can be quoted; discounts, guarantees and invented times are blocked.',
  'Follow-ups are sent only during your working hours and stop when a lead replies, opts out or is closed.',
  'Every decision is recorded in AI activity with its reasons.',
];

export function AutonomyPage() {
  const { isOwner } = useAuth();
  const toast = useToast();
  const query = useAutonomy();
  const update = useUpdateAutonomy();
  const decisions = useAllAgentRuns({ agent: 'policy', pageSize: 8 });
  const save = (patch, label) =>
    update.mutate(patch, { onSuccess: () => toast.success('Saved', label), onError: (e) => toast.error('Could not save', e.message) });

  return (
    <>
      <PageHeader title="Autonomy control center" description="Decide what RevenuePilot's agents may do on their own. These rules are enforced by the server, not just this screen." />
      <QueryState query={query} loading={<Card><LoadingRows rows={5} /></Card>}>
        {({ policy, lockedApprovals }) => (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <div className="space-y-5 xl:col-span-2">
              <Card>
                <CardHeader title="Agent permissions" description={isOwner ? 'Changes apply immediately and are audited.' : 'Only the owner can change these.'} />
                <CardBody className="divide-y divide-line">
                  {SETTINGS.map(([key, label, description]) => (
                    <div key={key} className="py-3.5 first:pt-0 last:pb-0">
                      <Switch label={label} description={description} checked={policy[key]} disabled={!isOwner || update.isPending} onChange={(v) => save({ [key]: v }, `${label}: ${v ? 'on' : 'off'}`)} />
                    </div>
                  ))}
                  <div className="py-3.5 last:pb-0">
                    <Field label="Maximum automatic emails per day" hint="Above this, emails wait for your approval. Protects your sender reputation.">
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min="0"
                          max="500"
                          defaultValue={policy.maxAutoEmailsPerDay}
                          disabled={!isOwner}
                          onBlur={(e) => Number(e.target.value) !== policy.maxAutoEmailsPerDay && save({ maxAutoEmailsPerDay: Number(e.target.value) }, `Daily limit: ${e.target.value}`)}
                          className="w-32"
                        />
                      )}
                    </Field>
                  </div>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Recent policy decisions" description="What the Policy & Approval Agent allowed, held for approval or blocked" />
                {decisions.isPending ? (
                  <LoadingRows rows={3} />
                ) : decisions.isError ? (
                  <ErrorState error={decisions.error} onRetry={() => decisions.refetch()} />
                ) : decisions.data.data.length === 0 ? (
                  <EmptyState icon={ShieldCheck} title="No decisions yet" description="Policy checks appear here as agents act." />
                ) : (
                  <div className="px-5"><AgentTimeline runs={decisions.data.data} showLead /></div>
                )}
              </Card>
            </div>
            <div className="space-y-5">
              <Card>
                <CardHeader title="Always requires your approval" description="Financial commitments cannot be automated" />
                <CardBody>
                  <ul className="space-y-2.5">
                    {LOCKED.map(([key, label]) => (
                      <li key={key} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-ink">{label}</span>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink-2">
                          <Lock className="h-3 w-3" aria-hidden /> {lockedApprovals[key] ? 'Approval required' : 'Automatic'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Always enforced" />
                <CardBody>
                  <ul className="space-y-2 text-sm text-ink-2">
                    {GUARDRAILS.map((g) => (
                      <li key={g} className="flex gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden />{g}</li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            </div>
          </div>
        )}
      </QueryState>
    </>
  );
}
