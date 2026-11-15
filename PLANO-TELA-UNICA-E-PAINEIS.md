# Plan: one screen, four panels (block 5.5)

Author: orchestrator. Date: 2026-11-15.
Status: proposal, awaiting the user's answers to section 9. Nothing in this plan is implemented yet.

This plan reworks how blocks 5, 6 and 7 present themselves. It comes before blocks 8 and 9, and it
comes before any further block 6 measurement, because the surfaces it changes are the ones the
remaining criteria are measured on.

## 1. The defect report this plan answers, verbatim from the user

U1. `Field numbers` fails with 404.
U2. `Field numbers`, `Planting calendar` and `Field record` are separate screens. They must be
    components on the main map screen, appearing over it.
U3. With no polygon selected, `Selected polygon` must not appear.
U4. Selecting one polygon and then another does not update `Selected polygon`. That is a bug.
U5. Clicking the map outside any polygon must deselect the current polygon, and `Selected polygon`
    must disappear.
U6. `Rotation outlook` must become a button, like `Field numbers`, `Planting calendar` and
    `Field record`.
U7. `Planting calendar` must open a component in the same place `Rotation outlook` occupies today,
    and pressing the `Rotation outlook` button closes the calendar and shows the rotation outlook.
U8. `Field record` must let the user select the area directly on the map, not on another screen,
    with its controls in the slot where `Rotation outlook` sits.
U9. In `Field record`, `Producer data` and `Gaps` do not belong. Remove them.
U10. All of the above comes before the remaining blocks.

## 2. Diagnosis of U1, the 404, before anything else

The 404 is not a missing route. It is a stale process.

- `field-shift-app/backend/main.py:774` defines `@app.post("/fields/{field_id}/numbers")`, and that
  route is on `main`.
- The backend answering on `127.0.0.1:8000` is PID 1618575, started at 00:07:05, before block 6's
  backend was merged. Its own `/openapi.json` lists ten routes and none of them is the numbers route:
  `/commands`, `/commands/{name}`, `/fields`, `/fields/{field_id}/scenarios`, `/health`, `/layers`,
  `/layers/{layer_id}/coverage`, `/polygons/mode`, `/tiles/stats/upstream`, `/tiles/{layer}/{z}/{x}/{y}`.
- `POST http://localhost:8000/fields/trazo:1/numbers` answers `404 {"detail":"Not Found"}`.
- The frontend is correct: `src/lib/numbers-api.ts:40` posts to `${base}/fields/${id}/numbers` with
  `base` defaulting to `http://localhost:8000` (`src/App.tsx:46`).

So W0 of this plan is operational, not code: restart the backend on the current `main` and confirm
that `/openapi.json` lists eleven routes. Until that happens no number can be verified in the
browser, whatever else this plan changes.

## 3. Target behaviour

One screen. The map is the screen, and it is never hidden. Four panels share one slot, and exactly
one of them is open at any moment:

| Panel | Opened by | Content today | Content after |
|---|---|---|---|
| `Rotation outlook` | its own new button | `ScenarioCards` in the bottom left overlay | unchanged content, now a toggle |
| `Field numbers` | existing button | full viewport `NumbersView` | the seven cards, the chart and the gap register, inside the panel slot |
| `Planting calendar` | existing button | full viewport `DecisionView` | the calendar and the history rows, inside the panel slot |
| `Field record` | existing button | full viewport `FieldRecordView` | boundary drawing on the map, with the panel holding the controls |

Rules that the plan turns into requirements:

B1. The map screen is never `display: none`. No full viewport surface exists for these four.
B2. The four buttons live together in the block 3 control strip, to the left of the block 3 right
    edge column, which is not moved, resized or amended.
B3. Exactly one panel is open. Opening one closes the others, and the button of the open panel shows
    its state through `aria-expanded` and a pressed style.
B4. No panel is open on load and none opens by itself. A polygon selection opens `Selected polygon`
    only; the four buttons open their panels. `Rotation outlook` is a button like the other three,
    not a default.
B5. Panels that need a polygon (`Field numbers`, `Rotation outlook`) are disabled, `aria-disabled`,
    with the reason in their accessible name, while no polygon is selected.
B6. `Selected polygon` is the polygon readout panel. It exists only while a polygon is selected.
B7. Selecting a different polygon updates every open panel in the same interaction, without a
    reload and without a stale frame.
B8. A click on the map that lands on no polygon clears the selection: the readout disappears, the
    polygon layers return to unpainted, and any panel that needs a polygon closes.
