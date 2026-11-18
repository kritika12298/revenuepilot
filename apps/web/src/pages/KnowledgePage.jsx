import { AlertTriangle, BadgeCheck, Check, Globe, Link2, Loader2, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useConnectWebsite, useCreateKnowledge, useDeleteKnowledge, useKnowledge, usePromoteKnowledge, useUpdateKnowledge, useWebsite } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Input, Select, Textarea } from '../components/ui/Field.jsx';
import { PageHeader, RelativeTime, Segmented } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { fieldErrors } from '../lib/api.js';

const TYPE_LABEL = { SERVICE: 'Services', FAQ: 'FAQs', BUSINESS_INFO: 'Business information', CONTACT: 'Contact details', LOCATION: 'Service area', POLICY: 'Policies' };
const STATUS_TEXT = { QUEUED: 'Queued', FETCHING: 'Reading pages', ANALYZING: 'Extracting knowledge', COMPLETED: 'Up to date', FAILED: 'Failed' };
const RUNNING = ['QUEUED', 'FETCHING', 'ANALYZING'];

function WebsiteCard() {
  const { isOwner } = useAuth();
  const toast = useToast();
  const query = useWebsite();
  const connect = useConnectWebsite();
  const [url, setUrl] = useState('');
  const w = query.data?.website;
  const errors = fieldErrors(connect.error);

  const submit = (e) => {
    e.preventDefault();
    connect.mutate(url || w?.url, {
      onSuccess: () => toast.success('Website analysis started', 'This takes a few seconds; results appear below for your review.'),
      onError: (err) => toast.error('Could not analyse the website', err.message),
    });
  };

  return (
    <Card>
      <CardHeader title="Website" description="RevenuePilot reads your public website and drafts a knowledge base for you to review." />
      <CardBody className="space-y-4">
        {query.isPending ? (
          <LoadingRows rows={2} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <>
            {isOwner && (
              <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
                <Field label="Website address" error={errors.url} className="min-w-64 flex-1" hint={query.data.demoHosts?.length ? `Demo: try https://${query.data.demoHosts[0]}/ (bundled demo site)` : undefined}>
                  {(p) => <Input {...p} type="url" placeholder={w?.url ?? 'https://www.example.com'} value={url} onChange={(e) => setUrl(e.target.value)} />}
                </Field>
                <Button type="submit" variant="primary" icon={Globe} loading={connect.isPending} disabled={(!url && !w) || RUNNING.includes(w?.status)}>
                  {w ? 'Re-analyse' : 'Analyse website'}
                </Button>
              </form>
            )}
            {w ? (
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-muted">Website</dt>
                  <dd className="flex items-center gap-1 truncate text-ink"><Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden />{w.url}</dd>
                </div>
                <div>
                  <dt className="text-muted">Status</dt>
                  <dd>
                    <Badge tone={w.status === 'COMPLETED' ? 'good' : w.status === 'FAILED' ? 'critical' : 'accent'} icon={RUNNING.includes(w.status) ? Loader2 : w.status === 'FAILED' ? AlertTriangle : BadgeCheck}>
                      {STATUS_TEXT[w.status]}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Last sync</dt>
                  <dd className="text-ink">{w.lastSyncAt ? <RelativeTime date={w.lastSyncAt} /> : 'Never'}</dd>
                </div>
                <div>
                  <dt className="text-muted">Pages read</dt>
                  <dd className="text-ink">{w.pagesFetched}</dd>
                </div>
              </dl>
            ) : (
              <EmptyState icon={Globe} title="No website connected" description="Connect your website so the AI can answer questions using what your site already says." className="py-6" />
            )}
            {w?.lastError && <p className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{w.lastError}</p>}
            {w?.summary && <p className="text-sm text-ink">{w.summary}</p>}
            {w?.missingInfo?.length > 0 && (
              <div>
                <p className="mb-1.5 text-sm font-medium text-ink">Missing from your website</p>
                <div className="flex flex-wrap gap-1.5">{w.missingInfo.map((m) => <Badge key={m} tone="warning" icon={AlertTriangle}>{m}</Badge>)}</div>
              </div>
            )}
            {Array.isArray(w?.pages) && w.pages.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted hover:text-ink">Pages</summary>
                <ul className="mt-2 space-y-1">
                  {w.pages.map((p) => <li key={p.url} className="truncate text-ink-2">{p.title || p.url}{p.error && <span className="text-critical"> · {p.error}</span>}</li>)}
                </ul>
              </details>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function PromoteDialog({ item, onClose }) {
  const toast = useToast();
  const promote = usePromoteKnowledge();
  const [v, setV] = useState({ priceType: 'FIXED', min: '', max: '' });
  const errors = fieldErrors(promote.error);
  const toCents = (d) => (d === '' ? null : Math.round(Number(d) * 100));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add "${item.title}" to your price list`}
      description="The AI only quotes prices from your price list. Enter the price yourself; the website text is shown for reference."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={promote.isPending}
            onClick={() =>
              promote.mutate(
                { id: item.id, priceType: v.priceType, priceMinCents: v.priceType === 'QUOTE_ONLY' ? null : toCents(v.min), priceMaxCents: v.priceType === 'RANGE' ? toCents(v.max) : null },
                { onSuccess: () => { toast.success('Added to your price list'); onClose(); } },
              )
            }
          >
            Add service
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-lg bg-surface-2 p-3 text-sm text-ink-2">Website says: {item.priceText ?? 'no price stated'}</p>
        <Field label="Pricing">
          {(p) => (
            <Select {...p} value={v.priceType} onChange={(e) => setV((s) => ({ ...s, priceType: e.target.value }))}>
              <option value="FIXED">Fixed price</option>
              <option value="RANGE">Price range</option>
              <option value="QUOTE_ONLY">Quote only</option>
            </Select>
          )}
        </Field>
        {v.priceType !== 'QUOTE_ONLY' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={v.priceType === 'RANGE' ? 'From ($)' : 'Price ($)'} error={errors.priceMinCents}>{(p) => <Input {...p} type="number" min="0" value={v.min} onChange={(e) => setV((s) => ({ ...s, min: e.target.value }))} />}</Field>
            {v.priceType === 'RANGE' && <Field label="To ($)" error={errors.priceMaxCents}>{(p) => <Input {...p} type="number" min="0" value={v.max} onChange={(e) => setV((s) => ({ ...s, max: e.target.value }))} />}</Field>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function EditDialog({ item, onClose }) {
  const toast = useToast();
  const create = useCreateKnowledge();
  const update = useUpdateKnowledge();
  const [v, setV] = useState({ type: item?.type ?? 'FAQ', title: item?.title ?? '', content: item?.content ?? '' });
  const mutation = item ? update : create;
  const errors = fieldErrors(mutation.error);
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? 'Edit and approve' : 'Add knowledge'}
      description="Saved items are owner-confirmed and available to the Conversation Agent."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            onClick={() =>
              (item
                ? update.mutate({ id: item.id, title: v.title, content: v.content, status: 'APPROVED' }, { onSuccess: () => { toast.success('Saved and approved'); onClose(); } })
                : create.mutate(v, { onSuccess: () => { toast.success('Knowledge added'); onClose(); } }))
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!item && (
          <Field label="Type">
            {(p) => (
              <Select {...p} value={v.type} onChange={(e) => setV((s) => ({ ...s, type: e.target.value }))}>
                {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label={v.type === 'FAQ' ? 'Question' : 'Title'} error={errors.title}>{(p) => <Input {...p} value={v.title} onChange={(e) => setV((s) => ({ ...s, title: e.target.value }))} />}</Field>
        <Field label={v.type === 'FAQ' ? 'Answer' : 'Details'} error={errors.content}>{(p) => <Textarea {...p} rows={4} value={v.content} onChange={(e) => setV((s) => ({ ...s, content: e.target.value }))} />}</Field>
      </div>
    </Dialog>
  );
}

function KnowledgeItem({ item, onEdit, onPromote }) {
  const { isOwner } = useAuth();
  const toast = useToast();
  const update = useUpdateKnowledge();
  const remove = useDeleteKnowledge();
  const confirmed = item.status === 'APPROVED';
  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{item.title}</span>
        {item.status === 'PENDING_REVIEW' && <Badge tone="warning" icon={AlertTriangle}>Inferred from website: review</Badge>}
        {confirmed && <Badge tone="good" icon={BadgeCheck}>{item.source === 'OWNER' ? 'Added by owner' : 'Owner-confirmed'}</Badge>}
        {item.status === 'REJECTED' && <Badge icon={X}>Rejected</Badge>}
      </div>
      <p className="mt-1 text-sm text-ink-2">{item.content}</p>
      {item.priceText && <p className="mt-1 text-sm text-ink"><span className="text-muted">Price on website:</span> {item.priceText}</p>}
      {item.evidence && item.source === 'WEBSITE' && (
        <p className="mt-1 text-xs text-muted">
          Evidence: &ldquo;{item.evidence}&rdquo;{item.sourceUrl && <> · <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener" className="hover:underline">{new URL(item.sourceUrl).pathname}</a></>}
        </p>
      )}
      {isOwner && (
        <div className="mt-2 flex flex-wrap gap-1">
          {!confirmed && <Button size="sm" variant="primary" icon={Check} loading={update.isPending} onClick={() => update.mutate({ id: item.id, status: 'APPROVED' }, { onSuccess: () => toast.success('Approved') })}>Approve</Button>}
          <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit}>Edit</Button>
          {item.type === 'SERVICE' && <Button size="sm" variant="ghost" icon={Tag} onClick={onPromote}>Add to price list</Button>}
          {item.status !== 'REJECTED' && item.source === 'WEBSITE' && <Button size="sm" variant="ghost" icon={X} onClick={() => update.mutate({ id: item.id, status: 'REJECTED' })}>Reject</Button>}
          {item.source === 'OWNER' && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove.mutate(item.id)} aria-label={`Delete ${item.title}`}>Delete</Button>}
        </div>
      )}
    </li>
  );
}

export function KnowledgePage() {
  const { isOwner } = useAuth();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [promoting, setPromoting] = useState(null);
  const website = useWebsite();
  const query = useKnowledge(filter ? { status: filter } : {});
  const counts = website.data?.counts ?? {};
  const grouped = Object.keys(TYPE_LABEL)
    .map((type) => [type, (query.data?.data ?? []).filter((i) => i.type === type)])
    .filter(([, items]) => items.length);

  return (
    <>
      <PageHeader
        title="Website & knowledge"
        description="What the AI knows about your business. Only owner-confirmed items are used in customer conversations."
        actions={isOwner && <Button icon={Plus} onClick={() => setEditing('new')}>Add knowledge</Button>}
      />
      <div className="space-y-5">
        <WebsiteCard />
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
            <Segmented
              label="Knowledge status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: '', label: 'All' },
                { value: 'PENDING_REVIEW', label: 'To review', count: counts.PENDING_REVIEW ?? 0 },
                { value: 'APPROVED', label: 'Confirmed', count: counts.APPROVED ?? 0 },
                { value: 'REJECTED', label: 'Rejected', count: counts.REJECTED ?? 0 },
              ]}
            />
          </div>
          {query.isPending ? (
            <LoadingRows rows={4} label="Loading knowledge" />
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => query.refetch()} />
          ) : grouped.length === 0 ? (
            <EmptyState icon={BadgeCheck} title="Nothing here yet" description="Analyse your website or add knowledge yourself." />
          ) : (
            grouped.map(([type, items]) => (
              <section key={type} className="border-b border-line last:border-0">
                <h2 className="bg-surface-2/60 px-5 py-2 text-xs font-semibold tracking-wide text-ink-2 uppercase">{TYPE_LABEL[type]}</h2>
                <ul className="divide-y divide-line">
                  {items.map((item) => <KnowledgeItem key={item.id} item={item} onEdit={() => setEditing(item)} onPromote={() => setPromoting(item)} />)}
                </ul>
              </section>
            ))
          )}
        </Card>
      </div>
      {editing && <EditDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {promoting && <PromoteDialog item={promoting} onClose={() => setPromoting(null)} />}
    </>
  );
}
