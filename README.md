# PaperFocus

**Question-guided evidence highlighting for research papers**

[简体中文](README.zh-CN.md) · [Presentation script (中文)](docs/paperfocus-talk.zh-CN.md)

PaperFocus is a local-first PDF reader that turns a natural-language question into precise highlights on the original paper. It uses [TypeSafe Jev](https://docs.typesafe.ai/introduction) to score the relevance of candidate passages, then maps the strongest evidence back to its exact page location. It does not generate a replacement summary: the reader remains in control of interpretation.

## Why PaperFocus

Close reading is still necessary when experimental details, qualifications, and source wording matter. Conventional chat workflows require repeated prompts, generated answers, and manual verification against the PDF. PaperFocus shortens that loop:

1. Open a paper.
2. Ask a specific question.
3. Jump directly to the most relevant original sentences, paragraphs, figures, and captions.

## Features

- Drag-and-drop PDF import with local parsing and page rendering.
- Natural-language questions such as “How was the experiment designed?”
- Two-stage retrieval: paragraph screening followed by sentence-level evidence scoring.
- Continuous yellow highlighting based on relative salience within the current analysis.
- Figure-caption evidence grouped as one result; captions are highlighted and matched figures receive a bright, outward-offset dashed frame.
- Original-order and relevance-order result views.
- Adjustable salience threshold, defaulting to 75% and calibrated to retain roughly five primary evidence regions on typical papers.
- Click-to-locate evidence, automatic navigation to the strongest match, 50–200% zoom, and one-, two-, or three-column page layouts.
- Recent-question recall and JSON export.
- Per-question Jev request time, excluding upload and local PDF parsing.

## Architecture

```text
PDF
 └─ local PyMuPDF extraction
     ├─ pages and render coordinates
     ├─ paragraphs and sentences
     └─ figure captions and nearby graphic regions
          ↓
   paragraph screening with Jev
          ↓
   sentence/evidence scoring with Jev
          ↓
   deterministic ranking, grouping, and salience mapping
          ↓
   highlights on the original rendered PDF
```

Jev performs semantic judgments only. Python and browser code own PDF parsing, batching, coordinate mapping, filtering, sorting, thresholds, and rendering. The application calls TypeSafe's native `POST /v1/systemone` endpoint directly; the TypeSafe agent skill is a development aid and is not a runtime dependency.

## Getting started

### Requirements

- Python 3.10 or later
- A TypeSafe API key from the [TypeSafe console](https://console.typesafe.ai/)

### Install and run

```bash
git clone https://github.com/YiLight0/paperfocus.git
cd paperfocus
python -m pip install -r requirements.txt
```

Create `.env` from the included template and add your key:

```env
TYPESAFE_API_KEY=your_key_here
TYPESAFE_MODEL=jev-latest
PORT=8765
MAX_PDF_MB=200
```

Then start the local server:

```bash
python server.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). On Windows, `启动阅读器.cmd` starts the same server.

The key can also be entered temporarily through **Connect Jev** in the interface. Browser-entered keys are kept in server memory and are not written to `.env`. The `.env` file is ignored by Git and is never served over HTTP.

If an explicit network proxy is required, add:

```env
TYPESAFE_PROXY=http://127.0.0.1:7890
```

## How the analysis works

PaperFocus first scores paragraph candidates in parallel. It then evaluates sentences from up to 24 promising paragraphs, retaining at most 64 candidate evidence units and up to four per paragraph before final filtering. Request batches are created from a conservative UTF-8 byte budget; there is no fixed 16-sentence batch limit.

Jev's 0–3 scores are used only to rank evidence for the current question. PaperFocus converts rank and score gaps into a continuous **relative salience** scale. The strongest result is 100%; other percentages are relative to that analysis and are not statistical accuracy or calibrated confidence values.

Nearby evidence on the same page is merged into one location. References, author affiliations, and repeated headers or footers are skipped unless the question explicitly asks for them. If no sentence is precise enough but its paragraph remains relevant, the paragraph can be shown as a fallback.

## Data and timing boundaries

- PDF upload, extraction, rendering, and coordinate calculation occur locally.
- Candidate text and the user's question are sent to the TypeSafe API for scoring.
- Uploaded documents and temporary browser-provided keys remain in server memory and disappear when the server stops.
- The displayed time is accumulated server-observed Jev request time. It excludes upload, local extraction, browser rendering, and front-end scheduling, but it should not be interpreted as isolated GPU inference time.

## Current limitations

- Maximum defaults: 200 MB per PDF, 100 pages, and 5,000 extracted sentences. `MAX_PDF_MB` can change the file-size limit.
- Text must be extractable. Scanned papers require a separate OCR stage.
- Jev currently receives text only. Figure relevance is inferred from captions and layout; PaperFocus does not claim to interpret pixels or chart values.
- Complex multi-panel figures, cross-page captions, equations, tables, abbreviations, and unusual multi-column layouts may be segmented imperfectly.
- The rendered pages provide evidence navigation rather than native PDF text selection.
- Model quality, latency, and thresholds should be evaluated on the target domain before consequential use.

## Tests

Run parsing and request-validation tests:

```bash
python -m unittest discover -s tests -p "test_*.py"
```

The Playwright browser test uses intercepted model responses to verify upload, controls, navigation, highlighting, sorting, and responsive layout without spending API credits:

```bash
node tests/browser.cjs
```

Mocked UI tests do not measure live Jev quality or latency.

## Project structure

```text
app.js            Browser interaction, scoring workflow, and evidence rendering
document.py       PDF extraction, segmentation, figure matching, and batching
index.html        Minimal application shell
server.py         Local HTTP server and native TypeSafe API integration
settings.py       Environment configuration
style.css         Responsive reader interface
tests/            Parsing and browser interaction tests
docs/             Presentation and supporting documentation
```

## References

- [TypeSafe introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart)
- [System One concepts](https://docs.typesafe.ai/concepts/system-one)
- [Jev models and pricing](https://docs.typesafe.ai/models)
