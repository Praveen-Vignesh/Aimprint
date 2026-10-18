// Entry point for the landing pages. Deliberately does NOT import three.js or
// game.js: `/` is the SEO target and the page most first-time visitors see, so
// it ships the Supabase client and nothing else. The game's ~190 kB of renderer
// loads on /play, where it is actually used.
import {
  onAuthChange,
  signIn,
  signUp,
  signOut,
  signInWithGoogle,
  validateSession
} from './supabase.js';
import { createAuthPanel } from './ui/auth-panel.js';

const PLAY_URL = '/play';

const root = document.getElementById('auth-panel');

if (root !== null) {
  const panel = createAuthPanel({
    root,
    auth: {
      onSignIn({ email, password }) {
        return signIn({ email, password });
      },
      onSignUp({ email, password }) {
        return signUp({ email, password });
      },
      onSignOut() {
        return signOut();
      },
      onGoogleSignIn() {
        return signInWithGoogle();
      }
    },
    // Fires only on the TRANSITION into signed in, so finishing the form
    // carries you into the game while an already-signed-in visitor can still
    // read the page — firing on every render would bounce them off it the
    // moment it loaded.
    onReady() {
      window.location.href = PLAY_URL;
    }
  });

  const modal = document.getElementById('auth-modal');
  let ready = false;

  // `modal-open` on <body> restores the native cursor and hides the crosshair
  // element for as long as the dialog is up — see the cursor rules in the page.
  // Driven from the dialog's own `close` event as well as the buttons, so Esc
  // and a backdrop click put the crosshair back too.
  function setModalOpen(open) {
    document.body.classList.toggle('modal-open', open);
  }

  modal.addEventListener('close', () => setModalOpen(false));

  // "Start training" means one thing and does the right one of two: an account
  // that can already play goes straight to the game, everyone else gets the
  // form. The button never changes its name, because the promise is the same.
  function openAuth() {
    if (ready) {
      window.location.href = PLAY_URL;
      return;
    }
    if (modal.open === false) {
      modal.showModal();
      setModalOpen(true);
    }
  }

  for (const trigger of document.querySelectorAll('[data-modal="open"]')) {
    trigger.addEventListener('click', openAuth);
  }

  for (const trigger of document.querySelectorAll('[data-modal="close"]')) {
    trigger.addEventListener('click', () => modal.close());
  }

  // Clicking the backdrop closes. <dialog> gives Esc and focus trapping for
  // free but treats the backdrop as part of the element, so the only way to
  // tell them apart is to check whether the click landed outside the box.
  modal.addEventListener('click', (event) => {
    if (event.target !== modal) return;
    const box = modal.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (inside === false) modal.close();
  });

  onAuthChange((state) => {
    panel.render(state);
    ready = state.status === 'signed_in';
  });

  // supabase-js trusts the session it restores from localStorage without asking
  // the server, so a deleted or revoked account would render as signed in here
  // and then fail on /play. This is the round trip that corrects it.
  validateSession();
}
