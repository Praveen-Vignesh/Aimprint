// The account panel, wherever it appears. The markup stays in each page so the
// landing pages can style it however they like; this module finds its controls
// by `data-auth` *inside the root it is handed*, never by global id. That is
// what lets two differently-styled pages share one implementation, and what
// stops a second panel on a page from colliding with the first.
//
// `auth` supplies the async account actions (onSignIn / onSignUp /
// onGoogleSignIn / onSignOut / onRequestReset / onUpdatePassword), each
// resolving to a result object ({ error } / { needsConfirmation } / {}) that
// this module displays. The seam is deliberate: this file never imports
// supabase.js, so it stays drivable from a test harness with plain stubs.
//
// `onReady` fires when the account becomes signed in — the landing pages use it
// to move the player on to the game.
//
// There is no consent step. The checkbox, its block and the six data-auth hooks
// it needed were removed on 2026-10-18 along with the rest of the consent
// system; agreement is now part of creating an account and is stated in the
// sign-up card's copy.
//
// Sign in and sign up share one email + one password field, but are otherwise
// mutually exclusive views picked by the "Sign in" / "Create account" tabs:
// each shows only its own rows (full name, confirm password, strength for
// sign-up; remember me, forgot password for sign-in) and only its own action
// button — never both signin and signup buttons at once, which read as two
// different ways to do the same thing. Default mode is 'signin', so
// `data-auth="email"` / `"password"` / `"signin"` are visible and functional
// without touching a tab at all — this is what `bot_driver/src/run.js` drives
// directly by selector, so those three hooks' meaning never changes.
//
// Forgot password is a second, replacing view inside the same panel rather
// than a new page: this is a static multi-page build with no router, so the
// reset email's link points back at `/`, and the recovery session it hands
// back is surfaced by supabase.js as `isRecovery` on the auth state — the
// caller (render()) swaps straight to the "set a new password" view instead
// of treating it as an ordinary signed-in visit.

const REQUIRED = [
  'signed-out',
  'signed-in',
  'view-form',
  'view-reset-request',
  'view-reset-new',
  'tab-signin',
  'tab-signup',
  'email',
  'password',
  'password-toggle',
  'fullname',
  'row-fullname',
  'confirm-password',
  'confirm-password-toggle',
  'row-confirm-password',
  'strength',
  'row-strength',
  'remember',
  'forgot',
  'row-signin-extra',
  'email-error',
  'password-error',
  'confirm-password-error',
  'signin',
  'signup',
  'google',
  'message',
  'account-email',
  'signout',
  'reset-email',
  'reset-request-submit',
  'reset-error',
  'back-to-signin',
  'new-password',
  'confirm-new-password',
  'reset-submit',
  'reset-new-error'
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

const EYE_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.2A11 11 0 0 1 12 5c7 0 11 7 11 7a13.2 13.2 0 0 1-3.4 3.9M6.6 6.6C3.7 8.5 1 12 1 12s4 7 11 7c1.4 0 2.7-.3 3.9-.7"/><path d="M9.5 9.5a3 3 0 0 0 4.2 4.2"/></svg>';

function strengthOf(password) {
  if (password.length === 0) return { score: 0, label: '' };
  if (password.length < MIN_PASSWORD_LENGTH) return { score: 1, label: 'Too short' };

  let score = 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score: Math.min(score, 4), label: labels[Math.min(score, 4)] };
}

