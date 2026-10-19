# Resumator

A single-page resume studio that uses the **Anthropic Claude API** to tailor wording to a job description. Users upload PDF, DOC, or DOCX, import a public job-posting URL or paste the description, review proposed changes, and approve a measured one-page result.

## Local setup

Requires Node.js 20.19+ or a supported newer LTS, LibreOffice for Word, and Python 3.10+ with PyMuPDF for layout-preserving PDF editing. `pdf2docx` is used only for optional reconstructed Word exports from PDF.

```sh
npm install
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. Obtain a key from the [Anthropic Console](https://console.anthropic.com/). Claude API usage is billed separately from Claude chat subscriptions. The default model is `claude-sonnet-5-5`; change `ANTHROPIC_MODEL` to a model available to your account. The key is used only by the server, never included in the browser bundle.

Install the document converters on macOS:

```sh
brew install --cask libreoffice
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Set `PDF2DOCX_BIN` in `.env` to the **absolute** path to `.venv/bin/pdf2docx`. Native PDF processing finds Python beside that executable or in the project's `.venv`; override with `PDF_PYTHON_BIN` if needed. `LIBREOFFICE_BIN` defaults to the standard macOS application path or `libreoffice` on other platforms. On Linux, install LibreOffice through your system package manager. Windows requires executable paths and a compatible shell.

```sh
npm run dev
```

Open the URL printed by Vite, normally `http://127.0.0.1:5173`. The API listens on `127.0.0.1:3001`. The page reports missing setup prerequisites explicitly. After changing `.env` or installing converters, restart the app and refresh.

For a local production build:

```sh
npm run build
npm start
```

Open `http://127.0.0.1:3001`. The server intentionally binds to loopback.

## How it works

1. Upload a PDF, legacy DOC, or DOCX (maximum 10 MB) to your private local resume library. Each upload adds a saved version. The newest upload becomes the default basis on your next visit; select an older version whenever needed. Tailored documents never overwrite the original or become a new basis automatically.
2. PDFs stay PDFs: extract text blocks and their original font, size, color, line baselines, and bounds. Split mixed-style blocks into independently editable style regions instead of protecting the entire paragraph. Aligned body lines with a common style remain grouped; inline bold/italic text keeps its own region. Supply the enclosing paragraph as context, but apply each replacement only to its region. Protect linked, rotated, overlapping, or unsupported-font regions individually. Only legacy DOC is converted to DOCX for editing. Scanned resumes need OCR before uploading. Word paragraphs with links, tabs, fields, tracked changes, or line breaks are protected from edits.
3. Import a job URL, or paste at least 100 characters of requirements. Sites requiring login or JavaScript may block import; the app reports that and asks for pasted text.
4. With explicit consent, send the whole resume and job description to Claude. The resume is the factual source of truth; a job's minimum does not replace actual experience. Independently reject edits that alter numeric facts (including `10+` to `5+`, dates, metrics, or percentages) or recognized experience phrases. Report blocked suggestions and retain the original paragraph. Apply the same guard to manual edits. This does not semantically verify every named entity, skill, or claim: user review is still essential.
5. Remove identical and whitespace-only suggestions before counting changes. For DOCX, use character-level edits so unchanged text keeps its exact original style run, rather than redistributing text proportionally. For PDFs, replace only supported text inside its original block bounds using the original font and color, keeping images, graphics, links, page geometry, and unrelated text. No Word reconstruction occurs in the authoritative PDF path.
6. Render Word through LibreOffice and count actual PDF pages. If a result exceeds one page, or PDF wording cannot fit its original area, request a shorter second pass from the original resume. Only then try 3% and 6% reductions. Word adjusts explicit font sizes and paragraph before/after spacing; PDF adjusts only edited text, retaining original line positions. Font sizes are not reduced below 9 pt, nor are already smaller fonts made smaller. Unsupported glyphs, fonts, and overflow block export instead of silently substituting a template. If any PDF edit fails, the preview remains the original and explicitly reports the failure, never a misleading partially edited document.
7. Review wording changes first: removed words are struck through, additions are highlighted, and each change has an explicit reason plus expandable original paragraph context. Then compare simultaneous original/tailored previews, edit or reject suggestions, and regenerate after changes. A revision-specific approval is required before downloading PDF, DOCX, or DOC. Changing the rendered document invalidates approval. For PDF sources, Word downloads require an additional explicit opt-in to layout-changing reconstruction and another page-count check.
8. Block final downloads when the result is not one page. Legacy DOC export is converted back to PDF and page-count checked again.

Tailoring can make two billable Claude requests. Editing suggestions and regenerating previews do not make additional AI requests.

## Design fidelity and one-page limitations

