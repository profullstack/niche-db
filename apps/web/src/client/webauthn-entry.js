import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

// Exposed as a global so public/app.js stays a plain script with no module graph.
window.SimpleWebAuthnBrowser = { startAuthentication, startRegistration };
