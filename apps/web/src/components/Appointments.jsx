import { CalendarCheck, CalendarDays, CalendarX2 } from 'lucide-react';
import { useState } from 'react';
import { useAppointmentOutcome, useBookAppointment, useCancelAppointment, useRescheduleAppointment, useSlots } from '../api/hooks.js';
import { formatDateTime } from '../lib/format.js';
import { Badge } from './ui/Badge.jsx';
import { Button } from './ui/Button.jsx';
import { Dialog } from './ui/Dialog.jsx';
import { Field, Input, Select } from './ui/Field.jsx';
import { EmptyState, Spinner } from './ui/States.jsx';
import { useToast } from './ui/Toast.jsx';

const TONE = { CONFIRMED: 'good', PROPOSED: 'warning', CANCELLED: 'neutral', COMPLETED: 'good', NO_SHOW: 'critical' };
const LABEL = { CONFIRMED: 'Confirmed', PROPOSED: 'Awaiting your approval', CANCELLED: 'Cancelled', COMPLETED: 'Completed', NO_SHOW: 'No-show' };

function SlotPicker({ leadId, duration, value, onChange, timeZone }) {
  const slots = useSlots(leadId, duration, true);
  if (slots.isPending) return <Spinner className="h-4 w-4 text-muted" />;
  if (slots.isError) return <p className="text-sm text-critical">{slots.error.message}</p>;
  if (!slots.data.slots.length) return <p className="text-sm text-muted">No free slots in the next 10 days within working hours.</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">Free times from {slots.data.calendar}, within your working hours</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {slots.data.slots.map((s) => (
          <button
            key={s.start}
            type="button"
            onClick={() => onChange(s.start)}
            aria-pressed={value === s.start}
            className={`rounded-lg border px-3 py-2 text-left text-sm ${value === s.start ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line hover:bg-surface-2'}`}
          >
            {formatDateTime(s.start, timeZone ?? slots.data.timeZone)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BookAppointmentDialog({ lead, timeZone, onClose }) {
  const toast = useToast();
  const book = useBookAppointment(lead.id);
  const [duration, setDuration] = useState(60);
  const [start, setStart] = useState(null);
  const [title, setTitle] = useState('Site visit');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Book an appointment with ${lead.name}`}
      description="Booked by you, so it is confirmed immediately and the lead gets a confirmation email (consent permitting)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!start || !title} loading={book.isPending} onClick={() => book.mutate({ startsAt: start, durationMinutes: duration, title }, { onSuccess: () => { toast.success('Appointment booked'); onClose(); }, onError: (e) => toast.error('Could not book', e.message) })}>
            Book
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="What">{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Duration">
            {(p) => (
              <Select {...p} value={duration} onChange={(e) => { setDuration(Number(e.target.value)); setStart(null); }}>
                {[30, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </Select>
            )}
          </Field>
        </div>
        <SlotPicker leadId={lead.id} duration={duration} value={start} onChange={setStart} timeZone={timeZone} />
      </div>
    </Dialog>
  );
}

function RescheduleDialog({ appointment, timeZone, onClose }) {
  const toast = useToast();
  const mutation = useRescheduleAppointment();
  const duration = Math.round((new Date(appointment.endsAt) - new Date(appointment.startsAt)) / 60e3);
  const [start, setStart] = useState(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Reschedule appointment"
      description={`Currently ${formatDateTime(appointment.startsAt, timeZone)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!start} loading={mutation.isPending} onClick={() => mutation.mutate({ id: appointment.id, startsAt: start }, { onSuccess: () => { toast.success('Appointment moved'); onClose(); }, onError: (e) => toast.error('Could not reschedule', e.message) })}>
            Move
          </Button>
        </>
      }
    >
      <SlotPicker leadId={appointment.leadId} duration={duration} value={start} onChange={setStart} timeZone={timeZone} />
    </Dialog>
  );
}

export function AppointmentList({ appointments, timeZone, showLead = false }) {
  const toast = useToast();
  const cancel = useCancelAppointment();
  const outcome = useAppointmentOutcome();
  const [moving, setMoving] = useState(null);
  if (!appointments?.length) return <EmptyState icon={CalendarDays} title="No appointments" description="Bookings by the Meeting Agent or your team appear here." className="py-6" />;
  return (
    <>
      <ul className="divide-y divide-line">
        {appointments.map((a) => {
          const active = a.status === 'CONFIRMED' || a.status === 'PROPOSED';
          const past = new Date(a.startsAt) < new Date();
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <CalendarDays className="h-4 w-4 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{a.title}{showLead && a.lead && <span className="font-normal text-muted"> · {a.lead.name}</span>}</p>
                <p className="text-xs text-muted">{formatDateTime(a.startsAt, timeZone)} · booked by {a.bookedBy === 'AI' ? 'Meeting Agent' : 'your team'}{a.calendarProvider === 'google' ? ' · Google Calendar' : ''}</p>
              </div>
              <Badge tone={TONE[a.status]}>{LABEL[a.status]}</Badge>
              {active && !past && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setMoving(a)}>Reschedule</Button>
                  <Button size="sm" variant="ghost" icon={CalendarX2} onClick={() => cancel.mutate({ id: a.id }, { onSuccess: () => toast.success('Appointment cancelled') })}>Cancel</Button>
                </span>
              )}
              {a.status === 'CONFIRMED' && past && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" icon={CalendarCheck} onClick={() => outcome.mutate({ id: a.id, status: 'COMPLETED' })}>Completed</Button>
                  <Button size="sm" variant="ghost" onClick={() => outcome.mutate({ id: a.id, status: 'NO_SHOW' })}>No-show</Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {moving && <RescheduleDialog appointment={moving} timeZone={timeZone} onClose={() => setMoving(null)} />}
    </>
  );
}
