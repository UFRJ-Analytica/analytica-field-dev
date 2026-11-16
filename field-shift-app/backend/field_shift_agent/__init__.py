"""Field Shift AI, milestone 2 (experiment, not a frozen block): a read-only agent over the block 6
numbers and the FAO-56 experiment.

The language model interprets the question, picks tools and writes the explanation. Every number it
shows is a reference to an Evidence item that a deterministic tool returned; the Evidence Guard checks
those references before anything reaches the frontend, which renders the values itself. With no
provider configured (the default) the route answers `mode: "fallback"` and the frontend keeps its
deterministic adapter.
"""
