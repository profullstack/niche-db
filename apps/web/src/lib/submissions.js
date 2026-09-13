import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import * as subs from '@nichedb/db/submissions';
import { sendSubmissionDecision, sendSubmissionNotice } from '@nichedb/notify';
import { enqueueRun } from '@nichedb/queue';
import { cleanEmail, looksLikeFeed, normaliseFeedUrl, titleOf } from './feed-url.js';
import { addSource, Denied, isAdmin } from './service.js';

/**
 * Suggesting a feed, and deciding one. Shared by the form, the API, and the
 * MCP tool, so all three enforce the same rules: anyone may ask, only an
 * admin makes the deployment fetch.
 */

/** Pending suggestions one submitter may hold. */
const MAX_OPEN = 20;
/** How long the look at a suggested URL may take, and how much of it to read. */
const PROBE_MS = 6000;
const PROBE_BYTES = 16 * 1024;

/**
 * Where podcast feeds go on approval. This site's podcasts collection reads
 * rssamplifier's directory rather than crawling shows itself, so the honest
 * way to carry a podcast is to hand the URL to the directory that will.
 */
const RSSAMPLIFIER_URL = (process.env.RSSAMPLIFIER_URL ?? 'https://rssamplifier.com').replace(
  /\/$/,
  '',
);

/**
 * One bounded look at the URL, for the admin's benefit. Never throws, never
 * decides anything: a feed behind a slow host still lands in the queue.
 */
export async function probeFeed(url) {
  const out = { ok: false, status: null, contentType: null, looksLikeFeed: false, title: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': `${config.siteName} (+${config.siteUrl})`,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    out.status = res.status;
    out.ok = res.ok;
    out.contentType = res.headers.get('content-type');
    const reader = res.body?.getReader();
    let head = '';
    if (reader) {
      const dec = new TextDecoder();
      while (head.length < PROBE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        head += dec.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => {});
    }
    out.looksLikeFeed = looksLikeFeed(head);
    out.title = titleOf(head);
  } catch (err) {
    out.error = String(err?.message ?? err).slice(0, 200);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Take a suggestion. Returns `{ submission, duplicate }`: duplicate is true
 * when the URL was already waiting, which is an answer, not an error.
 */
export async function submitFeed({
  user = null,
  url,
  collection = null,
  note = null,
  email = null,
}) {
  const feedUrl = normaliseFeedUrl(url);
  if (!feedUrl)
    throw new Denied(
      'That is not a URL a crawler can fetch. Paste the feed address, starting with https://.',
      400,
    );

  const col = collection ? await q.getCollection(String(collection)) : null;
  if (collection && !col) throw new Denied(`No collection named ${collection}`, 400);

  const cleanNote = note ? String(note).trim().slice(0, 1000) : null;
  const contact = user?.email ?? cleanEmail(email);

  const existing = await subs.pendingByUrl(feedUrl);
  if (existing) return { submission: existing, duplicate: true };

  const open = await subs.pendingBySubmitter({ userId: user?.id ?? null, email: contact });
  if (open >= MAX_OPEN)
    throw new Denied(
      `You already have ${open} suggestions waiting. Let those be decided first.`,
      429,
    );

  const probe = await probeFeed(feedUrl);
  const submission = await subs.createSubmission({
    feedUrl,
    collectionId: col?.id ?? null,
    note: cleanNote,
    userId: user?.id ?? null,
    email: user ? null : contact,
    probe,
  });
  if (!submission) {
    // Lost a race with an identical suggestion between the check and the insert.
    return { submission: await subs.pendingByUrl(feedUrl), duplicate: true };
  }

  sendSubmissionNotice({
    feedUrl,
    collection: col?.name ?? null,
    note: cleanNote,
    probe,
    queueUrl: `${config.siteUrl}/admin/submissions`,
  }).catch(() => {});

  return { submission, duplicate: false };
}

/**
 * Approve: a podcast feed is forwarded to the directory this site's podcasts
 * collection reads; anything else becomes a `newsfeed` source in the chosen
 * collection and is fetched at once. The row is only closed once that
 * succeeded, so a failed hand-off leaves it in the queue to try again.
 */
export async function approveSubmission(
  admin,
  id,
  { collection, section = 'world', note = null } = {},
) {
  if (!isAdmin(admin)) throw new Denied('Admins only.', 403);
  const sub = await subs.getSubmission(id);
  if (!sub) throw new Denied('No such suggestion.', 404);
  if (sub.status !== 'pending') throw new Denied('That suggestion was already decided.', 409);

  const slug = String(collection ?? sub.collection_slug ?? 'news');
  const col = await q.getCollection(slug);
  if (!col) throw new Denied(`No collection named ${slug}`, 400);

  let sourceId = null;
  let forwardedTo = null;
  let resultUrl = null;

  if (col.slug === 'podcasts') {
    const res = await fetch(`${RSSAMPLIFIER_URL}/api/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ url: sub.feed_url }),
      redirect: 'manual',
    }).catch((err) => {
      throw new Denied(`rssamplifier did not answer: ${err.message}`, 502);
    });
    if (res.status >= 400) throw new Denied(`rssamplifier refused it (HTTP ${res.status}).`, 502);
    forwardedTo = new URL(RSSAMPLIFIER_URL).host;
    resultUrl = `${config.siteUrl}/c/podcasts`;
  } else {
    const sec =
      String(section ?? 'world')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '') || 'world';
    let host = sub.feed_url;
    try {
      host = new URL(sub.feed_url).hostname;
    } catch {}
    const source = await addSource(admin, {
      adapter: 'newsfeed',
      collection: col.slug,
      name: sub.probe?.title ? String(sub.probe.title).slice(0, 120) : host,
      config: { feeds: [`${sec}=${sub.feed_url}`] },
    });
    await enqueueRun(source.id).catch(() => {});
    sourceId = source.id;
    resultUrl = `${config.siteUrl}/s/${source.slug}`;
  }

  const decided = await subs.decideSubmission({
    id: sub.id,
    approve: true,
    actorId: admin.id,
    note,
    sourceId,
    forwardedTo,
  });
  if (!decided) throw new Denied('That suggestion was decided by someone else just now.', 409);

  sendSubmissionDecision({
    email: sub.user_email ?? sub.email,
    feedUrl: sub.feed_url,
    approved: true,
    note,
    resultUrl,
  }).catch(() => {});

  return { submission: decided, sourceId, forwardedTo, resultUrl };
}

export async function rejectSubmission(admin, id, { note = null } = {}) {
  if (!isAdmin(admin)) throw new Denied('Admins only.', 403);
  const sub = await subs.getSubmission(id);
  if (!sub) throw new Denied('No such suggestion.', 404);
  const decided = await subs.decideSubmission({
    id: sub.id,
    approve: false,
    actorId: admin.id,
    note,
  });
  if (!decided) throw new Denied('That suggestion was already decided.', 409);
  sendSubmissionDecision({
    email: sub.user_email ?? sub.email,
    feedUrl: sub.feed_url,
    approved: false,
    note,
    resultUrl: null,
  }).catch(() => {});
  return decided;
}

/** The public shape of a suggestion. No submitter email, no probe error text. */
export function submissionOut(s) {
  return {
    id: s.id,
    feed_url: s.feed_url,
    collection: s.collection_slug ?? null,
    status: s.status,
    created_at: s.created_at,
    decided_at: s.decided_at ?? null,
    source: s.source_slug ?? null,
    forwarded_to: s.forwarded_to ?? null,
  };
}
