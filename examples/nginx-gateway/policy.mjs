// Nginx njs and Node share this policy. No forwarded header is an authority for
// deciding whether a request's actual Host and Origin are allowed.
function allowsRequest(headers, publicOrigin) {
  // The default njs engine has no WHATWG URL global. Accept only a serialized
  // HTTPS DNS/IPv4 origin, with an optional non-default port and no path.
  const endpoint =
    /^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?$/.exec(
      publicOrigin,
    );
  if (!endpoint || endpoint[2] === '443' || Number(endpoint[2]) > 65535) return false;

  function values(name) {
    return headers
      .filter(function (header) {
        return header[0].toLowerCase() === name;
      })
      .map(function (header) {
        return header[1];
      });
  }
  const hosts = values('host');
  if (hosts.length !== 1) return false;
  const host = hosts[0].toLowerCase();
  const expected = endpoint[1] + (endpoint[2] ? ':' + endpoint[2] : '');
  if (host !== expected && !(!endpoint[2] && host === expected + ':443')) return false;

  const origins = values('origin');
  // Absence is valid for machine clients. Empty, null, duplicate, malformed or
  // different-origin headers are present-invalid and must receive HTTP 403.
  return origins.length === 0 || (origins.length === 1 && origins[0] === publicOrigin);
}

function check(request) {
  return allowsRequest(request.rawHeadersIn, process.env.MCP_PUBLIC_ORIGIN) ? 'allow' : 'deny';
}

export default { check, allowsRequest };
