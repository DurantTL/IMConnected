import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';

// Wires the passkey buttons on the /admin pages. Bundled from @simplewebauthn/browser by Astro and
// served from this site (no CDN). The server decides everything: this only runs the browser ceremony
// and posts the result in an ordinary form, so the pages work the same way they do for a code.
//
// Markup contract:
//   <button type="button" data-passkey="login|second|register" [hidden data-passkey-needs-js]>
//     inside a <form method="post"> that has <input type="hidden" name="passkey">.
//   register forms may also carry name="assertion" (a fresh proof by passkey) and a name="code" field.
//   <form data-fresh-form data-has-passkeys> with name="code": submitting with an empty code asks for a passkey.
//   [data-passkey-error] (role="alert") shows messages next to the button.

const supported = browserSupportsWebAuthn();
for (const el of document.querySelectorAll<HTMLElement>('[data-passkey-needs-js]')) el.hidden = !supported;
for (const el of document.querySelectorAll<HTMLElement>('[data-passkey-unsupported]')) el.hidden = supported;

async function post(url: string): Promise<{ ok: boolean; options?: any; error?: string }> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } });
  try {
    return await res.json();
  } catch {
    return { ok: false, error: 'The server sent an unexpected answer.' };
  }
}

function say(form: HTMLElement, text: string) {
  const box = form.querySelector<HTMLElement>('[data-passkey-error]') ?? document.querySelector<HTMLElement>('[data-passkey-error]');
  if (box) {
    box.textContent = text;
    box.hidden = !text;
  }
}

function friendly(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey prompt was cancelled or timed out. Please try again.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account. Use a different device or key.';
  if (err instanceof Error && err.message && !/^The operation/.test(err.message)) return err.message;
  return 'Something went wrong with the passkey. Please try again.';
}

function setField(form: HTMLFormElement, name: string, value: string) {
  const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input) input.value = value;
}

/** Fresh proof for a sensitive change: a passkey assertion, used when no code was typed. */
async function freshAssertion(form: HTMLFormElement): Promise<boolean> {
  const opts = await post('/api/admin/passkeys/options');
  if (!opts.ok) {
    say(form, opts.error || 'Could not start the passkey check.');
    return false;
  }
  setField(form, 'assertion', JSON.stringify(await startAuthentication({ optionsJSON: opts.options })));
  return true;
}

async function run(button: HTMLButtonElement) {
  const form = button.closest('form');
  if (!form) return;
  const kind = button.dataset.passkey;
  say(form, '');
  button.disabled = true;
  try {
    if (kind === 'login' || kind === 'second') {
      const opts = await post(kind === 'login' ? '/api/admin/passkeys/login/options' : '/api/admin/passkeys/options');
      if (!opts.ok) return say(form, opts.error || 'Could not start the passkey check.');
      setField(form, 'passkey', JSON.stringify(await startAuthentication({ optionsJSON: opts.options })));
    } else if (kind === 'register') {
      const code = form.querySelector<HTMLInputElement>('input[name="code"]');
      if (form.dataset.hasPasskeys !== undefined && code && !code.value.trim() && !(await freshAssertion(form))) return;
      const opts = await post('/api/admin/passkeys/register/options');
      if (!opts.ok) return say(form, opts.error || 'Could not start passkey registration.');
      setField(form, 'passkey', JSON.stringify(await startRegistration({ optionsJSON: opts.options })));
    } else {
      return;
    }
    form.submit();
  } catch (err) {
    say(form, friendly(err));
  } finally {
    button.disabled = false;
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-passkey]')) {
  button.addEventListener('click', () => void run(button));
}

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-fresh-form]')) {
  form.addEventListener('submit', async (event) => {
    const code = form.querySelector<HTMLInputElement>('input[name="code"]');
    if (!supported || form.dataset.hasPasskeys === undefined || (code && code.value.trim())) return; // normal submit
    event.preventDefault();
    say(form, '');
    try {
      if (await freshAssertion(form)) form.submit();
    } catch (err) {
      say(form, friendly(err));
    }
  });
}