B9. `Field record` draws on the map. The drawing is a map interaction mode, not a separate screen:
    the panel holds the instructions, the validation errors and the save and cancel controls, and
    the boundary is drawn over the basemap with the map's own pointer events.
B10. `Producer data` and `Gaps` are removed from `Field record`. The gap register stays in
     `Field numbers`, where R-41 of block 6 puts it.

## 4. Specs move first, because the code follows the frozen text

The current frozen text forbids most of this plan. It has to be amended before any code, per ADR
0005 and the user's standing rule.

Block 6, revision 5, must change:
- R-01 and R-02: the numbers are no longer "one new surface" with the map screen at `display: none`;
  they are a panel of the map screen, and the map screen stays visible.
- R-04, R-05, R-06: the zero area intersection, the landmark `region`, the level two heading and the
  resize behaviour are re-expressed for a panel inside the shell, and the scroll offset clause is
  narrowed to the panel's own scroller.
- AC-01, AC-02, AC-04, AC-05: the measurement of the map being hidden is replaced by the measurement
  that the four panels are mutually exclusive and that the map keeps its rectangles.
- R-31 of block 4 is not touched: the window source rule is orthogonal to where the panel lives.

Block 7, revision 10, must change:
- R-01 and R-02: two surfaces become two panels, same treatment as block 6 above.
- R-06: "at most one screen open" becomes "at most one panel open", with the four named panels.
- R-08: the two buttons join the other two in the strip, and the strip's order is fixed.
- New requirement: the drawing mode of B9, which today lives inside a full viewport surface.
- R-56 and R-58 lose their `Field record` home: `Producer data` moves to the map screen (or out of
  scope, decision D2 below), and the gap register of R-58 stays only in `Field numbers`.

Blocks 1 to 5 keep their text. Block 3's right edge column is untouched by this plan: it is a
constraint every panel respects, not a thing this plan moves.

## 5. Work items, in dependency order

Each item names the files as they stand today, its acceptance check, and the clauses it needs.

W0. Restart the backend on current `main` and verify the route inventory. Operational.
    Acceptance: `POST /fields/{id}/numbers` answers 200 on the fixture field, and `/openapi.json`
    lists eleven routes.

W1. Spec amendments, block 6 revision 5 and block 7 revision 10, exactly the clauses in section 4.
    Acceptance: both digests re-derive, both are on `main`, no other clause changes.

W2. The panel host. One container in the bottom left overlay, replacing the `ScenarioCards` block at
    `src/App.tsx:633`, plus the state that says which panel is open.
    Files: `src/App.tsx`, a new `src/lib/panel-store.ts`, `src/index.css`.
    Acceptance: exactly one panel renders at a time; the container's rectangle equals the rectangle
    `ScenarioCards` occupies today at 1440x900, 780x900 and 360x640.

W3. The four buttons. `Rotation outlook` gains a button beside the three existing toggles; the four
    are one exclusive group.
    Files: `src/App.tsx:583-586`, `src/components/NumbersToggle.tsx`, `DecisionToggle.tsx`,
    `FieldRecordToggle.tsx`, new `RotationToggle.tsx`, `src/strings/en.ts`.
    Acceptance: `aria-expanded` and the pressed style follow the open panel; opening one closes the
    other three; each button is at least 44 by 44 px at 360.

W4. `Field numbers` becomes a panel. `NumbersView` keeps its cards, chart and gap register, loses the
    full viewport shell, `Back to map` and the `?numbers=1` deep link, and renders inside the host.
    Files: `src/components/NumbersView.tsx`, `NumbersView.css`, `src/lib/numbers.ts`,
    `src/App.tsx`, `src/components/NumbersToggle.tsx`.
    Acceptance: the seven cards render in the panel at all three widths, the panel scrolls on its
    own, and no map element reads `display: none`.

W5. `Planting calendar` becomes a panel, `Producer data` leaves `Field record` and the calendar's own
    `Gaps` card is deleted. The declared history rows and the calendar rows live in the panel.
    Files: `src/components/DecisionView.tsx`, `FieldRecordView.tsx`, `Block7.css`, `src/App.tsx`.
    Acceptance: the calendar renders in the panel; `Producer data` and `Gaps` are absent from
    `Field record`; the history stays editable row by row.

