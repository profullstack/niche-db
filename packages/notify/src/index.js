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

/**
 * A feed was suggested: tell every admin the deployment lists, one mail each,
 * with the URL and the queue to decide it in. Best effort -- a lost mail loses
 * nothing, the row is in the queue regardless -- and never thrown at the
 * submitter, who is the last person who should see a Resend error.
 */
export async function sendSubmissionNotice({ feedUrl, collection, note, probe, queueUrl }) {
  const admins = config.adminEmails ?? [];
  if (!admins.length || !config.mail.enabled) return 0;
  const what = probe?.title ? `${probe.title} — ${feedUrl}` : feedUrl;
  const looks = probe?.looksLikeFeed ? 'looks like a feed' : 'did not parse as a feed';
  const text = [
    `Someone suggested a feed for ${config.siteName}:`,
    '',
    what,
    collection ? `Collection: ${collection}` : null,
    note ? `Note: ${note}` : null,
    probe ? `Probe: HTTP ${probe.status ?? '?'}, ${looks}` : null,
    '',
    `Decide it here: ${queueUrl}`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  const html = `<p>Someone suggested a feed for ${esc(config.siteName)}:</p><p><a href="${esc(feedUrl)}">${esc(what)}</a></p>${collection ? `<p>Collection: ${esc(collection)}</p>` : ''}${note ? `<p>Note: ${esc(note)}</p>` : ''}${probe ? `<p>Probe: HTTP ${esc(probe.status ?? '?')}, ${looks}</p>` : ''}<p><a href="${esc(queueUrl)}">Decide it in the queue</a></p>`;
  let sent = 0;
  for (const to of admins) {
    try {
      await deliverMail({
        to,
        subject: `[${config.siteName}] feed suggested: ${feedUrl}`,
        text,
        html,
      });
      sent += 1;
    } catch (err) {
      console.error('[notify] submission notice failed:', err.message);
    }
  }
  return sent;
}

/** Tell a submitter what became of their suggestion, when they left an address. */
export async function sendSubmissionDecision({ email, feedUrl, approved, note, resultUrl }) {
  if (!email || !config.mail.enabled) return false;
  const verdict = approved ? 'is now live' : 'was not added';
  const text = [
    `Your feed suggestion for ${config.siteName} ${verdict}:`,
    '',
    feedUrl,
    note ? `\n${note}` : null,
    resultUrl ? `\n${resultUrl}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
  const html = `<p>Your feed suggestion for ${esc(config.siteName)} ${verdict}:</p><p>${esc(feedUrl)}</p>${note ? `<p>${esc(note)}</p>` : ''}${resultUrl ? `<p><a href="${esc(resultUrl)}">${esc(resultUrl)}</a></p>` : ''}`;
  try {
    await deliverMail({
      to: email,
      subject: `[${config.siteName}] your feed suggestion ${verdict}`,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error('[notify] submission decision mail failed:', err.message);
    return false;
  }
}

export async function sendLoginLink({ email, url }) {
  return deliverMail({
    to: email,
    subject: `Your ${config.siteName} sign-in link`,
    text: `Tap to sign in:\n\n${url}\n\nThe link works once and expires in 20 minutes.\nIf you did not ask for it, ignore this email.`,
    html: `<p><a href="${esc(url)}">Tap to sign in to ${esc(config.siteName)}</a></p><p>The link works once and expires in 20 minutes. If you did not ask for it, ignore this email.</p>`,
  });
}
