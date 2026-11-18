import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api, fieldErrors } from '../lib/api.js';
import { Button } from '../components/ui/Button.jsx';
import { Field, Input, Textarea } from '../components/ui/Field.jsx';
import { ErrorState, Spinner } from '../components/ui/States.jsx';

/**
 * Hosted enquiry form (/f/:slug). Embeddable on a GoDaddy Websites + Marketing
 * site (HTML embed section) or any site via an iframe.
 */
export function PublicFormPage() {
  const { slug } = useParams();
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [v, setV] = useState({ name: '', email: '', phone: '', message: '', consent: false, website: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api(`/public/forms/${slug}`).then(setForm).catch(setError);
  }, [slug]);

  const bind = (k) => ({ value: v[k], onChange: (e) => setV((s) => ({ ...s, [k]: e.target.value })) });
  const errors = fieldErrors(submitError);
  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      setDone(await api(`/public/forms/${slug}/leads`, { method: 'POST', body: v }));
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (error) return <ErrorState error={error} title="This form is not available" />;
  if (!form) return <div className="flex h-full items-center justify-center text-muted"><Spinner /></div>;
  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-ink">Contact {form.business.name}</h1>
        <p className="mt-1 text-sm text-muted">Tell us what you need and we will get back to you.</p>
        {done ? (
          <p role="status" className="mt-6 flex items-start gap-2 rounded-lg bg-good-soft p-4 text-sm text-good"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{done.message}</p>
        ) : (
          <form onSubmit={submit} className="mt-5 space-y-3">
            <Field label="Name" error={errors.name}>{(p) => <Input {...p} required autoComplete="name" {...bind('name')} />}</Field>
            <Field label="Email" error={errors.email}>{(p) => <Input {...p} required type="email" autoComplete="email" {...bind('email')} />}</Field>
            <Field label="Phone (optional)" error={errors.phone}>{(p) => <Input {...p} type="tel" autoComplete="tel" {...bind('phone')} />}</Field>
            <Field label="How can we help?" error={errors.message}>{(p) => <Textarea {...p} required rows={5} {...bind('message')} />}</Field>
            {/* Honeypot for bots: visually hidden, skipped by keyboard and screen readers. */}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" {...bind('website')} />
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={v.consent} onChange={(e) => setV((s) => ({ ...s, consent: e.target.checked }))} />
              <span>{form.consentText} <span className="text-muted">(optional; you can unsubscribe at any time)</span></span>
            </label>
            {submitError && !Object.keys(errors).length && <p className="text-sm text-critical">{submitError.message}</p>}
            <Button type="submit" variant="primary" className="w-full justify-center" loading={submitting}>Send enquiry</Button>
          </form>
        )}
      </div>
      <p className="mt-3 text-center text-xs text-muted">Powered by RevenuePilot</p>
    </main>
  );
}
