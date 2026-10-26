import { sql } from '@nichedb/db';
import { createProfileStore } from '@profullstack/profile';

/**
 * The shared Profullstack profile (@profullstack/profile): email, names, company
 * domain, job title and LinkedIn, in user_profiles keyed by users.id (migration
 * 0039). Private to the account. Not the public `profiles` directory.
 */
export const profiles = createProfileStore(sql);

/** The session user as the package's handlers want it: `{ id, email }` or null. */
export const profileUser = (c) => {
  const user = c.get('user');
  return user ? { id: user.id, email: user.email } : null;
};