W6. The selection model. One source of truth for the selected polygon, one write path per event, and
    three behaviours: select, re-select, and clear on empty map click.

    The three failures are already located in the code as it stands, which is why this item is
    written with its causes and not only its symptoms:

    - U4, selecting B after A leaves the readout on A. `map-store.ts:157` writes `selectedPolygonId`
      but does not clear `polygonClass`, `polygonRaw` or `polygonRing`, and `MapCanvas.tsx:645-668`
      returns early on `polygonClass !== null && polygonRing !== null`. So the class, area and ring of
      the first polygon survive every later selection. The fix is that a selection writes all four
      fields together, in one set, and the sync effect does not treat a populated class as a reason to
      stop.
    - U3, `Selected polygon` shows with nothing selected. `App.tsx:562-566` mounts `PolygonPanel`
      whenever the viewport is not narrow, with no guard on the selection. The panel must not mount,
      or must return null, while `selectedPolygonId` is null.
    - U5, an empty click does not deselect. `MapCanvas.tsx:785` registers the click handler scoped to
      `POLYGON_FILL_LAYER_ID`, so a click that hits no polygon never runs. `clearPolygonSelection`
      exists at `map-store.ts:197` and nothing calls it from the map. The fix is a map level click
      handler that queries the polygon layer and clears when the query is empty.

    Files: `src/lib/map-store.ts` (selection state), `src/components/MapCanvas.tsx` (click handling,
    including the empty click), `src/App.tsx` (panel gating).
    Acceptance: selecting A then B shows B in the readout and in every open panel; an empty click
    clears the readout, unpaints the polygon and closes the polygon panels; the same three cases pass
    with the keyboard through the fields list.

W7. `Field record` drawing on the map. Drawing becomes a map mode: pointer down, add vertex, pointer
    up closes the ring, with the geodesic area and the Table D validation running on the client as it
    does today. The panel holds the instructions, the errors and the save and cancel controls.
    Files: `src/components/BoundaryEditor.tsx` (becomes a mode controller plus panel controls),
    `src/components/MapCanvas.tsx`, `src/components/FieldRecordView.tsx`, `src/App.tsx`.
    Acceptance: a ring drawn on the map passes the same Table D tests the editor passes today, a
    rejected ring prints exactly one Table D string, and the saved field appears as a selectable
    field without a reload.

W8. Regression of the blocks that shared these surfaces: block 5's readout, block 4's timeline dock
    and the block 3 right edge column.
    Acceptance: the block 5 readout still renders five rows; the timeline dock keeps its rectangle;
    the zero area intersection with the right edge column holds at the three widths; `tsc`, the full
    vitest suite, the backend suite and `npm run build` are green.

## 6. What disappears, and what that costs

- `display: none` on the map screen: four requirements and their criteria in blocks 6 and 7.
- `Back to map`: two criteria, replaced by the panel's own close behaviour.
- `?numbers=1` and `?decision=1`, `?record=1` deep links: removed (D1). The buttons are the only way.
- `Producer data` card: deleted (D2), together with the export requirement.
- The calendar's `Gaps` card: dropped, per U9. The gap register of block 6 R-41 stays.
- One viewport-sized surface per block: this is the change that makes the map the screen again.

## 7. Measurement, since this plan moves what the criteria measure

Every acceptance check above is measurable without a rendered map except W6 and W7, which are map
interactions. The host on this machine has no WebGL, so W6 and W7 are verified by the user in a real
browser, or by a jsdom harness driving the recorded MapLibre stub, and the checkpoint says which.

## 8. Risks

- R1. The panel slot is small at 360. Four panels in one slot means the numbers panel scrolls a lot;
  the mitigation is that the slot may grow upward at 360, and that is a layout decision to take in W2.
- R2. Removing `display: none` weakens the "one number at a time" argument the specs used to justify
  full screen surfaces. The mitigation is B3 and B7: one panel, and the map keeps its state.
- R3. Block 8's comparator and block 9's agent will want the same slot. The host must be built so a
  fifth panel is data, not code.

## 9. Decisions taken by the user

D1. The deep links `?numbers=1`, `?decision=1`, `?record=1` are removed. The panel is opened by its
    button and by nothing else, which means block 6 R-01 and its criteria lose the URL clause, and
    block 7 loses the three link entries it inherited.
D2. `Producer data` is deleted. Block 7 R-56 and its criteria are withdrawn, and with them the JSON
    export of the two `localStorage` keys; the keys themselves stay, because R-52 to R-55 are what
    persist the producer's work.
D3. No panel is open on load, and a polygon selection opens `Selected polygon` only. See B4.
