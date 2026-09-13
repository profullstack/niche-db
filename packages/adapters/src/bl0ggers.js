import { marketplaceAdapter } from './marketplacefeeds.js';

/**
 * bl0ggers.com: the human-in-the-loop publishing platform's board, where a
 * publication asks for writing and editing and a writer offers it. Same two
 * feeds as d0rz, same code upstream (the channel title still reads "d0rz asks"
 * live, checked 2026-09-12), so the parser is shared. Both feeds were empty
 * that day; an empty feed is a run with nothing to write, not a failure.
 */
export const bl0ggers = marketplaceAdapter({
  name: 'bl0ggers',
  base: 'https://bl0ggers.com',
  title: 'bl0ggers asks and offers',
  description:
    'Asks and offers from the bl0ggers.com board: publications asking for posts, edits and reviews, and writers offering them, each with its category, city and the budget or rate lifted out of the post. Two keyless RSS feeds, fifty newest each.',
});
