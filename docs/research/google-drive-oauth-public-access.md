# Google Drive OAuth: what public access needs

Research note for Stage 3 (saving reports to Google Drive). It records what
Google's documentation says, checked on 2026-10-25. It changes nothing: the
OAuth scopes, consent screen, test users, domain and Vercel settings stay as
they are.

AuditFlow requests one Google scope, `https://www.googleapis.com/auth/drive.file`,
through the Google Identity Services token client in the browser
(`frontend/lib/google-drive.ts`). That flow returns access tokens only; the app
does not request or store refresh tokens.

## A. Scope classification and verification

**Confirmed by Google**

- `drive.file` is listed under **Non-sensitive scopes** ("Create new Drive
  files, or modify existing files, that you open with an app").
  Source: [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- On the same page, non-sensitive scopes need only *basic* OAuth app
  verification. Sensitive scopes need additional verification, and restricted
  scopes need restricted-scope verification, plus a security assessment when
  the data is stored on or sent through servers.
- Non-sensitive does not mean no review for a public app. Brand information
  (app name, logo, home page, privacy policy) is verified separately, and the
  app's name and logo appear on the consent screen only "once brand and scopes
  are verified".
  Sources: [Production readiness overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview?hl=en),
  [OAuth app verification policy compliance](https://developers.google.com/identity/verification/authentication-policy-compliance)

**Project recommendation**

- Keep `drive.file` as the only Drive scope. A broader Drive scope
  (sensitive or restricted) would bring in the heavier verification paths
  above.

## B. Testing mode

**Confirmed by Google**

- An External app in **Testing** status is "limited to up to 100 test users
  listed in the OAuth consent screen".
  Source: [Manage app audience](https://support.google.com/cloud/answer/15549945?hl=en)
- A test user's authorization expires seven days after consent. A refresh
  token issued to such an app also expires in 7 days, unless the app requests
  only basic sign-in scopes (`openid`, `userinfo.email`, `userinfo.profile` or
  their OpenID Connect equivalents). `drive.file` is not one of those, so the
  7-day limit applies to AuditFlow.
  Sources: [Manage app audience](https://support.google.com/cloud/answer/15549945?hl=en),
  [Using OAuth 2.0 to access Google APIs: refresh token expiration](https://developers.google.com/identity/protocols/oauth2?hl=en)
- Refresh-token or authorization expiry is separate from access-token
  lifetime. Access tokens are short-lived by design ("Access tokens have
  limited lifetimes"), and each token response states its own lifetime in
  `expires_in`. The 7-day limit is about how long the user's *grant* lasts
  before they must consent again.

**What this means for AuditFlow (project reading, not a Google statement)**

- AuditFlow has no refresh tokens, so in Testing mode the practical effect is
  that a test user sees Google's consent screen again once their 7-day
  authorization has expired. Separately, each access token expires after its
  own `expires_in`, and the app requests a new one.
- Testing mode is enough for internal review with up to 100 listed users. It
  is not a route to public access.

## C. Verified domain and production readiness

**Confirmed by Google**
(Source, unless another is named: [OAuth app verification policy compliance](https://developers.google.com/identity/verification/authentication-policy-compliance);
overview: [Production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview?hl=en))

- "Only use domains you own": the guide asks developers to identify any
  domain they don't own, because they would be unable to verify it. (The
  maintainer's brief says "own or are authorized to use"; Google's page says
  only "own".)
- Verification "requires verification of all domains associated with your
  project's home page, privacy policy, terms of service, authorized redirect
  URIs, or authorized JavaScript origins". Ownership is proven in
  [Google Search Console](https://search.google.com/search-console), using a
  Google Account that is an Owner or Editor of the Cloud project.
- The domains in use are the ones summarized in the **Authorized domains**
  section of the OAuth consent screen. A domain verified with Google can be
  added there as its Top Private Domain (for example `example.com`), which
  then covers its subdomains and pages.
  Source: [Manage OAuth App Branding](https://support.google.com/cloud/answer/15549049?hl=en)
- Every production app that uses OAuth 2.0 must have a **publicly accessible
  home page**, hosted on a verified domain, that describes what the app does
  and links to its privacy policy (and to its terms of service, if it has
  them).
- Brand information (app name, logo, links) must accurately represent the
  app, and the project's owners, editors and user support email must be kept
  up to date.

**Project recommendations**

- Do not use a shared hosting subdomain that AuditFlow cannot verify in
  Search Console as the long-term production domain.
- Before moving to In production, prepare: a public home page describing
  AuditFlow, a privacy policy (and terms, if used) on the same verified
  domain, and an accurate app name, logo and support email.

**Unresolved decisions (not made in code)**

- The long-term production domain for AuditFlow. Until it is chosen, the app
  stays in Testing mode with listed test users.
- Who owns the Search Console property and the Google Cloud project
  contacts.
- Whether AuditFlow will publish terms of service in addition to a privacy
  policy.
