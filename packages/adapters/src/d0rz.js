import { marketplaceAdapter } from './marketplacefeeds.js';

/**
 * d0rz.com: rides, delivery, errands, pet care and home help, asked for by
 * customers and offered by providers. The parser lives in marketplacefeeds.js
 * because bl0ggers publishes the same two feeds from the same code.
 */
export const d0rz = marketplaceAdapter({
  name: 'd0rz',
  base: 'https://d0rz.com',
  title: 'd0rz asks and offers',
  description:
    'Customer asks and provider offers from the d0rz.com local-services board: rides, delivery, errands, pet care, home help and more, each with its category, city and the budget or rate lifted out of the post. Two keyless RSS feeds, fifty newest each.',
});
