import { describe, expect, test } from 'bun:test';
import { toItem as bensItem } from '../packages/adapters/src/bensbargains.js';
import { toItem as dealcatcherItem } from '../packages/adapters/src/dealcatcher.js';
import {
  cleanUrl,
  extractCode,
  extractDiscount,
  extractPrice,
  storeFields,
} from '../packages/adapters/src/dealcodes.js';
import { toItem as dealnewsItem } from '../packages/adapters/src/dealnews.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import { toItem as redditItem } from '../packages/adapters/src/redditdeals.js';
import { toItem as slickdealsItem } from '../packages/adapters/src/slickdeals.js';
import { normaliseItem, xmlItems } from '../packages/core/src/adapter.js';

// The seed module reaches the database package, which reads the environment at
// import. It needs the variable to exist, not to connect: nothing here queries.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* Items exactly as the five feeds returned them on 2026-09-12. */
const SLICKDEALS = `<rss><channel><item>
  <title><![CDATA[$399 Only ! Tapo RV50 Pro Omni Robot Vacuum and Mop with Self-Emptying Dock]]></title>
  <link>https://slickdeals.net/f/20004234-399-only-tapo-rv50-pro?utm_source=rss&amp;utm_content=ht&amp;utm_medium=RSS2</link>
  <description>For sale $499, but you can make it even lower $100 more with code : 100RV50
To $399 Only!</description>
  <content:encoded><![CDATA[<div><img src="https://static.slickdealscdn.com/attachment/1/7/300x300/21573252.thumb" alt="x" height="300" width="300"></div><br /><div>Thumb Score: +5 </div><div>For sale $499, but you can make it even lower $100 more with code : 100RV50 <br />
<a href="https://slickdeals.net/click?sdfib=1&amp;lno=2" target="_blank" data-product-forum="Hot Deals" data-cta="outclick" data-product-exitWebsite="amazon.com" data-store-id="1" data-store-slug="amazon" data-aps-asin="B0GWPCYKJ2" rel="nofollow">https://www.amazon.com/dp/B0GWPCYKJ2</a></div>]]></content:encoded>
  <pubDate>Sat, 12 Sep 2026 04:49:05 +0000</pubDate>
  <category  domain="https://slickdeals.net/" >Popular Deals</category>
  <dc:creator>LiveByGrace</dc:creator>
  <guid >thread-20004234</guid>
</item><item>
  <title><![CDATA[Kellogg's 27.1-Oz Raisin Bran Original Giant Size Breakfast Cereal $4.30 w/ S&S]]></title>
  <link>https://slickdeals.net/f/19984428-kellogg-s-raisin-bran?utm_source=rss&amp;utm_content=fp&amp;utm_medium=RSS2</link>
  <description><![CDATA[Price is $4.06 with full subscribe and save discount]]></description>
  <content:encoded><![CDATA[<div><img src="https://static.slickdealscdn.com/attachment/1/1/300x300/21526647.thumb"></div><br /><div>Thumb Score: +27 </div><div>Price is $4.06 with full subscribe and save discount <br />
<a href="https://slickdeals.net/click?sdfib=1&amp;lno=1" data-product-exitWebsite="amazon.com" data-store-id="1" data-store-slug="amazon" rel="nofollow">https://www.amazon.com/gp/product</a></div>]]></content:encoded>
  <pubDate>Sat, 12 Sep 2026 18:22:14 +0000</pubDate>
  <category  domain="https://slickdeals.net/" >Frontpage Deals</category>
  <dc:creator>Tel06c</dc:creator>
  <guid >thread-19984428</guid>
</item></channel></rss>`;

