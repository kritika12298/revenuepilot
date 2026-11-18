import { Link } from 'react-router';
import { Archive, Lock, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useArchiveService, useBusiness, useSaveService, useServices, useUpdateBusiness } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { Field, Input, Select, Switch, Textarea } from '../components/ui/Field.jsx';
import { PageHeader, Segmented } from '../components/ui/Misc.jsx';
import { EmptyState, LoadingRows, QueryState } from '../components/ui/States.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { fieldErrors } from '../lib/api.js';
import { DAYS } from '../lib/constants.js';
import { formatDuration, formatServicePrice } from '../lib/format.js';

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

function SaveBar({ dirty, saving, onSave, onReset, disabled }) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
      {dirty && <span className="mr-auto text-xs text-muted">Unsaved changes</span>}
      <Button variant="ghost" onClick={onReset} disabled={!dirty || saving}>
        Reset
      </Button>
      <Button variant="primary" onClick={onSave} loading={saving} disabled={!dirty || disabled}>
        Save changes
      </Button>
    </div>
  );
}

function useSave() {
  const toast = useToast();
  const mutation = useUpdateBusiness();
  const save = (body, onDone) =>
    mutation.mutate(body, {
      onSuccess: () => {
        toast.success('Settings saved');
        onDone?.();
      },
      onError: (e) => toast.error('Could not save', e.message),
    });
  return { save, saving: mutation.isPending, errors: fieldErrors(mutation.error) };
}

