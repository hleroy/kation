# Security policy

## Supported versions

Only the latest release receives security fixes. A vulnerability that affects
only the `main` branch, and no release, is fixed in the open like any other bug.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:
[Report a vulnerability](https://github.com/hleroy/kation/security/advisories/new).

Please describe one vulnerability per report and include:

- the Kation version, and your distribution and Plasma version;
- the steps to reproduce it, ideally with a minimal proof of concept;
- what an attacker gains, and what they need first (local access, a shared
  folder, a position on the network, …).

If you used an AI tool to find or write up the issue, say so, and check its
claims against the code before you send the report.

## What happens next

I acknowledge reports within 48 hours and aim to release a fix within 7 days
for High severity, 30 days for Moderate, and in the next release for Low. The
fix ships with a GitHub security advisory crediting you, unless you prefer not.

## Severity levels

Severity depends mainly on what an attacker gains and who the attacker can be.
I may adjust it to the real-world impact.

- **High:** remote code execution (through Proton's servers, the network, or a
  shared file and its name); leaking the session, keys or decrypted files;
  bypassing end-to-end encryption; writing files outside the sync folder.
- **Moderate:** secrets readable by other local users; kationd reachable beyond
  the session bus; sharing, public links or deletions the user did not ask for.
- **Low:** crashes from crafted data; non-secret data in the user's own logs;
  issues that need an uncommon setup.

## Out of scope

- Programs already running as the user, or as root: kationd trusts every
  caller on the session bus (see [DEVNOTES.md](DEVNOTES.md#architecture)).
- `KATION_CREDENTIALS_STORE=unsafe_file`, a plain-text store for tests.
- Proton's servers, apps and SDK: report them to Proton's
  [bug bounty](https://proton.me/security/bug-bounty).
- Dependency vulnerabilities with no demonstrated impact on Kation.
