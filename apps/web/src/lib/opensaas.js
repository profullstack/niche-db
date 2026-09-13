/**
 * OpenSaaS (logicsrc.com/opensaas): what this deployment says about the way
 * in and the way out of its plans, built from the same config the pricing
 * page and the gates read, so the file cannot say a price the checkout does
 * not charge.
 *
 * Every action listed here is real: the page exists and the endpoint exists,
 * and an OpenAccess bearer with the named scope may call it for the account
 * its email maps to. Absence is unstated: a deployment without payments
 * lists no subscribe and no cancel, because there is nothing to buy or end.
 */
import { config } from '@nichedb/config';
import * as account from '@nichedb/db/account';
import { termOptions } from '@nichedb/premium';
import { bearerPrincipal } from './openaccess.js';
import { Denied } from './service.js';

export const SCOPES = {
  subscribe: 'billing:subscribe',
  cancel: 'billing:cancel',
  export: 'account:export',
  delete: 'account:delete',
};

const PERIODS = { day: 'day', month: 'month', year: 'year' };

/** The plans as the checkout sells them: prepaid terms, none of which renews itself. */
export function plans() {
  const site = config.siteUrl;
  const out = [];
  if (config.premium.enabled) {
    for (const term of termOptions({
      dayCents: config.premium.dayCents,
      monthCents: config.premium.monthCents,
      yearCents: config.premium.yearCents,
    })) {
      out.push({
        id: `premium-${term.id}`,
        name: `Premium, ${term.label}`,
        price: term.cents / 100,
        period: PERIODS[term.id] ?? term.id,
        renews: false,
        url: term.id === 'day' ? `${site}/crawl` : `${site}/premium`,
        includes: [
          'no ads',
          'no tracker',
          'the Lounge',
          'monthly credits',
          'early access collections',
        ],
        status: 'active',
      });
    }
  }
  if (config.membership.enabled) {
    out.push({
      id: 'pro',
      name: 'Pro',
      price: config.membership.priceCents / 100,
      period: `${config.membership.termDays} days`,
      renews: false,
      url: `${site}/pro`,
      includes: ['everything in Premium', 'unlimited feeds', 'add sources', 'API key'],
      status: 'active',
    });
  }
  return out;
}

/** The descriptor, as data. */
export function descriptor() {
  const site = config.siteUrl;
  const api = (path) => ({ method: 'POST', url: `${site}${path}` });
  const actions = {};
  const billing = config.premium.enabled || config.membership.enabled;
  if (billing) {
    actions.subscribe = {
      page: `${site}/premium`,
      api: api('/api/v1/billing/subscribe'),
      scope: SCOPES.subscribe,
      steps: 2,
      requires: ['account', 'payment'],
    };
    actions.cancel = {
      page: `${site}/account/billing`,
      api: api('/api/v1/billing/cancel'),
      scope: SCOPES.cancel,
      steps: 1,
      confirm: 'click',
      effective: 'immediate',
      refund: 'none',
    };
  }
  if (config.mail.enabled) {
    // Notification mail carries List-Unsubscribe pointing at /settings, where
    // the follows that send it are turned off one by one. A page, not an
    // endpoint: there is no one switch for all mail yet.
    actions.unsubscribe = { page: `${site}/settings`, steps: 2, list_unsubscribe: true };
  }
  actions.export = {
    page: `${site}/account/export`,
    api: api('/api/v1/account/export'),
    scope: SCOPES.export,
    steps: 1,
    formats: ['json'],
    within: 'PT0S',
  };
  actions.delete = {
    page: `${site}/account/delete`,
    api: api('/api/v1/account/delete'),
    scope: SCOPES.delete,
    steps: 2,
    confirm: 'email',
    effective: 'immediate',
    retention: 'P0D',
  };
  return {
    opensaas: '0.1',
    service: {
      name: config.siteName,
      web: site,
      operator: 'https://logicsrc.com/.well-known/openprofile.md',
      openaccess: `${site}/.well-known/openaccess.json`,
      support: `${site}/about`,
      terms: `${site}/terms`,
      privacy: `${site}/privacy`,
      currency: config.premium.currency,
    },
    updated: `${new Date().toISOString().slice(0, 13)}:00:00Z`,
    plans: plans(),
    actions,
    policies: billing ? { auto_renew: false, refund: 'none' } : {},
  };
}

/**
 * Who is acting: the signed-in user (cookie or ndb_ key), or the account an
 * OpenAccess bearer with `scope` stands for. A bearer for an email with no
 * account here is refused rather than given one: cancelling, exporting and
 * deleting are things you do to an account that exists.
 */
export async function actor(
  c,
  scope,
  { principal = bearerPrincipal, byEmail = account.userByEmail } = {},
) {
  const user = c.get('user');
  if (user) return { user, via: c.get('viaKey') ? 'key' : 'session' };
  const p = await principal(c);
  if (!p) throw new Denied('Sign in, send an API key, or an OpenAccess bearer.', 401);
  if (!p.scopes.includes(scope)) throw new Denied(`That bearer lacks the ${scope} scope.`, 403);
  if (!p.email) throw new Denied('That bearer names no email, so no account here.', 403);
  const found = await byEmail(p.email);
  if (!found) throw new Denied('No account here for that bearer.', 404);
  return { user: found, via: 'openaccess', principal: p };
}
