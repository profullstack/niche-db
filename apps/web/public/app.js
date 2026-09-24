/* Progressive enhancement only. Every control on the site is a plain form; this
   file localises times, wires passkeys and push, and asks before deleting. */

const postJson = (url, body, { timeoutMs } = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutMs && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });

function say(el, message, kind = 'info') {
  if (!el) return;
  el.textContent = message;
  el.className = `feedback ${kind}`;
  el.hidden = false;
}

/* ---------------------------------------------------------------- times -- */

function localiseTimes() {
  const chosen = document.body.dataset.tz || undefined;
  const opts = { timeZone: chosen };
  for (const t of document.querySelectorAll('time[data-local]')) {
    const d = new Date(t.getAttribute('datetime'));
    if (Number.isNaN(d.getTime())) continue;
    const day = t.querySelector('[data-local-day]');
    const time = t.querySelector('[data-local-time]');
    if (day)
      day.textContent = d.toLocaleDateString('en-US', {
        ...opts,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    if (time)
      time.textContent = d.toLocaleTimeString('en-US', {
        ...opts,
        hour: 'numeric',
        minute: '2-digit',
      });
  }
  for (const t of document.querySelectorAll('time[data-relative]')) {
    const d = new Date(t.getAttribute('datetime'));
    if (Number.isNaN(d.getTime())) continue;
    t.title = d.toLocaleString('en-US', opts);
    t.textContent = relative(d);
  }
  const label = document.querySelector('[data-tz-label]');
  if (label) label.textContent = chosen ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function relative(d) {
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === 'second') {
      const n = Math.round(diff / secs);
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(n, unit);
    }
  }
  return '';
}

async function reportTimezone() {
  const known = document.body.dataset.knownTz;
  if (known === undefined || known === null) return;
  if (known && known !== 'UTC') return;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || zone === known) return;
  await postJson('/api/timezone', { timezone: zone }).catch(() => {});
}

/* -------------------------------------------------------------- passkeys -- */

async function initPasskeys() {
  const { startAuthentication, startRegistration } = window.SimpleWebAuthnBrowser ?? {};
  const signin = document.getElementById('passkey-signin');
  const signinMsg = document.getElementById('passkey-signin-msg');
  if (signin) {
    if (!window.PublicKeyCredential || !startAuthentication) signin.hidden = true;
    else
      signin.addEventListener('click', async () => {
        signin.disabled = true;
        try {
          const options = await (await postJson('/api/auth/passkey/authenticate/options')).json();
          const resp = await startAuthentication({ optionsJSON: options });
          const res = await postJson('/api/auth/passkey/authenticate/verify', resp);
          if (res.ok) {
            location.href = new URLSearchParams(location.search).get('next') || '/following';
            return;
          }
          const body = await res.json().catch(() => ({}));
          say(signinMsg, body.error ?? 'That passkey was not recognised.', 'error');
        } catch (err) {
          if (err?.name !== 'NotAllowedError')
            say(signinMsg, `Could not sign in: ${err?.message ?? err}`, 'error');
        } finally {
          signin.disabled = false;
        }
      });
  }
  const add = document.getElementById('add-passkey');
  const addMsg = document.getElementById('add-passkey-msg');
  if (add) {
    if (!window.PublicKeyCredential || !startRegistration) {
      add.hidden = true;
      return;
    }
    add.addEventListener('click', async () => {
      add.disabled = true;
      say(addMsg, 'Follow your browser or password manager prompt…', 'info');
      try {
        const optRes = await postJson('/api/auth/passkey/register/options');
        if (!optRes.ok) return say(addMsg, 'Could not start registration. Sign in again.', 'error');
        const attResp = await startRegistration({ optionsJSON: await optRes.json() });
        const res = await postJson('/api/auth/passkey/register/verify', attResp);
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          say(addMsg, 'Passkey added.', 'ok');
          setTimeout(() => location.reload(), 600);
          return;
        }
        say(addMsg, body.error ?? 'The server rejected that passkey.', 'error');
      } catch (err) {
        if (err?.name === 'NotAllowedError') say(addMsg, 'Cancelled.', 'info');
        else if (err?.name === 'InvalidStateError')
          say(addMsg, 'This device already has a passkey here.', 'info');
        else say(addMsg, `Could not add a passkey: ${err?.message ?? err}`, 'error');
      } finally {
        add.disabled = false;
      }
    });
  }
}

/* ------------------------------------------------------------------ push -- */

/**
 * The house push client (@profullstack/notifications), served by the app at a
 * stable path and imported on first use. It says why push is unavailable when it
 * is, and fetches the server's public key at runtime rather than trusting one
 * written into the page.
 */
const loadPushClient = () => import('/vendor-notifications.js');

async function registerSw() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    await navigator.serviceWorker.register('/sw.js');
    return await navigator.serviceWorker.ready;
  } catch (err) {
    console.warn('sw registration failed', err);
    return null;
  }
}

async function initPush() {
  const btn = document.getElementById('push-enable');
  const msg = document.getElementById('push-msg');
  if (!btn) return;
  let push;
  try {
    push = await loadPushClient();
  } catch (err) {
    console.warn('push client failed to load', err);
    btn.hidden = true;
    say(msg, 'Push is not available here.', 'info');
    return;
  }
  // The reason, not a generic "not available": HTTPS, iPhone Home Screen, blocked
  // in settings, or a server with no key.
  const support = push.pushSupport();
  const unavailable = support.supported
    ? await push
        .getVapidPublicKey()
        .then(() => null)
        .catch((err) => err?.message ?? String(err))
    : support.message;
  if (unavailable) {
    btn.hidden = true;
    say(msg, unavailable, 'info');
    return;
  }
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const reg = await registerSw();
      if (!reg) throw new Error('service worker unavailable');
      // Asks permission, uses the key fetched above, and replaces a subscription
      // made with an older key.
      const sub = await push.subscribe({ serviceWorkerUrl: '/sw.js' });
      const res = await postJson('/api/push/subscribe', sub);
      if (!res.ok) throw new Error(`server said ${res.status}`);
      say(msg, 'Push enabled on this device.', 'ok');
    } catch (err) {
      say(msg, `Could not enable push: ${err?.message ?? err}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/* --------------------------------------------------------------- confirm -- */

function initConfirm() {
  for (const f of document.querySelectorAll('form[data-confirm]')) {
    f.addEventListener('submit', (e) => {
      if (!confirm(f.dataset.confirm)) e.preventDefault();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  localiseTimes();
  reportTimezone();
  initPasskeys();
  initPush();
  initConfirm();
  registerSw();
});