const DEALNEWS = `<rss><channel><item>
   <title>Grusign Queen Velvet Platform Bed Frame for $108 + free shipping</title>
   <link>https://www.dealnews.com/Grusign-Queen-Velvet-Platform-Bed-Frame-for-108-free-shipping/22142668.html?iref=rss</link>
   <description>&lt;img src='https://d.dlnws.com/64599/x.jpeg?h=125&amp;w=125' style='float: left;'&gt;&lt;div class=&quot;snippet summary&quot;&gt;&lt;p&gt;Anyone wanting a sturdy platform bed will appreciate the velvet frame, and at $107.72, that's $22 off the $129.99 list price. Deal ends September 17.  Buy Now at Amazon&lt;/p&gt;&lt;/div&gt;</description>
   <guid>https://www.dealnews.com/22142668.html?iref=rss</guid>
   <pubDate>Sat, 12 Sep 2026 14:07:18 -0400</pubDate>
   <dealnews:retailer>Amazon</dealnews:retailer>
   <dealnews:expires>2026-09-18T00:00:00-04:00</dealnews:expires>
   <dealnews:dealType>deal</dealnews:dealType>
   <dealnews:category>Beds</dealnews:category>
   <dealnews:staffPick>true</dealnews:staffPick>
   <dealnews:price currency="USD">107.72</dealnews:price>
   <media:content url="https://d.dlnws.com/64599/x.jpeg?h=125&amp;w=125" medium="image" height="125" width="125"/>
  </item></channel></rss>`;

const DEALCATCHER = `<rss><channel><item>
  <title>Amazon - Artificial Cedar Fir Garland 6 Foot $19.19</title>
  <pubDate>Sat, 12 Sep 2026 17:49:24 GMT</pubDate>
  <link>https://www.dealcatcher.com/deals/occasions/christmas/artificial-cedar-fir-garland-foot-395280?utm_source=rss</link>
  <guid>https://www.dealcatcher.com/deals/occasions/christmas/artificial-cedar-fir-garland-foot-395280?utm_source=rss</guid>
  <description><![CDATA[ <img src="https://images.dealcatcher.com/offers/d76f01ac.jpeg" alt="Amazon Deal"> ]]></description>
</item></channel></rss>`;

const BENS = `<rss><channel><item>
<title><![CDATA[ Dusor 19-in-1 Men's Survival Kit   $18 at Amazon]]></title>
<description><![CDATA[<img align="right" src="//cdn.bensimages.com/media/img/450/257282.webp" /><p>Amazon with LHIM has the Dusor 19-in-1 Men's Survival Kit for $30 - 45% off with coupon code <b>4ZLBV9H8</b> at checkout = <b>$18</b> with free shipping on $35+ or with Prime.</p>]]></description>
<link>https://bensbargains.com/bargain/dusor-19-in-1-men-s-survival-kit-1079611/#rss</link>
<guid isPermaLink="false">https://bensbargains.com/bargain/dusor-19-in-1-men-s-survival-kit-1079611/</guid>
<pubDate>Sat, 12 Sep 2026 11:53:00 -0700</pubDate>
</item></channel></rss>`;

const REDDIT = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><author><name>/u/dealposter</name><uri>https://www.reddit.com/user/dealposter</uri></author><category term="deals" label="r/deals"/><content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Use promo code SAVE20 at checkout.&lt;/p&gt;&lt;/div&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/dealposter&quot;&gt; /u/dealposter &lt;/a&gt;</content><id>t3_1w438gn</id><link href="https://www.reddit.com/r/deals/comments/1w438gn/best_buy_20_off/" /><updated>2026-09-01T06:00:37+00:00</updated><published>2026-09-01T06:00:37+00:00</published><title>[Best Buy] 20% off headphones</title></entry></feed>`;

