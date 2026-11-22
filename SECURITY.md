# Security policy

Browser Agent controls a real browser, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub instead:
**Security → Report a vulnerability** on this repository
(<https://github.com/tmalik22/BrowserExtension/security/advisories/new>).

Include what you found, how to reproduce it (a minimal page is ideal), and the impact. You'll get a reply as soon as possible, and credit in the fix if you'd like it.

## What's in scope

- Ways for **page content** to make the agent act without the approvals the user has switched on (prompt injection that bypasses the policy, swapped targets, dialogs, frames…).
- Bypasses of the URL policy (blocked sites, private networks), the upload folder, or disabled optional tools.
- Leaks of API keys or the pairing token, or unauthenticated access to the local server.
- The CAPTCHA helper acting outside the challenge widget.

## Out of scope

- Behaviour in **"Never ask"** mode, or with approval switches the user turned off. That's the user's choice.
- A model doing something unwise that the policy correctly asked the user about, and the user approved.
- The browser's own "started debugging this browser" bar (a Chrome requirement).

## Supported versions

Fixes go into the latest release on `main`.