**Unsupported PDF edits are blocked, not rebuilt in another template.** Mixed-font paragraphs are editable through individual style regions; a bold heading or emphasized keyword does not lock the surrounding body text. Linked text, rotated text, genuinely overlapping text, and unreusable fonts stay protected. Embedded subset fonts may not contain the glyphs needed for new wording. Replacements must fit the original line widths and baselines, so an inline region can accept fewer wording changes than a full body paragraph. Original PDF pages are never deleted or reflowed to force one page; start with a one-page PDF.

Custom-encoded embedded TrueType subsets are remapped using each individual PDF font resource's ToUnicode and CIDToGIDMap or supported Macintosh cmap. Original outlines and advance widths are retained; no replacement font is downloaded or substituted. This avoids mixing different subsets that share a family name. Original horizontal text scaling is retained per line. Missing glyphs still block edits rather than being invented.

When text before an inline style or link becomes shorter, subsequent runs on that line move left by the measured width difference. Their original fonts, colors, spacing, baselines, underlines, and URI targets are retained. This keeps inline labels attached instead of leaving gaps at their old absolute positions. Unsupported inline fonts or decorations block the edit rather than silently damaging the design.

Optional PDF-to-Word exports reconstruct layout and may change it; they are labeled separately from the original-layout PDF. Legacy DOC conversion and LibreOffice's Word rendering can also differ from Microsoft Word when fonts are missing. Unchanged Word text retains its existing runs; replacement text inherits a neighboring run's style. Word text boxes and fixed-height table cells can still clip text without increasing page count, so a Word page-count check is **not** a visual overflow detector. Both formats require visual review.

The generated PDF is the authoritative one-page output. DOCX and DOC can reflow when opened on other computers or with different fonts. Documents that still exceed one page after bounded adjustments are blocked, not cropped, stripped of entries, or silently reduced to unreadable text.

## Privacy and deployment boundary

- This is a **local-first MVP**, not a hardened public multi-user service.
- Original uploads, normalized editing sources, original PDF previews, and version metadata are saved on disk until explicitly deleted. The default ignored directory is `.resumator-data/` in the project working directory; override it with `RESUMATOR_DATA_DIR` (use an absolute path for a stable location). Owner subdirectories use `0700` permissions and document records use `0600`; contents are not encrypted at rest. Each save is atomic and completes before upload success is reported. Back up the directory if needed.
- Generated outputs and approval state stay in server memory, expire after 30 minutes of inactivity, and are purged on the next API request or server shutdown. Returning after a restart automatically restores the latest original basis, not a previous tailored output. Job descriptions and suggestions are not persisted.
- **Upload new version** retains older originals. The version selector lets you use an older basis for the current visit. **Manage this version > Delete version permanently** removes that saved record and any in-memory result, falling back to the newest remaining version. Deletion cannot remove OS/cloud backups or provider-held data.
- Conversion uses isolated temporary working directories, removed after each operation. Files and credentials are not intentionally logged.
- Resume text and job requirements are sent to Anthropic only after consent. Anthropic processing and retention are governed by your API account terms; local deletion does not delete provider-held data.
- Browser sessions use HTTP-only, same-site cookies renewed for one year; the cookie identifies your local library across refreshes and server restarts. Use the same browser profile and hostname. Clearing cookies loses access to the associated saved library, but does not delete its files: remove the local data directory manually if you want to clear all libraries. There are no accounts or cross-device sync. Other browser sessions cannot list, read, or delete your documents. Job fetching rejects private/reserved IPs and pins connections to validated addresses, including redirects.
- Public deployment requires authentication, TLS, managed secrets, durable/expiring storage, per-user quotas, monitoring, and sandboxed conversion workers without network access. Native document parsers must not process untrusted public uploads inside a privileged web-server process.
- `pdf2docx` and its transitive dependencies have their own licenses. Review those licenses, especially PyMuPDF's AGPL/commercial terms, before deployment or distribution.

## Validation

```sh
npm test
npm run build
```

Tests cover Claude request/response contracts with a mocked API (no credentials or charges), experience downgrades and altered metrics, removal of no-op suggestions, word diffs, exact unchanged-run preservation, protected paragraphs, Unicode/XML handling, bounded layout adjustments, actual export-gate decisions, session isolation, consent, stale approvals, and job URL restrictions.

Native PDF tests compare rendered pixels before/after a synthetic edit and assert that pixels outside the original text area are identical. They also cover image/link retention, overflow refusal, missing glyphs, mixed-style region editing, adjacent-line and inline-bold preservation, stale region mappings, and byte-identical no-op output. These run when `.venv/bin/python` exists. Real Word converter tests run when both converters are available and otherwise report a skip. Synthetic fixtures do not certify fidelity for every real resume. No real resumes or credentials are included.
