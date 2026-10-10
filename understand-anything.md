# Understand Anything

Setup and usage notes for the knowledge-graph tooling used to map this repo. Not part of the Genie work.

---

# Generating and committing an Understand Anything graph

How to analyze a repository with Understand-Anything and commit the resulting
knowledge graph to GitHub so teammates can use it.

This side needs Claude Code. Viewing the finished graph does not. See
the Viewing section below.

## Prerequisites

- Claude Code
- Node.js 22+ and pnpm 10+ (the plugin builds a local package on first run)
- Python 3 on `PATH` (two of the pipeline's merge scripts are Python)
- The repository checked out, and a git remote you can push to

## 1. Install the plugin

In Claude Code, add the marketplace and install:

```
/plugin marketplace add Egonex-AI/Understand-Anything
/plugin install understand-anything
```

## 2. Generate the graph

From the repository you want to analyze:

```
/understand
```

The first run asks you to review a generated `.ua/.understandignore` before it
starts. Uncomment anything you want excluded (tests, vendored code, generated
files), then confirm.

Analysis then runs in phases: scan, per-file analysis, architectural layering,
and a guided tour. Expect it to take a while on a large repo; it reports
progress as it goes.

Useful variations:

| Command | Effect |
| --- | --- |
| `/understand` | Full analysis, or an incremental update if a graph already exists |
| `/understand --full` | Force a full rebuild, ignoring the existing graph |
| `/understand --exclude "tests/*,vendor/*"` | Exclude extra paths for this run |
| `/understand <path>` | Analyze a different directory |

## 3. What gets created

Everything lands in a `.ua/` directory at the repo root:

| File | Purpose | Commit? |
| --- | --- | --- |
| `knowledge-graph.json` | The graph itself which includes nodes, edges, layers, and tour. This is the only file the viewer needs. | Yes |
| `fingerprints.json` | Per-file structural baseline enabling cheap incremental updates | Yes |
| `meta.json` | Commit hash and timestamp of the last analysis | Yes |
| `config.json` | Output language and auto-update preference | Yes |
| `.understandignore` | Your exclusion rules | Yes |
| `intermediate/scan-result.json` | Cached file inventory that lets later runs skip a rescan | Yes |
| `tmp/`, `.trash-*/` | Scratch space and deleted intermediates | No |

Committing `fingerprints.json` and `meta.json` is what lets the next person run
a cheap incremental update instead of paying for a full rebuild.

## 4. Commit it

Git ignore only the scratch directories:

```gitignore
# Understand-Anything scratch space
.ua/tmp/
.ua/.trash-*/
```

Then commit the rest:

```bash
git add .gitignore .ua
git commit -m "Add Understand-Anything knowledge graph"
git push
```

Confirm the scratch directories stayed out:

```bash
git ls-files .ua
```

## 5. Keeping it current

The graph records the commit it was built from, so it goes stale as the code
moves on. Re-run `/understand` periodically. It diffs against
`fingerprints.json` and only re-analyzes files that changed structurally, which
is far cheaper than the first run. Commit the updated `.ua/` the same way.

To have it refresh automatically on commit:

```
/understand --auto-update
```

## Notes

- `knowledge-graph.json` is a few hundred KB on a small repo and grows with the
  codebase. It is regenerated wholesale, so expect large diffs and review it by
  its summary statistics rather than line by line.
- The graph contains file paths, summaries and code structure. Treat it as
  roughly as sensitive as the source itself, and keep it in the same repo rather
  than publishing it separately.

### Model selection

None of the Understand Anything agents pin their own model. Every one of them
inherits whatever the session is set to, so the `/model` you choose before
running `/understand` applies to the entire pipeline.

- **Use a top-tier reasoning model for the first full build.** Analysis is
  written once and read many times. Summaries, layer boundaries and the tour are
  the whole product, and a weaker model produces plausible-looking output that
  quietly misses relationships and mislabels layers.
- **A mid-tier model is reasonable for routine incremental updates**, where only
  a handful of changed files are re-analyzed and the existing layer structure is
  preserved.
- **Avoid using smaller, fast models as details get lost easily** 
- **Do not switch models partway through a run.** The pipeline runs in phases,
  and changing models between them yields summaries written to inconsistent
  standards across the same graph.

### Before the first run

- **Curate `.understandignore` carefully.** This is the single biggest lever on
  both cost and quality. Excluding vendored dependencies, generated code, build
  output, minified bundles and large fixtures cuts the token bill and stops the
  graph from being filled with nodes nobody will ever look at. **Do not** exclude
  documentation, configuration or infrastructure files, as those become nodes
  too and are often the most useful part of the graph for a newcomer.
- **Scope very large repositories.** Past roughly a hundred files the pipeline
  will warn you. Prefer analyzing a meaningful subdirectory, or use `--exclude`,
  rather than pointing it at a monorepo root and waiting.
- **Analyze a clean working tree at a known commit.** The graph records the
  commit hash it was built from. If you analyze uncommitted changes, that hash
  describes something that never existed, and staleness detection gives
  misleading answers afterwards.

### After a run

- **Confirm the fingerprint baseline was written.** If `fingerprints.json` is
  missing while `meta.json` exists, every later run will classify all files as
  changed and escalate to a full rebuild. Both files should be present and
  committed together.
- **Skim the layer names and the tour.** They are the human-facing surface of
  the graph and the cheapest thing to sanity-check. If a layer is misnamed or
  the tour opens somewhere unhelpful, re-running the analysis is usually faster
  than arguing with it.
- **Never hand-edit `knowledge-graph.json`.** It is regenerated wholesale on the
  next run and your edits will vanish. Fix the input instead, by adjusting
  `.understandignore` and re-running.
- **Expect forks and duplicated directories to show up prominently.** Near
  identical copies of a tree produce near identical subgraphs. That is accurate
  rather than a defect, and it is often the most valuable thing the graph
  reveals about a repository.


---

# Viewing an Understand Anything graph

How to open a knowledge graph that someone else generated and committed. This
needs Node.js and nothing else. No Claude Code, no LLM, no API key, no
account. You are only reading the result. If you wish to generate or update a graph see the Setup section above.

## Prerequisites

- Node.js 18 or newer (`node --version`)
- git

## 1. Clone the repository

```bash
git clone <repository-url>
cd <repository>
```

Confirm the graph came with it:

```bash
ls .ua/knowledge-graph.json
```

If that file is missing, the graph was never committed. Either generate it yourself using the Setup section above, or ask a team member who has the prerequisites.

## 2. Start the viewer

From the repository root:

```bash
npx https://github.com/Egonex-AI/Understand-Anything/releases/latest/download/understand-anything-viewer.tgz .
```

`npx` fetches a self-contained tarball with no dependencies, runs it, and
caches it for next time. You are not installing anything into the project. On
first use it may ask `Ok to proceed?` — answer `y`, or add `--yes` right after
`npx` to skip the prompt.

It prints a URL with a one-time token and opens your browser:

```
Serving graph from /path/to/repo/.ua
🔑  Dashboard URL: http://127.0.0.1:5173/?token=<GENERATED-TOKEN>
```

If the browser doesn't open automatically: Ctrl+Click or Copy the whole URL including `?token=`. Without it the page loads but
refuses to serve any data, and you will see an "Access Token Required" gate. The
token is regenerated every start, so it will differ from the example above.

Stop the server with `Ctrl+C` at the command line.

### Options

| Flag | Effect |
| --- | --- |
| `--port <n>` | Use a specific port (default 5173, auto-increments if taken) |
| `--no-open` | Print the URL without launching a browser |

You can also point it at a repository elsewhere by replacing `.` with a path.

## 3. What you can explore

- **Graph** - files, classes and functions, and the relationships between them
  (imports, calls, configures, documents, and so on)
- **Layers** - the architectural grouping every file was assigned to
- **Tour** - an ordered walkthrough written for newcomers, usually the fastest
  way in
- **Code** - the actual source of any file in the graph, read-only

Source preview works because you cloned the whole repository. If you were given
only a bare `knowledge-graph.json`, the graph, layers and tour still render, but
the code pane has nothing to read and will come up empty.

## Security

The viewer is read-only and entirely local:

- binds to `127.0.0.1`, so nothing on your network can reach it
- every data request requires the one-time token from startup
- absolute paths are stripped out, so the author's directory layout is not exposed
- it will only open files that appear in the graph, capped at 1 MB, never binary
- nothing is uploaded anywhere

After the first download the viewer is cached and runs offline.

## Troubleshooting

**"No knowledge graph found"** - you are not in the right directory, or `.ua/`
was not committed. Check `ls .ua/knowledge-graph.json`.

**"Access Token Required"** - you opened the URL without the `?token=` portion.
Copy the full line from the terminal.

**404 when downloading** - use the `latest` URL exactly as written above.
Version-pinned URLs only work for releases that actually ship the viewer asset,
and most do not.

**Port already in use** - pass `--port 5200` or any other free port.

**The graph looks out of date** - it reflects the commit it was generated from,
which may be behind `main`. The dashboard flags this when it detects drift.
Regenerating requires Claude Code; see the setup guide.
