# CHECKPOINT BLOCO 6 R2: numbers per polygon, re-measured on current main

Verifier: tech-lead (read only: no code, no spec and no pull request touched).
Tree measured: `main` `b298073` (origin/main, the merge of PR #36), in a detached worktree at that
commit with a real copy of `node_modules` and the backend venv from the main tree.
Spec measured: `field-shift-app/specs/bloco-6-numeros-por-poligono.md`, revision 2 (the tree also
carries revision 3's Table E `state_row` row, which is what the route sends).
Backend measured live on `:8011` with `POLYGON_MAPBIOMAS_DB=artifacts/block6/polygon-mapbiomas-fixture.sqlite`.
Date of the run: 2026-11-15, 07:05 to 07:30 BRT.

Two method notes. First, the numbers this spec pins (171.9 mm, 836 C day, 12,788,611 ha and the rest)
are pinned to the recorded fixtures, and the tests replay those fixtures; the live payload I fetched
carries today's upstream values instead (rain 171.1, GDD 832, window 2026-10-02 to 2026-11-12), which is
expected and is not a defect, because no criterion reads a live value. I used the live payload for the
route contract, the section states, the gap register, the state row and the provenance shape, and the
recorded fixtures for every pinned number. Second, the main working tree has since moved to the block 7
branch (`0697fc0`); this checkpoint measures `b298073` in a detached worktree at that commit.

Environment limit, stated once and applied to every row that needs it: the review browser reports
`webgl2: false` and `webgl: false`, so MapLibre cannot construct a map and the real app cannot be
driven at any width. Every criterion whose falsifier needs a rendered map, a rectangle, a computed
style or a screenshot is NOT MEASURED here; the jsdom and backend halves of those criteria are
recorded where they exist.

Commands behind this checkpoint:

```
npx tsc -b --noEmit                        -> exit 0
npx vitest run                             -> Test Files 40 passed (40), Tests 446 passed (446)
cd backend && .venv/bin/python -m unittest discover -s . -p "test_*.py" -v
                                           -> Ran 156 tests, OK (skipped=1)
POST /fields/{id}/numbers (11 case matrix) -> all 11 statuses match AC-44
```

## The 50 criteria of revision 2

| AC | Verdict | Evidence | Note |
|---|---|---|---|
| AC-01 | NOT MEASURED | NumbersView tests: one region named Field numbers, `?numbers=1`, focus rules, no import of the four right edge modules; App.numbers tests: every other parameter byte for byte, pt-BR untouched | The 0 intersection against the right edge column at three widths needs the browser. No `AC-01-rects.txt` or PNG in the tree |
| AC-02 | NOT MEASURED | App.numbers: opens from `?numbers=1`, keeps the camera body; MapCanvas tests spy `resize` | The 0 by 0 map boxes, the viewport rectangle, the page height and the camera values are browser measurements. No `AC-02-*` artifact |
| AC-03 | PASS | NumbersView `the Field numbers region`: raw field id with no basis label, class and area with their labels, chosen date with `entered`, window with the climate basis; empty state prints `No field selected` and no section | `AC-03-header-{width}.txt` and `AC-03-empty-360.png` are absent; the content is decided by the tests |
| AC-04 | PASS | NumbersView: landmark, level two heading, native buttons, Enter and Space, focus to `Back to map`; App.numbers: no timer path in the surface; no `transition-*` rule exists for the numbers surface in `index.css`, so no duration can exceed 0 s | Reduced motion is satisfied by construction, not measured |
| AC-05 | NOT MEASURED | NumbersView: keeps the open state, the field and the payload across a re-render | A resize across three widths with the network log needs the browser. No `AC-05-resize.txt` |
| AC-06 | PASS | `test_ac06_each_printed_metric_has_exactly_one_row_with_the_ten_keys`; NumbersView provenance tests | Live payload: 42 provenance rows, 42 unique metrics, every row carries all ten keys (checked over the whole array) |
| AC-07 | PASS | `test_ac07_basis_is_one_of_the_four_and_comes_from_the_row`; NumbersView renders each row's own basis | Soil and POWER rows print `modelled`, SIDRA and NDVI rows `retrieved` |
| AC-08 | NOT MEASURED | `test_r09_no_metric_id_or_source_string_sets_a_basis` covers the two synthetic rows | No activation sweep test exists (`grep -i "activation sweep" src` finds nothing) |
| AC-09 | PASS | `test_r10_coarse_sources_print_their_resolution_on_every_row`; NumbersView asserts the `8,100 ha` shared cell and the resolution strings | The `88 polygons` figure sits in the same payload string the test matches |
| AC-10 | PASS | App.numbers: the literal scan and `keeps the pt-BR catalogue empty`; class names and units come from the tables | `git diff --name-only` for `pt-BR.ts` is untouched in the block |
| AC-11 | PASS | Eight committed artifacts `AC-11-abstain-{state,climate,water-window,normals,ndvi,ndvi-sentence,municipality,smap}.txt`, each with row value, rendered text and gap; NumbersView `abstention texts name the missing input, its source and its cause` | The section error outranks the gap cause, as the merges intended: `ConnectError` prints before `network unavailable` |
| AC-12 | PASS | `test_ac12_each_data_section_prints_a_source_line_with_as_of_and_basis`; NumbersView `the seven data cards` | The counter evidence, provenance and register cards are excluded |
| AC-13 | NOT MEASURED | App.numbers: no raster source and no numbers layer is added | The identical style in both states and the canvas paint need the browser. No `AC-13-layers.txt` |
| AC-14 | NOT MEASURED | `test_r15_no_request_reaches_a_google_or_mapbiomas_host`: no Google or MapBiomas host in the numbers call | The field by field parity between the EOX and Google runs needs two app runs with a basemap. No `AC-14-google-parity.txt` |
| AC-15 | **FAIL** | `test_r16_dropped_days_count_the_unconsolidated_days_after_the_window_end` measures 1 for 2026-11-12; the developer's own comment records the conflict | The window itself is right: 2026-10-01 to 2026-11-11, 42 days, 42 valid. AC-15 and Table B print 0; the implementation prints 1. R-16's rule gives 1 (2026-11-12 carries -999) and 3 for 2026-11-14, which is the criterion's own third number. Smallest fix: amend AC-15 and Table B to `dropped_days 1`; no code change |
| AC-16 | PASS | `test_r17_request_carries_only_the_table_a_parameters_with_ag_and_json`, `test_r17_the_fill_value_is_dropped_at_parse_and_never_enters_a_series` | |
| AC-17 | PASS | `test_r18_six_aggregates_reproduce_oracle_o01` and the route test: 171.9, 7, 836, 0, 21.8, 0.49 | |
| AC-18 | PASS | `test_r19_thirty_three_valid_days_abstains_the_growing_degree_days`, `test_r19_thirty_four_valid_days_prints_with_its_valid_count` | |
| AC-19 | PASS | `test_r20_normals_reproduce_oracles_o03_o04_o05` and the route test: 224.9, 88.9, 389.7, rank 7, 35 years, percentile 20, 28 hot days, median 17 | |
| AC-20 | PASS | NumbersView: one point per valid day for the three series, no line across the gap; `test_r16_dropped_days_*` gives the dropped day | |
| AC-21 | PASS | `test_r22_three_numbers_in_mm_from_the_recorded_window`: in 171.9, out and remaining from the same run, formula and window; NumbersView prints exactly three millimetre numbers | |
| AC-22 | PASS | `test_r23_one_missing_evland_day_abstains_the_whole_balance`, `test_r23_the_balance_has_no_input_from_smap`; NumbersView names EVLAND and the missing day count | |
| AC-23 | PASS | NumbersView: `out, POWER EVLAND, land surface evaporation` plus the two statements; live payload `out_label` carries them | |
| AC-24 | NOT MEASURED | NumbersView asserts the SMAP axis, the 9 km and 36 km strings, `8,100 ha`, `88` and `palette, not a physical unit` | The series itself is `state: abstained` with the gap `palette reader not built` (wave 2), so the card has no points to measure. The spec's own line says AC-24 and AC-25 need the block 4 SMAP layers |
| AC-25 | NOT MEASURED | `test_r25_r26_smap_abstains_with_one_gap_and_no_upstream_request` covers the stub | The 503 and `none_in_lookback` day gaps need the palette reader that does not exist |
| AC-26 | PASS | `test_ac26_search_body_carries_collection_ring_and_window`; assets read from the recorded search | |
| AC-27 | NOT MEASURED | `test_r28_clear_threshold_is_below_twenty_percent` pins the 20 percent rule | The zonal mean needs the COG reader of OD-01, which is not approved; no `ndvi_mean` exists in the tree |
| AC-28 | NOT MEASURED | Same prerequisite as AC-27 | |
| AC-29 | **FAIL** | `test_ac29_scene_count_and_clear_count_come_from_the_recorded_search`: the recorded search holds 13 scenes and the clear count is computed from it; the live route reports `3 of 13 scenes are below 20 percent cloud` | AC-29 pins `18 scenes found, 6 below 20 percent cloud`, which the tree's recorded search does not produce. The no-MODIS clause holds (0 occurrences in the live payload). Smallest fix: re-pin AC-27 and AC-29 to the recorded search (13 scenes, 3 clear), or re-record the search and the two counts together |
| AC-30 | PASS | `test_ac30_values_reproduce_oracle_o06`: clay 225, 223, 265, sand 635, 639, 601, pH 5.0, 5.1, 5.1, SOC 22.2, 16.2, 9.1 | R-31's prose "divide every mean by d_factor" is imprecise for clay and sand; the criterion's numbers are met and the developer flagged the prose |
| AC-31 | PASS | `test_r32_*`: missing d_factor, property and depth each abstain; no literal 10 | |
| AC-32 | PASS | `test_r33_the_sidecar_key_is_polygon_product_year`, `test_r33_the_module_makes_no_network_call`; the fixture sidecar carries the table | |
| AC-33 | PASS | `test_ac33_a_code_alone_never_resolves_a_name`, `test_r34_table_d_carries_nine_first_crop_and_three_second_crop_classes` | |
| AC-34 | PASS | `test_r35_rows_cover_1985_to_2025_first_and_2000_to_2025_second` on the recorded three polygon sidecar | |
| AC-35 | PASS | `test_r36_a_polygon_without_a_row_abstains_with_the_named_gap`, `test_r36_an_absent_sidecar_file_is_unavailable_with_the_path` | |
| AC-36 | **FAIL** | The state row prints: live payload `state_row` = code 51, Mato Grosso, 2025, 12,788,611 ha, `state total, not this field`. The municipal row and the share do not: `polygon_share` and `municipality_soy_ha` are null in every branch because no municipality code is resolved (`field_numbers.py:766`, CO-B6-06) | AC-36 also requires the municipal row 130,000 ha and the share as area over municipal area times 100 with four decimals. The SIDRA reader reproduces both series (`test_ac36_*`), but the route never reaches them. Smallest fix: either the municipality join that CO-B6-06 names, or amend AC-36 to the state row only and carry the municipal row to CO-B6-06 |
| AC-37 | PASS | `test_ac37_the_state_row_prints_while_the_municipality_abstains`, `test_ac37_the_municipal_row_and_the_share_still_abstain_with_a_named_reason`; live payload confirms it | |
| AC-38 | **FAIL** | `grep -rn "falsifier" src` finds no component, no key and no test; `RotationFlipCard.tsx:62-66` renders five labels (why, evidence, benefit, gap, risk) | AC-38 requires the sixth label `Falsifier` immediately after `Benefit` and the metric value with its basis and date. Smallest fix: the `Falsifier` slot and the injected scenario test; the fixture content is CO-B6-02 |
| AC-39 | **FAIL** | No `No counter evidence recorded` string exists in `src/strings/en.ts` or any component; no completeness counter exists | AC-39's slot and gap are unimplemented; the completeness clause additionally needs CO-B6-02 |
| AC-40 | PASS | Gap rows: the route writes all six fields (`_gap`) and the live payload's seven rows carry them; `numbers.gaps.empty` exists | No test asserts the empty-state text; the row shape is asserted by the route tests |
| AC-41 | PASS | NumbersView parity tests: the printed register equals the payload array in count, order and wording | |
| AC-42 | PASS | Read from `METRICS` (`field_numbers.py`) and confirmed on the live payload: the only two `route` `canvas` rows are `smap_surface` and `smap_rootzone`, both with the unit `percent of the served palette`; cogs rows carry `unitless` and `fraction`, api and sidecar rows carry their units; `test_r08` asserts the route key on every row | The Table F mapping is verified by code inspection plus the payload, not by a dedicated test |
| AC-43 | PASS | NumbersView: the palette disclosure prints in the SMAP card and beside the canvas value; no test compares the two routes | |
| AC-44 | PASS | My own 11 case matrix against `:8011`: fixture, `trazo:`, `csb:`, 2015-04-01 and today all 200 with every Table E section present and states inside the four; 400 for the date before the axis, a two point ring, a zero area ring and a centroid outside; 404 for an unknown id; 422 for a malformed body | The strongest row in this checkpoint: measured, not read |
| AC-45 | PASS | `test_ac45_each_failing_source_in_turn_answers_200`, `test_ac45_power_down_keeps_soil_and_ndvi_and_answers_200` | |
| AC-46 | PASS | `test_ac46_a_second_request_inside_the_lifetime_returns_the_same_fetched_at`, `test_ac46_after_the_climate_lifetime_only_climate_refreshes`, `test_ac46_an_unavailable_section_writes_no_cache_file` (fake clock) | |
| AC-47 | PASS | `test_r48_offline_network_answers_200_with_every_network_section_unavailable`; NumbersView.contract offline surface tests | No `AC-47-offline.png` (browser) |
| AC-48 | NOT MEASURED | NumbersView polygon tests: the raw id, the block 5 class and area, the outline abstention, no request | Needs a selected polygon in the real app and the three widths. No `AC-48-*` artifact |
| AC-49 | PASS | `test_ac49_ten_point_seven_percent_difference_is_a_fragment`, `test_ac49_one_point_eight_percent_difference_is_not_a_fragment`, `test_r50_without_a_polygon_area_the_check_is_null` | The polygon branch of the criterion needs block 5's selection, but both ring/area pairs are measured |
| AC-50 | PASS | `test_r51_the_three_id_forms_resolve_the_region_they_name`: fixture `br`, `csb:` `us`, `trazo:` `br`, bare id `us`; NumbersView prints `153.2 acres` with `retrieved`; the fixture carries `region` on all six entries | |

## Totals

| Verdict | Count | Criteria |
|---|---|---|
| PASS | 34 | 03, 04, 06, 07, 09, 10, 11, 12, 16, 17, 18, 19, 20, 21, 22, 23, 26, 30, 31, 32, 33, 34, 35, 37, 40, 41, 42, 43, 44, 45, 46, 47, 49, 50 |
| FAIL | 5 | 15, 29, 36, 38, 39 |
| NOT MEASURED | 11 | 01, 02, 05, 08, 13, 14, 24, 25, 27, 28, 48 |

Comparison with the first gate: 30 FAIL then, 5 now. The 25 that moved are the contract crashes the
merges fixed plus the sections that now answer with a named abstention instead of a broken body.

## The five failures, with the measurement and the smallest fix

1. **AC-15**: measures `dropped_days 1` for the chosen date 2026-11-12 (test at
   `backend/test_field_numbers_aggregates.py:59`, the developer's own recorded conflict); the criterion
   and Table B print 0. The criterion contradicts itself: 0 for 2026-11-12 and 3 for 2026-11-14 cannot
   both hold under R-16's rule, and 1 and 3 do. Fix: amend AC-15 and Table B to 1, no code change.
2. **AC-29**: the recorded search holds 13 scenes and the clear count is computed (3 in this run); the
   criterion pins 18 and 6. Fix: re-pin AC-27 and AC-29 to the recorded search, or re-record the search
   together with its counts. No code change.
3. **AC-36**: the state row prints 12,788,611 ha for 2025 labelled `state total, not this field`, but the
   municipal row and the share never print, because no municipality code is resolved (CO-B6-06). Fix:
   either the IBGE join CO-B6-06 names, or amend AC-36 to the state row and carry the municipal row.
4. **AC-38**: the back face has five labels and no `Falsifier` sixth; no falsifier object is read
   anywhere. Fix: the slot, its key and the injected scenario test; the content is CO-B6-02.
5. **AC-39**: no `No counter evidence recorded` slot exists and no completeness count is reported.
   Fix: the slot and the count, with CO-B6-02 for the content.

## What I could not measure, and why

- Eleven criteria need the real map in a browser: the review browser has no WebGL, MapLibre cannot
  construct a map, and the app cannot be driven. That covers AC-01, AC-02, AC-05, AC-08 (sweep),
  AC-13, AC-14, AC-48, plus the computer use halves of AC-03, AC-04, AC-06 and others which I decided
  from their tests because their falsifiers are content, not geometry.
- Four criteria wait on a reader or a data product the spec itself names: AC-24 and AC-25 on the SMAP
  palette reader (wave 2), AC-27 and AC-28 on the COG reader of OD-01.
- No block 6 artifact exists for any criterion except the eight `AC-11-abstain-*` files. The spec's
  exit criteria require one artifact per criterion, so on that rule alone this block is not
  closable as it stands; the evidence in this checkpoint is my own commands and the suites, not a
  recorded artifact per criterion.

## Does block 6 meet its spec on current main?

No. 34 of 50 pass, 5 fail and 11 cannot be measured here. Two of the five failures are spec-side
(AC-15's dropped day count, AC-29's scene counts) and need a one-line amendment each, and three are
implementation-side (AC-36's municipal row and share, AC-38 and AC-39's falsifier slot). Block 6 is
close, but it is not met as written, and it cannot be declared met while the exit criteria demand an
artifact per criterion and only eight exist.

## Amendments applied after this measurement

This checkpoint measures revision 2's text at `b298073`. The orchestrator ruled on the three
spec-side failures afterwards, and revision 4 records the result. The rows above are the measurement
as taken; read them together with this section.

| Commit | Subject | Freeze digest |
|---|---|---|
| `bd48a65` | AC-15 and the Table B worked response print `dropped_days` 1 for 2026-11-12 | `69bd276eebefd19af0d6c015017329847d7a5c6ea076dc1d464266f67dfe8c61` |
| `648d992` | AC-27 and AC-29 re-pinned to the recorded search, 13 scenes and 3 below 20 percent cloud, with a sentence that the counts move with any re-recording | `6d86752f6c92021476ab948e09ff264d31fbe130cc6c252026b19184364986c2` |
| `a3f4249` | AC-36 prints the state row only; the municipal row and the share go to CO-B6-06, and R-37 says the same | `141d2b51dc2dd5bba41071fd145e7636593f87d44d22b8d39d1677f0cf90d527` |
| `79c1f5f` | Revision 4 recorded in the Status line | `4040b14921956584a2b77314f7820e4903f5bfbcb4539f1acda558235c48da48` |

Each digest was re-derived with the file's own recipe (`sed 's/`[0-9a-f]\{64\}`/`PENDING`/'`, no `g`
flag) and verified as a fixed point against the row it writes. All four commits sit on local `main`,
one subject each, and none is pushed; `origin/main` is `b298073` and local `main` is four ahead.

The AC-36 ruling, in one line: the missing municipality join is a data dependency that the route
cannot satisfy (the SIDRA reader already reproduces both series, O-07 and O-08), so AC-36 now requires
the state row and states the abstention out loud instead of demanding a row the data cannot produce,
and CO-B6-06 carries the municipal row and the share.

With revision 4's three amendments applied, the amended criteria measure as follows: AC-15 reads 1 and
the tree measures 1; AC-29 reads 13 and 3 and the tree measures 13 and 3; AC-36 reads the state row
and the tree prints it. So the tally becomes 37 PASS, 2 FAIL (AC-38 and AC-39, which are code and are
routed to the developer) and 11 NOT MEASURED, and block 6 meets its spec on main apart from the eleven
rows this host's browser cannot measure, subject to the user's approval of revision 4.
