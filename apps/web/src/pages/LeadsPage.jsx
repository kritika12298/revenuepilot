import { Plus, Search, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useCreateLead, useLeads } from '../api/hooks.js';
import { ScoreMeter } from '../components/ScoreMeter.jsx';
import { StatusBadge } from '../components/StatusBadge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Input, Select, Textarea } from '../components/ui/Field.jsx';
import { Avatar, PageHeader, Pagination, RelativeTime } from '../components/ui/Misc.jsx';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { fieldErrors } from '../lib/api.js';
import { LEAD_STATUSES, SOURCE_LABELS, STATUS_LABELS } from '../lib/constants.js';

const SORTS = {
  newest: { sort: 'createdAt', order: 'desc', label: 'Newest first' },
  score: { sort: 'score', order: 'desc', label: 'Highest score' },
  updated: { sort: 'updatedAt', order: 'desc', label: 'Recently updated' },
  name: { sort: 'name', order: 'asc', label: 'Name (A–Z)' },
};

function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Filters live in the URL so views can be bookmarked and shared. */
function useLeadFilters() {
  const [params, setParams] = useSearchParams();
  const get = (k, d = '') => params.get(k) ?? d;
  const set = (patch) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
        if (!('page' in patch)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  return {
    q: get('q'),
    status: get('status'),
    source: get('source'),
    minScore: get('minScore'),
    sortKey: get('sort', 'newest'),
    page: Number(get('page', '1')),
    set,
  };
}

function NewLeadDialog({ onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateLead();
  const [v, setV] = useState({ name: '', email: '', phone: '', company: '', message: '', consent: false });
  const bind = (k) => ({ value: v[k], onChange: (e) => setV((s) => ({ ...s, [k]: e.target.value })) });
  const errors = fieldErrors(create.error);

  const submit = (e) => {
    e.preventDefault();
    create.mutate(
      {
        name: v.name,
        ...(v.email && { email: v.email }),
        ...(v.phone && { phone: v.phone }),
        ...(v.company && { company: v.company }),
        source: 'MANUAL',
        ...(v.message && { enquiry: { channel: 'PHONE', message: v.message } }),
        ...(v.consent && { consent: { email: true, source: 'dashboard: confirmed by owner' } }),
      },
      {
        onSuccess: (lead) => {
          toast.success('Lead added', lead.name);
          onClose();
          navigate(`/leads/${lead.id}`);
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a lead"
      description="For enquiries that came in by phone, in person or elsewhere."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-lead" loading={create.isPending}>
            Add lead
          </Button>
        </>
      }
    >
      <form id="new-lead" onSubmit={submit} className="space-y-3">
        <Field label="Name" error={errors.name}>{(p) => <Input {...p} required {...bind('name')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email" error={errors.email}>{(p) => <Input {...p} type="email" {...bind('email')} />}</Field>
          <Field label="Phone" error={errors.phone}>{(p) => <Input {...p} type="tel" {...bind('phone')} />}</Field>
        </div>
        <Field label="Company" error={errors.company}>{(p) => <Input {...p} {...bind('company')} />}</Field>
        <Field label="What do they need?" hint="The AI uses this to analyse the lead." error={errors['enquiry.message']}>
          {(p) => <Textarea {...p} rows={3} {...bind('message')} />}
        </Field>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            checked={v.consent}
            onChange={(e) => setV((s) => ({ ...s, consent: e.target.checked }))}
          />
          <span>
            They agreed to receive emails from us
            <span className="block text-xs text-muted">Required for automated follow-ups.</span>
          </span>
        </label>
        {create.isError && !Object.keys(errors).length && <p className="text-sm text-critical">{create.error.message}</p>}
        {errors.email && errors.email.includes('phone') && <p className="text-sm text-critical">{errors.email}</p>}
      </form>
    </Dialog>
  );
}

export function LeadsPage() {
  const navigate = useNavigate();
  const f = useLeadFilters();
  const [search, setSearch] = useState(f.q);
  const q = useDebounced(search);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (q !== f.q) f.set({ q });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const sort = SORTS[f.sortKey] ?? SORTS.newest;
  const query = useLeads({
    q: f.q || undefined,
    status: f.status || undefined,
    source: f.source || undefined,
    minScore: f.minScore || undefined,
    sort: sort.sort,
    order: sort.order,
    page: f.page,
    pageSize: 20,
  });
  const filtered = Boolean(f.q || f.status || f.source || f.minScore);

  return (
    <>
      <PageHeader
        title="Leads"
        description="Every enquiry, scored and tracked through your pipeline."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            Add lead
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted" aria-hidden />
            <Input aria-label="Search leads" placeholder="Search name, email or company" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select aria-label="Status" value={f.status} onChange={(e) => f.set({ status: e.target.value })} className="w-auto">
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select aria-label="Source" value={f.source} onChange={(e) => f.set({ source: e.target.value })} className="w-auto">
            <option value="">All sources</option>
            {Object.entries(SOURCE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Select aria-label="Minimum score" value={f.minScore} onChange={(e) => f.set({ minScore: e.target.value })} className="w-auto">
            <option value="">Any score</option>
            <option value="50">Score 50+</option>
            <option value="75">Score 75+</option>
          </Select>
          <Select aria-label="Sort by" value={f.sortKey} onChange={(e) => f.set({ sort: e.target.value })} className="w-auto">
            {Object.entries(SORTS).map(([k, s]) => (
              <option key={k} value={k}>
                {s.label}
              </option>
            ))}
          </Select>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              icon={X}
              onClick={() => {
                setSearch('');
                f.set({ q: '', status: '', source: '', minScore: '' });
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {query.isPending ? (
          <LoadingRows rows={8} label="Loading leads" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} title="Couldn't load leads" />
        ) : query.data.data.length === 0 ? (
          filtered ? (
            <EmptyState icon={Search} title="No leads match these filters" description="Try a different search or clear the filters." />
          ) : (
            <EmptyState
              icon={Users}
              title="No leads yet"
              description="Leads from your website form and API appear here automatically."
              action={
                <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                  Add your first lead
                </Button>
              }
            />
          )
        ) : (
          <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-5 py-2.5 font-medium">Lead</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Score</th>
                    <th className="hidden px-3 py-2.5 font-medium md:table-cell">Source</th>
                    <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Last contact</th>
                    <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {query.data.data.map((lead) => (
                    <tr
                      key={lead.id}
                      onClick={() => navigate(`/leads/${lead.id}`)}
                      onKeyDown={(e) => e.key === 'Enter' && navigate(`/leads/${lead.id}`)}
                      tabIndex={0}
                      className="cursor-pointer outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={lead.name} />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink">{lead.name}</p>
                            <p className="truncate text-xs text-muted">{lead.company || lead.email || lead.phone}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={lead.status} />
                      </td>
                      <td className="px-3 py-3">
                        <ScoreMeter score={lead.score} />
                      </td>
                      <td className="hidden px-3 py-3 text-ink-2 md:table-cell">{SOURCE_LABELS[lead.source]}</td>
                      <td className="hidden px-3 py-3 text-ink-2 lg:table-cell">
                        <RelativeTime date={lead.lastContactAt} />
                      </td>
                      <td className="hidden px-5 py-3 text-ink-2 sm:table-cell">
                        <RelativeTime date={lead.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination meta={query.data.meta} onPage={(page) => f.set({ page: String(page) })} />
          </div>
        )}
      </Card>
      {adding && <NewLeadDialog onClose={() => setAdding(false)} />}
    </>
  );
}
