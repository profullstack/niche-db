import { expect, test } from 'bun:test';

// Offline and deterministic: the bundled catalog, never the CDN.
process.env.CROSS_PROMO = 'bundled';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { config } = await import('../packages/config/src/index.js');
const { submissionDecisionMail } = await import('../packages/notify/src/index.js');

/**
 * An approved suggestion's mail ends with the "more from the network" block for
 * publishers; a refusal does not; and the block never promotes the sending host.
 */

const base = { email: 'owner@example.com', feedUrl: 'https://blog.example.com/feed.xml' };

test('approved decision mail carries the publisher promo block after the message', async () => {
  const mail = await submissionDecisionMail({
    ...base,
    approved: true,
    resultUrl: `${config.siteUrl}/f/blog`,
  });
  expect(mail.text).toContain('is now live');
  expect(mail.text).toContain('rssamp.com');
  expect(mail.text).toContain('mynaposter.com');
  expect(mail.text.indexOf('mynaposter.com')).toBeGreaterThan(mail.text.indexOf('/f/blog'));
  expect(mail.html).toContain('mynaposter.com');
  expect(mail.html).toContain('From the <a href="https://profullstack.com"');
});

test('the promo never links the sending deployment itself', async () => {
  const saved = config.siteUrl;
  config.siteUrl = 'https://rssamp.com';
  try {
    const mail = await submissionDecisionMail({ ...base, approved: true });
    expect(mail.text).toContain('mynaposter.com');
    expect(mail.text).not.toContain('https://rssamp.com');
    expect(mail.html).not.toContain('https://rssamp.com');
  } finally {
    config.siteUrl = saved;
  }
});

test('a refused suggestion gets no promo', async () => {
  const mail = await submissionDecisionMail({ ...base, approved: false, note: 'not a feed' });
  expect(mail.text).toContain('was not added');
  expect(mail.text).not.toContain('mynaposter.com');
  expect(mail.html).not.toContain('Profullstack');
});
