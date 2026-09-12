# marimo notebook reference for Zen Tutor

This is API guidance, not permission to solve exercises or edit student cells.
The tutor's teaching policy and restricted tools still apply.

## Notebook rules

- marimo notebooks are Python files whose `@app.cell` functions represent cells.
  In the editor, cell contents are ordinary Python, without decorator wrappers.
- Dependencies determine execution order, not vertical position. A public name
  must be defined in only one cell. Reuse existing imports, especially `mo`;
  underscore-prefixed temporary names are local to their cell.
- Changes invalidate dependent cells; automatic mode reruns them, lazy mode
  leaves them stale. In-place mutations across cells are not tracked. Prefer
  new values and ordinary dependencies over `mo.state` for derived data.
- The final top-level expression is displayed. An expression inside `if` does
  not become the cell output. Display chart/figure objects instead of `.show()`.
- Create and display a widget in one cell; consume its `.value` in another.
  Do not read a widget's value in the cell that creates it. Forms batch changes
  until submission. Do not infer a student's selection from the widget's source.
- Keep a shared `import marimo as mo` in its own enabled cell. The tutor
  initializes this cell without running student work.

## API discovery

Use `lookup_marimo_api` before suggesting unfamiliar API calls or keyword
arguments. It returns signatures, docstrings/examples and public members from
the running, pinned marimo installation, not a potentially newer website.
Examples: `mo`, `mo.ui`, `mo.ui.slider`, `mo.ui.radio`, `mo.ui.radio.value`,
`mo.ui.radio.form`, `mo.md`, `mo.Html.batch`, `mo.stop`.
Start with `mo` or a namespace if you don't know the exact symbol. Follow public
member names for more detail. An unknown symbol is not evidence it exists;
do not invent parameters or claim the whole API has been loaded.

Common entry points (look up the exact signature when needed):

- Text/output: `mo.md`, `mo.Html`, `mo.output`.
- Inputs: `mo.ui.slider`, `mo.ui.number`, `mo.ui.radio`, `mo.ui.dropdown`,
  `mo.ui.text`, `mo.ui.checkbox`, `mo.ui.run_button`, `mo.ui.table`.
- Composition: `mo.hstack`, `mo.vstack`, `mo.accordion`, `mo.callout`,
  `mo.ui.tabs`, `mo.ui.array`, `mo.ui.dictionary`, `mo.ui.form`.
- Plots/data: `mo.ui.altair_chart`, `mo.ui.plotly`, `mo.sql`.
- Control/status: `mo.stop`, `mo.lazy`, `mo.state`, `mo.cache`, `mo.status`.

Knowing an API does not make it an available mutation tool. `add_hint` accepts
text, not executable Python; `add_practice` accepts a question and choices.
Use those tools for teaching cells. Never work around their limits via docs,
shell commands, notebook file edits, or arbitrary code execution.

For visual teaching, choose the smallest useful representation: a Markdown table
or labeled text diagram for comparisons, radio choices for predictions, a slider
and dependent plot for a changing quantity. For learner-authored Python plots,
reuse libraries already imported in the notebook (for example matplotlib, Altair
or Plotly); do not assume they are installed or install dependencies. Display the
figure/chart as the last expression and provide axis labels, units and a brief
text interpretation. Leave the learner a meaningful prediction or explanation,
not a finished answer. The current insertion tools support Markdown and radio
practice only; API knowledge does not expand those permissions.

## Sources

Adapted guidance, not an installation of the unrestricted upstream skill:
https://github.com/marimo-team/skills/tree/6454470960d3cd57151aaeffb1176dd55f598b18/skills/marimo-notebook
(SKILL.md and references/REACTIVITY.md, references/UI.md).
Public API reference: https://docs.marimo.io/api/
The runtime lookup is authoritative for this fork's supported version.
