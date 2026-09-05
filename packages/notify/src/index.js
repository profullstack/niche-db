import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { createEmailer } from '@profullstack/emailer';
import webpush from 'web-push';

if (config.push.enabled) {
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
}

/** Outbound mail goes through @profullstack/emailer (Resend, zero deps). */
let emailer = null;
function mailer() {
  if (!config.mail.enabled) throw new Error('RESEND_API_KEY not configured');
  if (!emailer)
    emailer = createEmailer({ resendApiKey: config.mail.resendKey, defaultFrom: config.mail.from });
  return emailer;
}

async function deliverMail(opts) {
  const r = await mailer().send({ from: config.mail.from, ...opts });
  if (!r.sent) throw new Error(`mail not sent: ${r.error ?? 'unknown'}`);
  return true;
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Web push, one notification per device, for a batch of new items on one feed.
 * A 404 or 410 means the browser discarded the subscription, so the row is
 * disabled rather than retried forever.
 */
export async function sendPush(target, { feed, items }) {
  if (!config.push.enabled) throw new Error('VAPID keys not configured');
  const first = items[0];
  const more = items.length - 1;
  const payload = JSON.stringify({
    title: feed.name,
    body: more > 0 ? `${first.title} and ${more} more` : first.title,
    tag: `feed-${feed.id}`,
    url: `${config.siteUrl}/f/${feed.slug}`,
  });
  const results = await Promise.allSettled(
    target.push_subscriptions.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 3600 },
      ),
    ),
  );
  let delivered = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      delivered++;
      continue;
    }
    const code = r.reason?.statusCode;
    if (code === 404 || code === 410) {
      await q.disablePushSubscription(target.push_subscriptions[i].endpoint);
    }
  }
  if (delivered === 0) throw new Error('no live push endpoint');
  return delivered;
}

/** A digest of what a feed produced since the reader was last told. */
export async function sendEmail(target, { feed, items }) {
  const shown = items.slice(0, 20);
  const itemUrl = (i) => i.url ?? `${config.siteUrl}/i/${i.id}`;
  const text = [
    `New in ${feed.name}:`,
    '',
    ...shown.map((i) => `- ${i.title}\n  ${itemUrl(i)}`),
    ...(items.length > 20 ? [`…and ${items.length - 20} more`] : []),
    '',
    `${config.siteUrl}/f/${feed.slug}`,
    '',
    `Stop these: ${config.siteUrl}/settings`,
  ].join('\n');
  const html = [
    `<p>New in <a href="${config.siteUrl}/f/${feed.slug}">${esc(feed.name)}</a>:</p>`,
    '<ul>',
    ...shown.map(
      (i) =>
        `<li><a href="${esc(itemUrl(i))}">${esc(i.title)}</a>${i.summary ? `<br><small>${esc(i.summary.slice(0, 200))}</small>` : ''}</li>`,
    ),
    '</ul>',
    items.length > 20 ? `<p>…and ${items.length - 20} more</p>` : '',
    `<p><small><a href="${config.siteUrl}/settings">Stop these</a></small></p>`,
  ].join('\n');
  return deliverMail({
    to: target.email,
    subject: `${feed.name}: ${items.length === 1 ? items[0].title : `${items.length} new`}`,
    text,
    html,
    headers: { 'List-Unsubscribe': `<${config.siteUrl}/settings>` },
  });
}

export async function sendLoginLink({ email, url }) {
  return deliverMail({
    to: email,
    subject: `Your ${config.siteName} sign-in link`,
    text: `Tap to sign in:\n\n${url}\n\nThe link works once and expires in 20 minutes.\nIf you did not ask for it, ignore this email.`,
    html: `<p><a href="${esc(url)}">Tap to sign in to ${esc(config.siteName)}</a></p><p>The link works once and expires in 20 minutes. If you did not ask for it, ignore this email.</p>`,
  });
}
