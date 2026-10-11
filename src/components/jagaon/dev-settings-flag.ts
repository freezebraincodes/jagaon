/**
 * Web Speech (owner-approved scope 2026-10-11): the build-time developer-settings flag. `NEXT_PUBLIC_JAGAON_DEV_SETTINGS=on` (exact value)
 * shows the System settings section (the voice provider selector) in More; anything else, or unset (the default), hides it. Not a
 * secret: Next inlines the value into the browser bundle at build time, so a change needs a rebuild. Hiding the section is not
 * authentication: the section holds no privileged control (it only picks among server-enabled providers; every start still needs the
 * provider's consent, the passcode and the server's checks). This module is the one browser-side environment read.
 */
export const DEV_SETTINGS_ENABLED: boolean = process.env.NEXT_PUBLIC_JAGAON_DEV_SETTINGS === "on";
