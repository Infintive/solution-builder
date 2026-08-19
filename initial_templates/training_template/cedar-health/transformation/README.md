# transformation/

Put your **data transformation** here — the SDP (Spark Declarative Pipeline) SQL
that turns the raw parquet (in the `raw_data` volume, written by
`../data_generation/generate_data.py`) into the silver + gold tables described in
`../specifications/01-lakeflow.md` (`gold_patient_panel`, `gold_open_atrisk`,
`gold_intervention_outcomes`, `gold_intervention_recommendations`, the
`ai_classify` risk signal, …).

If you take the OPTIONAL ML path (`../specifications/03-ml-intervention.md`), the
`intervention_train_score.py` notebook also lives here.

This folder ships empty — building the pipeline is Milestone 1.
