import { isIP } from 'node:net';

/**
 * Shared infrastructure that is never one actor and is never listed or
 * approved: Cloudflare's published ranges (cloudflare.com/ips) and the big
 * public resolvers. Used by the abuse.ch adapter and the /traffic review.
 */
const SHARED_V4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '1.1.1.1/32',
  '1.0.0.1/32',
  '8.8.8.8/32',
  '8.8.4.4/32',
  '9.9.9.9/32',
  '149.112.112.112/32',
  '208.67.222.222/32',
  '208.67.220.220/32',
];
const SHARED_V6 = [
  '2400:cb00:',
  '2606:4700:',
  '2803:f800:',
  '2405:b500:',
  '2405:8100:',
  '2a06:98c',
  '2c0f:f248:',
];

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

function inV4Cidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(v4ToInt(base) / size) * size;
  const n = v4ToInt(ip);
  return n >= start && n < start + size;
}

/** Is this address shared infrastructure (a CDN, a public resolver)? */
export function isSharedIp(ip) {
  if (isIP(ip) === 4) return SHARED_V4.some((c) => inV4Cidr(ip, c));
  const lower = String(ip).toLowerCase();
  return SHARED_V6.some((p) => lower.startsWith(p));
}
