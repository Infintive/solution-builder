# transformation/

Put your **data transformation** here — the SDP (Spark Declarative Pipeline) SQL
that turns the raw parquet (in the `raw_data` volume, written by
`../data_generation/generate_data.py`) into the silver + gold tables described in
`../specifications/01-lakeflow.md` (`gold_segment_position`, `gold_open_sliding`,
`gold_experiment_outcomes`, `gold_action_recommendations`, the `ai_classify`
slide signal, …).

If you take the OPTIONAL ML path (`../specifications/03-ml-conversion.md`), the
`conversion_train_score.py` notebook also lives here.

This folder ships empty — building the pipeline is Milestone 1.
