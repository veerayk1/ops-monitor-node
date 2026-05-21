/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  SINGLE SOURCE OF TRUTH FOR THE PROJECT BRAND                        ║
 * ║                                                                      ║
 * ║  Change the four lines below and the entire platform — sidebar,      ║
 * ║  page titles, browser-tab titles, startup log, email subjects,       ║
 * ║  email footers, the test-email body — all update automatically.      ║
 * ║                                                                      ║
 * ║  The only places that need a SEPARATE manual update on rename:       ║
 * ║     • package.json    → "name" and "description" fields              ║
 * ║     • README.md       → headings, hero block, mentions               ║
 * ║     • README-VISION.md → headings and mentions                       ║
 * ║                                                                      ║
 * ║  Everything else (Node code, EJS views, emails) reads from here.     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

export const BRAND = {
  /** Display name shown in the sidebar, page titles, browser tab, emails. */
  name: 'Argus AI',

  /** Short tagline shown under the brand name in the sidebar. */
  tagline: 'the hundred-eyed watchman',

  /** Long tagline used in the email footer and other prose contexts. */
  longTagline: 'the hundred-eyed watchman for your operations',

  /** Version label shown next to the brand in the sidebar. */
  version: 'v0.2',
} as const;

export type Brand = typeof BRAND;
