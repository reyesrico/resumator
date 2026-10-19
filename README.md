# Resumator

A **browser-only** resume studio at <https://reyesrico.github.io/resumator/>.

No hosted backend, Render account, paid hosting, Python installation, or LibreOffice installation is required. GitHub Pages serves the application and its WebAssembly engine. Documents are processed on your device.

## Use it

1. Open the site in a current Safari, Chrome, Edge, or Firefox browser. WebAssembly, IndexedDB, and modern JavaScript are required; the PDF engine downloads approximately 10 MB on first use. Mobile PDF editing uses device memory and can take time.
2. Enter **your own Anthropic API key** in the password field. The app holds it only in page memory, never in IndexedDB, localStorage, sessionStorage, URLs, source code, or GitHub Actions secrets. **Refreshing, navigating away, or closing the page clears the key.** “Clear key” removes it immediately. API calls go directly from your browser to `https://api.anthropic.com`.
3. Open a **PDF or DOCX**, up to 10 MB. Each upload is a new local version; the newest is selected on your next visit. Use the selector for an older basis. Tailored documents never replace originals.
4. Paste the job description (100–25,000 characters). Job sites usually block browser cross-origin access, so automatic job-link import is not offered. No third-party proxy is used.
5. Consent to send resume text and job requirements to Anthropic, then tailor. Each click makes one billable Claude request. Editing and regenerating a preview do not make AI calls.
6. Review the exact removed/added words, concrete explanations, and enclosing paragraph context. Reject or edit suggestions, then update the preview.
7. For a PDF source, compare the previews and approve the current measured one-page PDF before downloading. Unsupported edits and overflow block final downloads; the app does not rebuild the template.
8. For DOCX, review and download an explicitly labeled **draft**. Open it in Word or Pages and verify one page there. Browser previews cannot certify Microsoft Word pagination; the app does not pretend otherwise.

**Free hosting does not mean free AI usage.** Anthropic API billing is separate from a Claude chat subscription. The default model is `claude-sonnet-5-5`; API model availability depends on your account.

## Local storage and backups

- Original bytes, extracted text, version metadata, and filenames stay in this website's **IndexedDB on the current device/browser**. They are not sent to GitHub or a Resumator server.
- Generated previews, edits, approval state, job descriptions, and the API key are temporary page-memory state. Reloading restores the latest original, not the old review.
- **Download original backup** saves an untouched copy through the browser's Files/Downloads workflow. On iPhone, use the browser's download/share controls to save to Files. A website cannot silently write to an arbitrary folder.
- Website-data clearing, private browsing, browser eviction, device loss, or changing the website origin can remove or hide the local library. Download your originals; IndexedDB is not your only backup.
- Other devices, browser profiles, and the local development URL have separate libraries. There is no account or cross-device synchronization.
- Delete a version under **Manage this version**. This deletes its browser record and temporary output, falling back to the newest remaining original. It does not remove downloaded copies, backups, or Anthropic-held information.
- Existing originals in the previous local server's ignored `.resumator-data/` directory are not automatically uploaded to the published site. Download them from the old local version or use the original files, then open them once in the browser app.

## Design preservation and format limits

### PDF

MuPDF runs locally as WebAssembly. The app extracts independently styled regions and captures original font glyphs, baselines, colors, and placement. Replacements use those actual glyphs; a custom subset font's Unicode mapping is explicitly retained in the generated overlay, avoiding font substitution and unsearchable text.

Text is redacted only in supported original regions. Page images, graphics, dimensions, and unrelated text remain in the original PDF. Shorter text moves subsequent inline runs and supported filled underlines by the measured width difference, including real link targets. Unsupported glyphs, ambiguous font mappings, rotated/offset geometry, overlapping text, and line overflow block the edit instead of silently changing the design. Complex decorations are protected rather than reconstructed. Always compare the full preview.

Replacements must fit their original line widths; browser mode does not shrink text or reflow paragraphs across lines. It never removes pages to force a one-page resume. Scans require OCR before use. A PDF source produces PDF only, not a reconstructed Word copy.

### DOCX

DOCX archives are edited locally. Character-level differences preserve unchanged Word runs and style definitions. Linked paragraphs, fields, tabs, line breaks, tracked changes, and other unsupported controls are protected. Macros, embedded executable objects, external templates/assets, XML entities, and expanded archives over 40 MB are rejected.

The sandboxed browser preview is **approximate**. Missing fonts, Word text boxes, pagination, and application-specific layout can render differently in Word/Pages. DOCX downloads are drafts, not page-certified final documents. No automatic DOCX-to-PDF conversion is provided. Legacy `.doc` is unsupported; save as DOCX or a one-page PDF first.

### Facts

Claude is instructed to use the resume as the sole factual source. Independent validation blocks changes to numeric facts, dates, metrics, and recognized experience qualifiers, including `10+ years` becoming `5+ years`. No-op suggestions are removed. These checks cannot semantically verify every skill or assertion: human review remains necessary.

## API-key and privacy boundary

Your in-memory key is visible to code running on the page, potentially malicious browser extensions, and someone controlling your device. Browser-side keys cannot be made equivalent to a secret held on a trusted server. Use only your own key, monitor API spending, and revoke it in the Anthropic Console if exposed. Do not use this app on an untrusted/shared device.

There are no analytics or third-party document-upload services. Anthropic receives resume text, context, job text, and the key only when you explicitly submit a tailoring request with consent. Anthropic's API retention and billing terms apply; deleting browser files does not delete provider-held data. Requests use a fixed Anthropic endpoint, not a user-supplied proxy.

GitHub Pages may record ordinary website requests according to GitHub's privacy policies. No API key is injected at build time. The content security policy restricts network calls to the site itself and Anthropic, and all executable assets, fonts, and WebAssembly are bundled rather than loaded from a CDN.

## Development and publishing

Requires Node.js 20.19+ or a current supported LTS.

```sh
npm ci
npm run dev
```

Vite prints the local URL. No `.env` file or backend is needed for this browser application.

```sh
npm run build
npm start
```

This serves the static production build on <http://127.0.0.1:3001>. Relative asset paths support the `/resumator/` GitHub Pages project URL.

The Pages workflow builds `dist/` and publishes it after pushes to `main`. It uses no Anthropic secret. Environment files, downloaded resumes, and the previous server's private storage are excluded from Git. Obsolete Render deployment configuration has been removed.

The earlier Node/Python implementation and its tests remain in `server/` for reference and local advanced processing; the browser entry point does not contact its API. Its ignored environment file and document library are untouched. Existing server-specific dependencies are retained for those tests, not required hosting services.

## Validation and licensing

```sh
npx vitest run tests/browser-pdf.test.ts tests/browser-word.test.ts tests/review.test.ts
npm run build
```

Focused browser-engine checks cover original-glyph edits, unchanged pixels outside edited lines, inline link/underline reflow, URI retention, overflow refusal, unsupported glyphs, Word style preservation, and fact protection. Browser validation also checks device persistence, key clearing, previews, and download gates without billable model calls.

MuPDF.js uses **AGPL-3.0-or-later** terms (or a separate commercial license). Review dependency licensing before distributing a modified version or integrating it elsewhere. The project is published with an AGPL-3.0-or-later license to match the open-source browser engine.
