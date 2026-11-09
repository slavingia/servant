# Civic Research Studio code used by Servant

These files are copied unchanged from Civic Research Studio 0.3.24
(`ash-webb/research-studio`, `src/`), which is CC0 1.0 public domain. Servant's
study readouts use them so their numbers match Research Studio's results
dashboard for the same Qualtrics exports: the Qualtrics import
(`qualtrics-import.js`, `qualtrics-embed.js`), event flattening (`shared.js`),
the A/B analysis (`ab-results.js`, `abstats.js`, `plan.js`, `method-plans.js`,
`methods.js`) and the Word writer (`docx.js`).

Don't edit them here. When Servant supports a new Research Studio version
(`SUPPORTED_RESEARCH_STUDIO_VERSION` in `research-studio-compat.ts`), copy the
same files from that version's `src/` again, keeping the two header lines, and
run `npm test`.

`src/lib/fixtures/` holds Research Studio's synthetic test exports and demo
study (made-up data, no participants), used by the readout tests.
