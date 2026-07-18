# Eji integration fit — 2026-07-18

## Status

Exploratory product note. This is not a commitment to build an Eji-specific
integration or a vertical product.

## The fit

[Eji](https://www.komcp.com/fable-of-eji-071626) is a personal AI coaching
system built around a human-in-the-loop learning cycle: curated personal and
people memory, explicitly uncertain "Modeled Other" dossiers, approved
writing-rule changes, and recurring reflection.

Relay can add depth as the model-agnostic operations layer beneath such a
system:

- dispatch bounded extraction, comparison, review, and synthesis work to the
  appropriate local or frontier model;
- retain inspectable receipts for a proposed insight or rule: source, model,
  inputs, human disposition, and later outcome;
- keep verified operational lessons available across sessions and tools; and
- make recurring reflection evaluable instead of treating a model's
  self-assessment as evidence.

## Boundary to preserve

Eji's personal profiles, relationship records, coaching context, and domain
judgment belong in Eji's own database. Relay must not become a second,
competing source of truth for that sensitive domain data. Its role is durable
operational memory, controlled delegation, and auditable execution around the
Eji workflow.

Model-generated interpretations of a person must remain clearly marked as
inference, with provenance, staleness handling, and a human route to correct
or reject them. Relay's trust tiers and receipts can support that discipline;
they do not make an inference true.

## Product implication

An Eji-like system is a useful future validation scenario for Relay's core
loop:

```text
domain memory -> context selection -> delegated work -> verified outcome
              -> human judgment -> durable operational lesson
```

The validation should remain product-agnostic and use synthetic or expressly
authorized data. It should test whether Relay makes the loop more adaptable,
inspectable, and model-portable without absorbing the vertical application's
own memory model.