// --- Profile ----------------------------------------------------------------
function ProfileTab({ business, readOnly }) {
  const [form, setForm] = useState({ name: business.name, timezone: business.timezone });
  const { save, saving, errors } = useSave();
  const dirty = form.name !== business.name || form.timezone !== business.timezone;
  return (
    <Card>
      <CardHeader title="Business profile" description="How your business appears to leads and in emails." />
      <CardBody className="grid max-w-xl gap-4">
        <Field label="Business name" hint="Used as the sender name on emails." error={errors.name}>
          {(p) => <Input {...p} value={form.name} disabled={readOnly} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}
        </Field>
        <Field label="Time zone" hint="Working hours, follow-up times and charts use this time zone." error={errors.timezone}>
          {(p) => (
            <Select {...p} value={form.timezone} disabled={readOnly} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Public form address" hint="Lead capture forms identify your business by this slug.">
          {(p) => <Input {...p} value={business.slug} disabled readOnly />}
        </Field>
      </CardBody>
      {!readOnly && <SaveBar dirty={dirty} saving={saving} onSave={() => save(form)} onReset={() => setForm({ name: business.name, timezone: business.timezone })} />}
    </Card>
  );
}

// --- Services ---------------------------------------------------------------
const toDollars = (cents) => (cents == null ? '' : String(cents / 100));
const toCents = (dollars) => (dollars === '' ? null : Math.round(Number(dollars) * 100));

function ServiceDialog({ service, onClose }) {
  const toast = useToast();
  const mutation = useSaveService();
  const [v, setV] = useState({
    name: service?.name ?? '',
    description: service?.description ?? '',
    priceType: service?.priceType ?? 'FIXED',
    min: toDollars(service?.priceMinCents),
    max: toDollars(service?.priceMaxCents),
    duration: service?.durationMinutes ?? '',
    active: service?.active ?? true,
  });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const errors = fieldErrors(mutation.error);

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        ...(service && { id: service.id }),
        name: v.name,
        description: v.description || null,
        priceType: v.priceType,
        priceMinCents: v.priceType === 'QUOTE_ONLY' ? null : toCents(v.min),
        priceMaxCents: v.priceType === 'RANGE' ? toCents(v.max) : null,
        durationMinutes: v.duration === '' ? null : Number(v.duration),
        active: v.active,
      },
      {
        onSuccess: () => {
          toast.success(service ? 'Service updated' : 'Service added');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={service ? 'Edit service' : 'Add a service'}
      description="The AI only ever quotes prices listed here."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="service-form" loading={mutation.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="service-form" onSubmit={submit} className="space-y-3">
        <Field label="Name" error={errors.name}>{(p) => <Input {...p} required value={v.name} onChange={set('name')} />}</Field>
        <Field label="Description" hint="Helps the AI match enquiries to this service." error={errors.description}>
          {(p) => <Textarea {...p} rows={2} value={v.description} onChange={set('description')} />}
        </Field>
        <Field label="Pricing">
          {(p) => (
            <Select {...p} value={v.priceType} onChange={set('priceType')}>
              <option value="FIXED">Fixed price</option>
              <option value="RANGE">Price range</option>
              <option value="QUOTE_ONLY">Quote only (no published price)</option>
            </Select>
          )}
        </Field>
        {v.priceType !== 'QUOTE_ONLY' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={v.priceType === 'RANGE' ? 'From ($)' : 'Price ($)'} error={errors.priceMinCents}>
              {(p) => <Input {...p} type="number" min="0" step="0.01" required value={v.min} onChange={set('min')} />}
            </Field>
            {v.priceType === 'RANGE' && (
              <Field label="To ($)" error={errors.priceMaxCents}>
                {(p) => <Input {...p} type="number" min="0" step="0.01" required value={v.max} onChange={set('max')} />}
              </Field>
            )}
          </div>
        )}
        <Field label="Typical duration (minutes)" error={errors.durationMinutes}>
          {(p) => <Input {...p} type="number" min="5" step="5" value={v.duration} onChange={set('duration')} />}
        </Field>
        <Switch label="Active" description="Inactive services are hidden from the AI." checked={v.active} onChange={(active) => setV((s) => ({ ...s, active }))} />
        {mutation.isError && !Object.keys(errors).length && <p className="text-sm text-critical">{mutation.error.message}</p>}
      </form>
    </Dialog>
  );
}

function ServicesTab({ readOnly }) {
  const query = useServices(true);
  const archive = useArchiveService();
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  return (
    <Card>
      <CardHeader
        title="Services and pricing"
        description="The single source of truth for what you offer and what it costs."
        actions={
          !readOnly && (
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setEditing('new')}>
              Add service
            </Button>
          )
        }
      />
      <QueryState query={query} loading={<LoadingRows rows={4} />}>
        {({ data }) =>
          data.length === 0 ? (
            <EmptyState
              icon={Tag}
              title="No services yet"
              description="Add your services so the AI can match enquiries and quote your published prices."
              action={!readOnly && <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>Add a service</Button>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-5 py-2.5 font-medium">Service</th>
                    <th className="px-3 py-2.5 font-medium">Price</th>
                    <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Duration</th>
                    <th className="px-5 py-2.5 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.map((s) => (
                    <tr key={s.id} className={s.active ? undefined : 'opacity-60'}>
                      <td className="px-5 py-3">
                        <p className="flex items-center gap-2 font-medium text-ink">
                          {s.name}
                          {!s.active && <Badge icon={Archive}>Inactive</Badge>}
                        </p>
                        {s.description && <p className="mt-0.5 max-w-md text-xs text-muted">{s.description}</p>}
                      </td>
                      <td className="px-3 py-3 text-ink tabular">{formatServicePrice(s)}</td>
                      <td className="hidden px-3 py-3 text-ink-2 sm:table-cell">{formatDuration(s.durationMinutes)}</td>
                      <td className="px-5 py-3 text-right whitespace-nowrap">
                        {!readOnly && (
                          <>
                            <Button size="icon" variant="ghost" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {s.active && (
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Deactivate ${s.name}`}
                                onClick={() =>
                                  archive.mutate(s.id, {
                                    onSuccess: () => toast.success(`${s.name} deactivated`),
                                    onError: (e) => toast.error('Could not deactivate', e.message),
                                  })
                                }
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </QueryState>
      {editing && <ServiceDialog service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// --- Working hours ----------------------------------------------------------
function HoursTab({ business, readOnly }) {
  const initial = useMemo(() => Object.fromEntries(DAYS.map(([d]) => [d, business.workingHours?.[d] ?? []])), [business.workingHours]);
  const [hours, setHours] = useState(initial);
  const { save, saving, errors } = useSave();
  const dirty = JSON.stringify(hours) !== JSON.stringify(initial);
  const invalid = Object.values(hours).some((list) => list.some((i) => !i.open || !i.close || i.open >= i.close));

  const update = (day, index, patch) => setHours((h) => ({ ...h, [day]: h[day].map((i, n) => (n === index ? { ...i, ...patch } : i)) }));
  const toggle = (day, open) => setHours((h) => ({ ...h, [day]: open ? [{ open: '09:00', close: '17:00' }] : [] }));

  return (
    <Card>
      <CardHeader title="Working hours" description={`Follow-ups are only sent during these hours (${business.timezone}).`} />
      <CardBody>
        <ul className="divide-y divide-line">
          {DAYS.map(([day, label]) => (
            <li key={day} className="grid grid-cols-1 items-center gap-3 py-3 sm:grid-cols-[10rem_1fr]">
              <Switch label={label} checked={hours[day].length > 0} onChange={(open) => toggle(day, open)} disabled={readOnly} />
              <div className="space-y-2">
                {hours[day].length === 0 ? (
                  <p className="text-sm text-muted">Closed</p>
                ) : (
                  hours[day].map((interval, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input type="time" aria-label={`${label} opens`} value={interval.open} disabled={readOnly} onChange={(e) => update(day, i, { open: e.target.value })} className="w-32" />
                      <span className="text-muted">to</span>
                      <Input type="time" aria-label={`${label} closes`} value={interval.close} disabled={readOnly} onChange={(e) => update(day, i, { close: e.target.value })} className="w-32" />
                      {interval.open >= interval.close && <span className="text-xs text-critical">Must close after opening</span>}
                      {!readOnly && hours[day].length > 1 && (
                        <Button size="icon" variant="ghost" aria-label={`Remove ${label} interval`} onClick={() => setHours((h) => ({ ...h, [day]: h[day].filter((_, n) => n !== i) }))}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))
                )}
                {!readOnly && hours[day].length > 0 && hours[day].length < 4 && (
                  <button
                    type="button"
                    className="text-xs font-medium text-accent hover:underline"
                    onClick={() => setHours((h) => ({ ...h, [day]: [...h[day], { open: '13:00', close: '17:00' }] }))}
                  >
                    Add a split shift
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {errors.workingHours && <p className="text-sm text-critical">{errors.workingHours}</p>}
        <p className="mt-3 text-xs text-muted">With no hours set at all, follow-ups can be sent at any time.</p>
      </CardBody>
      {!readOnly && (
        <SaveBar
          dirty={dirty}
          saving={saving}
          disabled={invalid}
          onReset={() => setHours(initial)}
          onSave={() => save({ workingHours: Object.fromEntries(Object.entries(hours).filter(([, list]) => list.length)) })}
        />
      )}
    </Card>
  );
}

// --- Communication ----------------------------------------------------------
const DEFAULT_CADENCE = [48, 96, 168];

function CommsTab({ business, readOnly }) {
  const prefs = useMemo(() => business.commsPrefs ?? {}, [business.commsPrefs]);
  const initial = useMemo(
    () => ({
      tone: prefs.tone ?? 'friendly',
      signature: prefs.signature ?? '',
      followUpsEnabled: prefs.followUpsEnabled !== false,
      maxFollowUps: prefs.maxFollowUps ?? 3,
      cadence: prefs.followUpCadenceHours?.length ? prefs.followUpCadenceHours : DEFAULT_CADENCE,
    }),
    [prefs],
  );
  const [v, setV] = useState(initial);
  const { save, saving, errors } = useSave();
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const cadence = Array.from({ length: v.maxFollowUps }, (_, i) => v.cadence[i] ?? v.cadence.at(-1) ?? 48);

  const onSave = () =>
    save({
      commsPrefs: {
        ...prefs,
        tone: v.tone,
        ...(v.signature.trim() ? { signature: v.signature.trim() } : {}),
        followUpsEnabled: v.followUpsEnabled,
        maxFollowUps: Number(v.maxFollowUps),
        followUpCadenceHours: cadence.slice(0, Math.max(1, v.maxFollowUps)).map(Number),
        channels: ['EMAIL'],
      },
    });

  return (
    <Card>
      <CardHeader title="Communication preferences" description="How the AI writes, and how follow-ups behave." />
      <CardBody className="grid max-w-2xl gap-5">
        <Field label="Tone of voice">
          {(p) => (
            <Select {...p} value={v.tone} disabled={readOnly} onChange={(e) => setV((s) => ({ ...s, tone: e.target.value }))}>
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="concise">Concise</option>
            </Select>
          )}
        </Field>
        <Field label="Email signature" error={errors['commsPrefs.signature']}>
          {(p) => <Textarea {...p} rows={3} value={v.signature} disabled={readOnly} placeholder={business.name} onChange={(e) => setV((s) => ({ ...s, signature: e.target.value }))} />}
        </Field>
        <div className="space-y-4 rounded-xl border border-line p-4">
          <Switch
            label="Automatic follow-ups"
            description="Check in with leads who haven't replied, during working hours, only if they consented to email."
            checked={v.followUpsEnabled}
            disabled={readOnly}
            onChange={(followUpsEnabled) => setV((s) => ({ ...s, followUpsEnabled }))}
          />
          {v.followUpsEnabled && (
            <>
              <p className="text-sm text-muted">
                Whether follow-ups need your approval is set in the <Link to="/autonomy" className="font-medium text-accent hover:underline">Autonomy control center</Link>.
              </p>
              <Field label="Maximum follow-ups per lead">
                {(p) => (
                  <Select {...p} value={v.maxFollowUps} disabled={readOnly} onChange={(e) => setV((s) => ({ ...s, maxFollowUps: Number(e.target.value) }))} className="w-32">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink">Wait before each follow-up</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {cadence.map((hoursValue, i) => (
                    <label key={i} className="text-sm text-ink-2">
                      <span className="mb-1 block text-xs text-muted">Follow-up {i + 1}</span>
                      <span className="flex items-center gap-2">
                        <Input
                          type="number"
                          min="1"
                          max="720"
                          value={hoursValue}
                          disabled={readOnly}
                          onChange={(e) => setV((s) => ({ ...s, cadence: cadence.map((c, n) => (n === i ? Number(e.target.value) : c)) }))}
                          className="w-24"
                          aria-label={`Hours before follow-up ${i + 1}`}
                        />
                        hours
                      </span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">Counted from the previous email, then moved into working hours.</p>
              </fieldset>
            </>
          )}
        </div>
      </CardBody>
      {!readOnly && <SaveBar dirty={dirty} saving={saving} onSave={onSave} onReset={() => setV(initial)} />}
    </Card>
  );
}

const TABS = [
  { value: 'profile', label: 'Profile' },
  { value: 'services', label: 'Services & pricing' },
  { value: 'hours', label: 'Working hours' },
  { value: 'comms', label: 'Communication' },
];

export function SettingsPage() {
  const { isOwner } = useAuth();
  const query = useBusiness();
  const [tab, setTab] = useState('profile');
  const readOnly = !isOwner;
  return (
    <>
      <PageHeader title="Business settings" description="Your profile, services, hours and how RevenuePilot talks to leads." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented label="Settings sections" value={tab} onChange={setTab} options={TABS} />
        {readOnly && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Only the owner can change settings
          </span>
        )}
      </div>
      <QueryState query={query} loading={<Card><LoadingRows rows={4} /></Card>}>
        {(business) => (
          <>
            {tab === 'profile' && <ProfileTab key={business.updatedAt} business={business} readOnly={readOnly} />}
            {tab === 'services' && <ServicesTab readOnly={readOnly} />}
            {tab === 'hours' && <HoursTab key={business.updatedAt} business={business} readOnly={readOnly} />}
            {tab === 'comms' && <CommsTab key={business.updatedAt} business={business} readOnly={readOnly} />}
          </>
        )}
      </QueryState>
    </>
  );
}
