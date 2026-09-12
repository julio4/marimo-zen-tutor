import marimo

__generated_with = "0.24.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Averages: think before you calculate

    The attempt below runs, but is its reasoning correct? Explain what the
    denominator represents before changing the code. Use **Help me think**
    beside a cell when you want a small hint.
    """)
    return


@app.cell
def _():
    values = [2, 4, 9]
    return (values,)


@app.cell
def _(values):
    # An intentionally incorrect learner attempt, not the solution.
    mean = sum(values) / 2
    mean
    return


if __name__ == "__main__":
    app.run()
