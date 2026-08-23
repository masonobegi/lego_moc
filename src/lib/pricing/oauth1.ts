/**
 * OAuth 1.0a request signing (HMAC-SHA1), server-side only.
 *
 * BrickLink's Store API uses "one-legged" OAuth 1.0a: all four credentials
 * (consumer key/secret and token value/secret) are issued to the same user, so
 * there is no redirect flow. Requests are signed and the parameters are sent in
 * the Authorization header.
 *
 * Reference: docs/RESEARCH.md section 6.
 */

import { createHmac, randomBytes } from 'node:crypto';

export interface OAuth1Credentials {
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly tokenValue: string;
  readonly tokenSecret: string;
}

/**
 * RFC 5849 percent-encoding: unreserved characters are A-Z a-z 0-9 - . _ ~
 * and everything else is encoded. `encodeURIComponent` leaves ! * ' ( ) alone,
 * so those are fixed up.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildParameterString(params: Record<string, string>): string {
  return Object.keys(params)
    .map((key) => [percentEncode(key), percentEncode(params[key]!)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export interface SignedRequest {
  readonly url: string;
  readonly authorizationHeader: string;
}

/**
 * Sign a GET request. `baseUrl` must have no query string; `query` holds the
 * query parameters, which take part in the signature.
 */
export function signGetRequest(
  baseUrl: string,
  query: Record<string, string>,
  credentials: OAuth1Credentials,
  nonceOverride?: string,
  timestampOverride?: number,
): SignedRequest {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonceOverride ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestampOverride ?? Math.floor(Date.now() / 1000)),
    oauth_token: credentials.tokenValue,
    oauth_version: '1.0',
  };

  const allParams = { ...query, ...oauthParams };
  const signatureBase = [
    'GET',
    percentEncode(baseUrl),
    percentEncode(buildParameterString(allParams)),
  ].join('&');

  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(credentials.tokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const authorizationHeader =
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key]!)}"`)
      .join(', ');

  const queryString = Object.keys(query)
    .map((key) => `${percentEncode(key)}=${percentEncode(query[key]!)}`)
    .join('&');

  return {
    url: queryString.length > 0 ? `${baseUrl}?${queryString}` : baseUrl,
    authorizationHeader,
  };
}
