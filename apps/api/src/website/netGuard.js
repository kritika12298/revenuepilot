import dns from 'node:dns';
import net from 'node:net';

/**
 * SSRF protection. Only public unicast addresses may be fetched. The check
 * runs inside the socket's DNS lookup (guardedLookup), so the address that is
 * validated is the address that is connected to: no DNS-rebinding gap.
 */

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  // ::/96 covers IPv4-compatible addresses (e.g. ::7f00:1 = 127.0.0.1) as well as :: and ::1.
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, prefix, 'ipv6');

export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(ip)) return false;
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

export class UrlRejectedError extends Error {
  constructor(message) {
    super(message);
    this.code = 'URL_REJECTED';
  }
}

/** Static checks on a URL before any network activity. */
export function validatePublicUrl(raw, { allowHosts = [] } = {}) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new UrlRejectedError('Enter a full website address, e.g. https://example.com');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UrlRejectedError('Only http and https websites can be analysed');
  if (url.username || url.password) throw new UrlRejectedError('Website addresses may not contain credentials');
  if (url.port && !['80', '443'].includes(url.port)) throw new UrlRejectedError('Only standard web ports (80 and 443) are allowed');
  if (url.href.length > 2048) throw new UrlRejectedError('That address is too long');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (allowHosts.includes(host)) return url;
  if (!host || host === 'localhost' || !host.includes('.') && !net.isIP(host)) throw new UrlRejectedError('Use a public website address');
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new UrlRejectedError('Private or internal hostnames are not allowed');
  if (net.isIP(host) && !isPublicAddress(host)) throw new UrlRejectedError('Private, local or reserved IP addresses are not allowed');
  url.hash = '';
  return url;
}

/** dns.lookup replacement that refuses non-public answers. */
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : (options ?? {});
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      const e = new Error(`Refusing to connect: ${hostname} resolves to a private or reserved address`);
      e.code = 'EBLOCKED';
      return cb(e);
    }
    if (opts.all) return cb(null, addresses);
    return cb(null, addresses[0].address, addresses[0].family);
  });
}