export function createAuthPanel({ root, auth, onReady = null }) {
  const el = {};
  const missing = [];

  for (const key of REQUIRED) {
    const node = root.querySelector(`[data-auth="${key}"]`);
    if (node === null) missing.push(key);
    el[key] = node;
  }

  // Fails at construction, not on the first click. A page that drops a hook
  // would otherwise render a panel that looks complete and throws only when
  // somebody tries to use it — which, for a sign-up form, means finding out
  // from a user rather than from a page load.
  if (missing.length > 0) {
    throw new Error(
      `createAuthPanel: markup is missing data-auth hooks: ${missing.join(', ')}`
    );
  }

  // Visibility is set inline rather than with a class. This module runs on
  // pages whose stylesheets it does not control, and a class-based toggle loses
  // to any rule that gives the block its own `display` (the `.x.hidden` pairing
  // trap documented in CLAUDE.md). An inline style out-cascades all of them, so
  // a page cannot accidentally make a block unhideable.
  function show(node, visible) {
    node.style.display = visible ? '' : 'none';
  }

  function setMessage(text, isError = false) {
    el.message.textContent = text ?? '';
    el.message.classList.toggle('error', isError === true && Boolean(text));
  }

  function setFieldError(node, text) {
    node.textContent = text ?? '';
  }

  function setBusy(busy) {
    for (const key of [
      'signin',
      'signup',
      'google',
      'email',
      'password',
      'fullname',
      'confirm-password',
      'remember',
      'reset-email',
      'reset-request-submit',
      'new-password',
      'confirm-new-password',
      'reset-submit'
    ]) {
      el[key].disabled = busy;
    }
  }

  // Swaps a submit button's own label for a progress one and back, so a
  // double-click can't fire the request twice and the wait is visible exactly
  // where the player's attention already is — not just in the banner above.
  function withBusyLabel(button, busyLabel, fn) {
    const original = button.textContent;
    button.textContent = busyLabel;
    button.classList.add('busy');
    return fn().finally(() => {
      button.textContent = original;
      button.classList.remove('busy');
    });
  }

  function credentials() {
    return { email: el.email.value.trim(), password: el.password.value };
  }

  // --- view / tab state --------------------------------------------------
  // `view` picks which of the three top-level screens is showing; `mode`
  // (meaningful only within the 'form' view) picks which of the sign-in-only
  // / sign-up-only rows — and which single action button — are showing. The
  // two buttons are never both visible: that reads as "pick one of two ways
  // to create an account" when there is only one. Default mode is 'signin',
  // so the signin button is the one visible without touching a tab — this is
  // what bot_driver/src/run.js relies on.

  let mode = 'signin';

  function renderMode() {
    const signup = mode === 'signup';
    show(el['row-fullname'], signup);
    show(el['row-confirm-password'], signup);
    show(el['row-strength'], signup);
    show(el['row-signin-extra'], signup === false);
    show(el.signin, signup === false);
    show(el.signup, signup);
    el['tab-signin'].classList.toggle('active', signup === false);
    el['tab-signup'].classList.toggle('active', signup);
  }

  function setMode(next) {
    mode = next;
    renderMode();
  }

  let view = 'form';

  function setView(next) {
    view = next;
    show(el['view-form'], next === 'form');
    show(el['view-reset-request'], next === 'reset-request');
    show(el['view-reset-new'], next === 'reset-new');
    setMessage('');
  }

  // --- password visibility toggles ---------------------------------------

  function wirePasswordToggle(toggleButton, input) {
    let revealed = false;
    toggleButton.innerHTML = EYE_SVG;
    toggleButton.setAttribute('aria-label', 'Show password');
    toggleButton.addEventListener('click', () => {
      revealed = revealed === false;
      input.type = revealed ? 'text' : 'password';
      toggleButton.innerHTML = revealed ? EYE_OFF_SVG : EYE_SVG;
      toggleButton.setAttribute('aria-label', revealed ? 'Hide password' : 'Show password');
    });
  }

  wirePasswordToggle(el['password-toggle'], el.password);
  wirePasswordToggle(el['confirm-password-toggle'], el['confirm-password']);

  // --- live validation -----------------------------------------------------

  function renderStrength() {
    const { score, label } = strengthOf(el.password.value);
    el.strength.textContent = label;
    el['row-strength'].dataset.score = String(score);
  }

  el.email.addEventListener('input', () => setFieldError(el['email-error'], ''));
  el.password.addEventListener('input', () => {
    setFieldError(el['password-error'], '');
    renderStrength();
  });
  el['confirm-password'].addEventListener('input', () =>
    setFieldError(el['confirm-password-error'], '')
  );

  // Returns true (and leaves the inline errors in place) only when every field
  // the given action actually reads is valid — checked client-side so a typo
  // never costs a round trip the cohort's tiny recruitment pool can't spare.
  function validate({ requireConfirm }) {
    let ok = true;
    const { email, password } = credentials();

    if (email === '' || EMAIL_RE.test(email) === false) {
      setFieldError(el['email-error'], 'Enter a valid email address.');
      ok = false;
    }
    if (password === '' || password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(
        el['password-error'],
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
      );
      ok = false;
    }
    if (requireConfirm) {
      const confirm = el['confirm-password'].value;
      if (confirm !== password) {
        setFieldError(el['confirm-password-error'], 'Passwords do not match.');
        ok = false;
      }
    }
    return ok;
  }

  async function handleSignIn() {
    setFieldError(el['email-error'], '');
    setFieldError(el['password-error'], '');
    if (validate({ requireConfirm: false }) === false) return;

    auth.onRememberMe(el.remember.checked);
    setBusy(true);
    setMessage('');
    const result = await withBusyLabel(el.signin, 'Signing in…', () =>
      auth.onSignIn(credentials())
    );
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
    else setMessage('');
  }

  async function handleSignUp() {
    setFieldError(el['email-error'], '');
    setFieldError(el['password-error'], '');
    setFieldError(el['confirm-password-error'], '');
    if (validate({ requireConfirm: true }) === false) return;

    auth.onRememberMe(el.remember.checked);
    setBusy(true);
    setMessage('');
    const { email, password } = credentials();
    const fullName = el.fullname.value;
    const result = await withBusyLabel(el.signup, 'Creating account…', () =>
      auth.onSignUp({ email, password, fullName })
    );
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
    else if (result && result.needsConfirmation) {
      setMessage('Account created. Check your email to confirm, then sign in.');
    } else setMessage('');
  }

  async function handleGoogleSignIn() {
    auth.onRememberMe(el.remember.checked);
    setBusy(true);
    setMessage('Redirecting to Google…');
    const result = await auth.onGoogleSignIn();
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
  }

  async function handleResetRequest() {
    const email = el['reset-email'].value.trim();
    setFieldError(el['reset-error'], '');
    if (email === '' || EMAIL_RE.test(email) === false) {
      setFieldError(el['reset-error'], 'Enter a valid email address.');
      return;
    }

    setBusy(true);
    const result = await withBusyLabel(el['reset-request-submit'], 'Sending…', () =>
      auth.onRequestReset(email)
    );
    setBusy(false);

    if (result && result.error) setFieldError(el['reset-error'], result.error);
    else setMessage('Check your email for a password reset link.');
  }

  async function handleResetSubmit() {
    const password = el['new-password'].value;
    const confirm = el['confirm-new-password'].value;
    setFieldError(el['reset-new-error'], '');

    if (password === '' || password.length < MIN_PASSWORD_LENGTH) {
      setFieldError(
        el['reset-new-error'],
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
      );
      return;
    }
    if (confirm !== password) {
      setFieldError(el['reset-new-error'], 'Passwords do not match.');
      return;
    }

    setBusy(true);
    const result = await withBusyLabel(el['reset-submit'], 'Saving…', () =>
      auth.onUpdatePassword(password)
    );
    setBusy(false);

    if (result && result.error) setFieldError(el['reset-new-error'], result.error);
    else if (onReady !== null) onReady();
  }

  el.signin.addEventListener('click', handleSignIn);
  el.signup.addEventListener('click', handleSignUp);
  el.google.addEventListener('click', handleGoogleSignIn);
  el.signout.addEventListener('click', () => auth.onSignOut());

  el['tab-signin'].addEventListener('click', () => setMode('signin'));
  el['tab-signup'].addEventListener('click', () => setMode('signup'));
  el.forgot.addEventListener('click', () => setView('reset-request'));
  el['back-to-signin'].addEventListener('click', () => setView('form'));
  el['reset-request-submit'].addEventListener('click', handleResetRequest);
  el['reset-submit'].addEventListener('click', handleResetSubmit);

  // Enter submits, because a multi-field form that ignores Enter feels broken.
  // It submits whichever action is actually on screen for the current mode —
  // never the hidden one, which the player couldn't have clicked anyway.
  function handlePrimary() {
    if (mode === 'signup') handleSignUp();
    else handleSignIn();
  }

  for (const field of [el.email, el.password, el.fullname, el['confirm-password']]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handlePrimary();
    });
  }
  el['reset-email'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleResetRequest();
  });
  for (const field of [el['new-password'], el['confirm-new-password']]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handleResetSubmit();
    });
  }

  renderMode();
  setView('form');

  // Only a *transition* into ready fires onReady. Firing on every render would
  // bounce an already-signed-in visitor off the landing page the moment it
  // loaded, so they could never look at it again.
  let wasReady = null;

  return {
    render(authState) {
      // A recovery session is a real session (status is still 'signed_in'),
      // but it means "set a new password", not "ready to play" — so it is
      // excluded from `signedIn` here and routed to the reset-new view
      // instead, rather than being handed to onReady like an ordinary visit.
      const signedIn = authState.status === 'signed_in' && authState.isRecovery !== true;

      if (authState.isRecovery === true) {
        setView('reset-new');
      } else if (view === 'reset-new') {
        // Leaving a recovery session (e.g. signed out) drops back to the
        // normal form rather than leaving an orphaned reset screen up.
        setView('form');
      }

      show(el['signed-out'], signedIn === false);
      show(el['signed-in'], signedIn);

      if (signedIn) {
        el['account-email'].textContent = authState.email ?? 'your account';
        setMessage('');
      }

      if (signedIn && wasReady === false && onReady !== null) onReady();
      wasReady = signedIn;
    }
  };
}
