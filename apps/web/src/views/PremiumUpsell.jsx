import { config } from '@nichedb/config';

/** One offer, shown only to people who have not already bought the perks. */
export const PremiumUpsell = ({ plan = 'free', source = 'home' }) =>
  plan === 'free' ? (
    <aside class="premium-upsell" aria-label="Premium membership">
      <div>
        <strong>A little more Premium. ${(config.premium.dayCents / 100).toFixed(2)}/day.</strong>
        <p>No ads or tracking. The Lounge, award credits, themes and higher data limits.</p>
      </div>
      <a class="cta button" href={`/premium?from=${encodeURIComponent(source)}#plans`}>
        Explore Premium
      </a>
    </aside>
  ) : null;