describe('the deals collection', () => {
  test('exists, and every adapter in it is registered there', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('deals');
    for (const name of ['slickdeals', 'dealnews', 'dealcatcher', 'bensbargains', 'reddit-deals']) {
      const a = adapterByName(name);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('deals');
      expect(a.needsEnv ?? []).toEqual([]);
    }
  });

  test('ships a coupon-codes feed, which is what a coupon site reads', () => {
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'deals');
    expect(feeds.map((f) => f.slug)).toEqual(
      expect.arrayContaining(['coupon-codes', 'editors-picks', 'amazon-deals', 'all-deals']),
    );
    expect(feeds.find((f) => f.slug === 'coupon-codes').query.tags).toEqual(['coupon-code']);
  });

  test('source and feed slugs collide with nothing already seeded', () => {
    const slugs = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('reading a code out of prose', () => {
  test('finds the code after every way a deal desk announces one', () => {
    expect(extractCode('45% off with coupon code 4ZLBV9H8 at checkout')).toBe('4ZLBV9H8');
    expect(extractCode('make it lower with code : 100RV50')).toBe('100RV50');
    expect(extractCode('Use promo code SAVE20 at checkout.')).toBe('SAVE20');
    expect(extractCode('$10 off w/ code "FIRSTGRUV15"')).toBe('FIRSTGRUV15');
    expect(extractCode('Code: BOGO-FALL applies')).toBe('BOGO-FALL');
  });

  test('does not mistake a word, a price or a percentage for a code', () => {
    expect(extractCode('no code needed, discount applied at checkout')).toBeNull();
    expect(extractCode('Enter code at checkout for FREE SHIPPING')).toBeNull();
    expect(extractCode('use code 20 for 20% off')).toBeNull();
    expect(extractCode('Coupon Codes For Sale')).toBeNull();
    expect(extractCode('clip the coupon on the page')).toBeNull();
    expect(extractCode('')).toBeNull();
  });

  test('reads a discount as a percentage or dollars off, and never a price as a discount', () => {
    expect(extractDiscount('$30 - 45% off with code')).toEqual({ type: 'percent', value: 45 });
    expect(extractDiscount("that's $22 off the list price")).toEqual({ type: 'fixed', value: 22 });
    expect(extractDiscount('Robot Vacuum $399 Only')).toBeNull();
    expect(extractPrice('Cereal $4.30 w/ S&S')).toBe(4.3);
    expect(extractPrice('TV for $1,299.99')).toBe(1299.99);
    expect(extractPrice('free shipping')).toBeNull();
  });

  test('the store key is the same however the feed spelt the store', () => {
    expect(storeFields('Best Buy').storeKey).toBe('best-buy');
    expect(storeFields('BEST BUY').storeKey).toBe('best-buy');
    expect(storeFields('amazon', { domain: 'www.Amazon.com', slug: 'amazon' })).toEqual({
      store: 'amazon',
      storeKey: 'amazon',
      storeDomain: 'amazon.com',
    });
    expect(storeFields(null)).toEqual({ store: null, storeKey: null, storeDomain: null });
  });

  test('a feed link loses its tracking and keeps its path', () => {
    expect(cleanUrl('https://www.dealnews.com/x/22142668.html?iref=rss')).toBe(
      'https://www.dealnews.com/x/22142668.html',
    );
    expect(cleanUrl('https://slickdeals.net/f/1?utm_source=rss&utm_medium=RSS2&page=2')).toBe(
      'https://slickdeals.net/f/1?page=2',
    );
    expect(cleanUrl('not a url')).toBe('not a url');
  });
});

describe('a Slickdeals post', () => {
  const [coded, front] = xmlItems(SLICKDEALS, 'item').map((it) => slickdealsItem(it, 'popular'));

  test('names its store from the outbound link, and the code from the text', () => {
    expect(coded.externalId).toBe('thread-20004234');
    expect(coded.kind).toBe('coupon');
    expect(coded.data).toMatchObject({
      store: 'amazon',
      storeKey: 'amazon',
      storeDomain: 'amazon.com',
      code: '100RV50',
      asin: 'B0GWPCYKJ2',
      score: 5,
      price: 399,
      author: 'LiveByGrace',
      category: 'Popular Deals',
    });
    expect(coded.url).toBe('https://slickdeals.net/f/20004234-399-only-tapo-rv50-pro');
    expect(coded.imageUrl).toMatch(/^https:\/\/static\.slickdealscdn\.com\//);
    expect(coded.tags).toEqual(
      expect.arrayContaining(['slickdeals', 'amazon', 'coupon-code', 'popular']),
    );
  });

  test('a front page deal without a code is a deal, tagged as the editors’ pick', () => {
    expect(front.kind).toBe('deal');
    expect(front.data.code).toBeNull();
    expect(front.data.score).toBe(27);
    expect(front.tags).toContain('editors-pick');
    expect(normaliseItem(front)).not.toBeNull();
  });
});

describe('a DealNews item', () => {
  const [item] = xmlItems(DEALNEWS, 'item').map(dealnewsItem);

  test('reads the retailer, price, expiry, category and staff pick as fields', () => {
    expect(item.externalId).toBe('dealnews-22142668');
    expect(item.kind).toBe('deal');
    expect(item.data).toMatchObject({
      store: 'Amazon',
      storeKey: 'amazon',
      price: 107.72,
      currency: 'USD',
      expires: '2026-09-18T00:00:00-04:00',
      dealType: 'deal',
      category: 'Beds',
      staffPick: true,
      discountType: 'fixed',
      discountValue: 22,
    });
    expect(item.url).toBe(
      'https://www.dealnews.com/Grusign-Queen-Velvet-Platform-Bed-Frame-for-108-free-shipping/22142668.html',
    );
    expect(item.imageUrl).toMatch(/^https:\/\/d\.dlnws\.com\//);
    expect(item.summary).toMatch(/^Anyone wanting a sturdy platform bed/);
    expect(item.summary).not.toMatch(/<|&lt;/);
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'dealnews',
        'amazon',
        'dollars-off',
        'editors-pick',
        'category:beds',
      ]),
    );
  });
});

describe('a Dealcatcher item', () => {
  const [item] = xmlItems(DEALCATCHER, 'item').map(dealcatcherItem);

  test('takes the store from the title prefix and the section from the path', () => {
    expect(item.externalId).toBe('dealcatcher-395280');
    expect(item.title).toBe('Artificial Cedar Fir Garland 6 Foot $19.19 at Amazon');
    expect(item.data).toMatchObject({
      store: 'Amazon',
      storeKey: 'amazon',
      price: 19.19,
      category: 'occasions',
    });
    expect(item.imageUrl).toBe('https://images.dealcatcher.com/offers/d76f01ac.jpeg');
    expect(item.url).not.toMatch(/utm_/);
  });
});

describe('a Ben’s Bargains item', () => {
  const [item] = xmlItems(BENS, 'item').map(bensItem);

  test('reads the code, the discount, the price and the store the house style names', () => {
    expect(item.externalId).toBe('bensbargains-1079611');
    expect(item.kind).toBe('coupon');
    expect(item.data).toMatchObject({
      store: 'Amazon',
      storeKey: 'amazon',
      code: '4ZLBV9H8',
      discountType: 'percent',
      discountValue: 45,
      price: 18,
    });
    expect(item.imageUrl).toBe('https://cdn.bensimages.com/media/img/450/257282.webp');
    expect(item.tags).toEqual(
      expect.arrayContaining(['bensbargains', 'amazon', 'coupon-code', 'percent-off']),
    );
  });
});

describe('a Reddit post', () => {
  const [item] = xmlItems(REDDIT, 'entry').map((e) => redditItem(e, 'deals'));

  test('is a post with the store from the bracket and the code from the body', () => {
    expect(item.externalId).toBe('t3_1w438gn');
    expect(item.kind).toBe('post');
    expect(item.data).toMatchObject({
      store: 'Best Buy',
      storeKey: 'best-buy',
      code: 'SAVE20',
      discountType: 'percent',
      discountValue: 20,
      subreddit: 'deals',
      author: 'dealposter',
    });
    expect(item.summary).toBe('Use promo code SAVE20 at checkout.');
    expect(item.tags).toEqual(
      expect.arrayContaining(['reddit', 'best-buy', 'coupon-code', 'r-deals']),
    );
  });
});
