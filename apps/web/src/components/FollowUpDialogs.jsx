import { useState } from 'react';
import { useCancelFollowUp, useRescheduleFollowUp } from '../api/hooks.js';
import { fieldErrors } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { Button } from './ui/Button.jsx';
import { Dialog } from './ui/Dialog.jsx';
import { Field, Input, Textarea } from './ui/Field.jsx';
import { Segmented } from './ui/Misc.jsx';
import { useToast } from './ui/Toast.jsx';

const PRESETS = [
  { value: '24', label: '+1 day' },
  { value: '72', label: '+3 days' },
  { value: '168', label: '+1 week' },
  { value: 'custom', label: 'Pick a time' },
];

export function RescheduleDialog({ followUp, timeZone, onClose }) {
  const toast = useToast();
  const mutation = useRescheduleFollowUp();
  const [preset, setPreset] = useState('24');
  const [custom, setCustom] = useState('');
  const [respectHours, setRespectHours] = useState(true);
  const errors = fieldErrors(mutation.error);

  const submit = () => {
    const body =
      preset === 'custom'
        ? { scheduledFor: custom ? new Date(custom).toISOString() : undefined, respectWorkingHours: respectHours }
        : { delayHours: Number(preset), respectWorkingHours: respectHours };
    mutation.mutate(
      { id: followUp.id, ...body },
      {
        onSuccess: (fu) => {
          toast.success('Follow-up rescheduled', formatDateTime(fu.scheduledFor, timeZone));
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Reschedule follow-up"
      description={`Currently ${formatDateTime(followUp.scheduledFor, timeZone)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={mutation.isPending} disabled={preset === 'custom' && !custom}>
            Reschedule
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented label="When" value={preset} onChange={setPreset} options={PRESETS} />
        {preset === 'custom' && (
          <Field label="Date and time" hint="In your browser's local time." error={errors.scheduledFor}>
            {(p) => <Input {...p} type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />}
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={respectHours} onChange={(e) => setRespectHours(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          Move into business working hours
        </label>
        {mutation.isError && !Object.keys(errors).length && <p className="text-sm text-critical">{mutation.error.message}</p>}
      </div>
    </Dialog>
  );
}

export function CancelFollowUpDialog({ followUp, onClose }) {
  const toast = useToast();
  const mutation = useCancelFollowUp();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title="Cancel this follow-up?"
      description="The draft is withdrawn and nothing will be sent. You can schedule a new one later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { id: followUp.id, ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}) },
                {
                  onSuccess: () => {
                    toast.success('Follow-up cancelled');
                    onClose();
                  },
                },
              )
            }
          >
            Cancel follow-up
          </Button>
        </>
      }
    >
      <Field label="Reason (optional)" hint="Shown on the lead's timeline.">
        {(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Spoke on the phone" />}
      </Field>
      {mutation.isError && <p className="mt-2 text-sm text-critical">{mutation.error.message}</p>}
    </Dialog>
  );
}
