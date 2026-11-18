import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider.jsx';
import { fieldErrors } from '../lib/api.js';
import { Button } from '../components/ui/Button.jsx';
import { Field, Input } from '../components/ui/Field.jsx';

function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <svg viewBox="0 0 32 32" className="mb-4 h-10 w-10" aria-hidden>
            <rect width="32" height="32" rx="8" fill="var(--accent)" />
            <path d="M9 21l5-6 4 3 5-8" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">{children}</div>
        <p className="mt-4 text-center text-sm text-muted">{footer}</p>
      </div>
    </div>
  );
}

function useForm(initial) {
  const [values, setValues] = useState(initial);
  const bind = (name) => ({ value: values[name], onChange: (e) => setValues((v) => ({ ...v, [name]: e.target.value })) });
  return { values, bind };
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { values, bind } = useForm({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (auth.token && auth.session) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(values);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to see your leads and follow-ups."
      footer={
        <>
          New to RevenuePilot?{' '}
          <Link to="/register" className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" required {...bind('email')} />}</Field>
        <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="current-password" required {...bind('password')} />}</Field>
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error.message}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { values, bind } = useForm({
    name: '',
    email: '',
    password: '',
    businessName: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const errors = fieldErrors(error);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.register(values);
      navigate('/settings', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Set up your business"
      subtitle="Turn website enquiries into customers."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Business name" error={errors.businessName}>{(p) => <Input {...p} required {...bind('businessName')} />}</Field>
        <Field label="Your name" error={errors.name}>{(p) => <Input {...p} autoComplete="name" required {...bind('name')} />}</Field>
        <Field label="Email" error={errors.email}>{(p) => <Input {...p} type="email" autoComplete="email" required {...bind('email')} />}</Field>
        <Field label="Password" hint="At least 10 characters." error={errors.password}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" minLength={10} required {...bind('password')} />}
        </Field>
        {error && !Object.keys(errors).length && (
          <p role="alert" className="text-sm text-critical">
            {error.message}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
