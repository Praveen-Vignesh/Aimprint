// The account panel, wherever it appears. The markup stays in each page so the
// landing pages can style it however they like; this module finds its controls
// by `data-auth` *inside the root it is handed*, never by global id. That is
// what lets two differently-styled pages share one implementation, and what
// stops a second panel on a page from colliding with the first.
//
// `auth` supplies the async account actions (onSignIn / onSignUp /
// onGoogleSignIn / onSignOut), each resolving to a result object
// ({ error } / { needsConfirmation } / {}) that this module displays. The seam
// is deliberate: this file never imports supabase.js, so it stays drivable from
// a test harness with plain stubs.
//
// `onReady` fires when the account becomes signed in — the landing pages use it
// to move the player on to the game.
//
// There is no consent step. The checkbox, its block and the six data-auth hooks
// it needed were removed on 2026-10-18 along with the rest of the consent
// system; agreement is now part of creating an account and is stated in the
// sign-up card's copy.

const REQUIRED = [
  'signed-out',
  'signed-in',
  'email',
  'password',
  'signin',
  'signup',
  'google',
  'message',
  'account-email',
  'signout'
];

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

  function setBusy(busy) {
    el.signin.disabled = busy;
    el.signup.disabled = busy;
    el.google.disabled = busy;
  }

  function credentials() {
    return { email: el.email.value.trim(), password: el.password.value };
  }

  async function handleSignIn() {
    const { email, password } = credentials();
    if (email === '' || password === '') {
      setMessage('Enter your email and password.', true);
      return;
    }

    setBusy(true);
    setMessage('Signing in…');
    const result = await auth.onSignIn({ email, password });
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
    else setMessage('');
  }

  async function handleSignUp() {
    const { email, password } = credentials();
    if (email === '' || password === '') {
      setMessage('Enter an email and password to create an account.', true);
      return;
    }

    setBusy(true);
    setMessage('Creating your account…');
    const result = await auth.onSignUp({ email, password });
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
    else if (result && result.needsConfirmation) {
      setMessage('Account created. Check your email to confirm, then sign in.');
    } else setMessage('');
  }

  async function handleGoogleSignIn() {
    setBusy(true);
    setMessage('Redirecting to Google…');
    const result = await auth.onGoogleSignIn();
    setBusy(false);

    if (result && result.error) setMessage(result.error, true);
  }

  el.signin.addEventListener('click', handleSignIn);
  el.signup.addEventListener('click', handleSignUp);
  el.google.addEventListener('click', handleGoogleSignIn);
  el.signout.addEventListener('click', () => auth.onSignOut());

  // Enter submits, because a two-field form that ignores Enter feels broken.
  // Sign in rather than sign up: it is the non-destructive of the two, and a
  // returning player is the common case on a form already holding an address.
  for (const field of [el.email, el.password]) {
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') handleSignIn();
    });
  }

  // Only a *transition* into ready fires onReady. Firing on every render would
  // bounce an already-signed-in visitor off the landing page the moment it
  // loaded, so they could never look at it again.
  let wasReady = null;

  return {
    render(authState) {
      const signedIn = authState.status === 'signed_in';

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
