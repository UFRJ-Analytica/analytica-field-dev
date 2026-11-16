# Rotation scoring

How Field Phase ranks candidate rotations for a municipality and a kind of year. Code:
[`pipeline/scoring.py`](../pipeline/scoring.py) (pure, no I/O), [`pipeline/agromet.py`](../pipeline/agromet.py)
(FAO-56 ET0), [`pipeline/build_scoring.py`](../pipeline/build_scoring.py) (assembles the inputs),
[`pipeline/soilwater.py`](../pipeline/soilwater.py) (FAO-56 daily soil water balance),
[`config/rotations.yaml`](../config/rotations.yaml) (candidates, crop parameters, calendars).

## The idea

A rotation is good or bad **for a kind of year**. The same rotation that protects a farm in a
La Niña year can hurt it in a strong El Niño year. So every candidate is scored separately for each
ENSO class — strong El Niño, weak/moderate El Niño, neutral, La Niña — and the farmer sees the
ranking for the class the current season is forecast to be (and can switch to compare).

The three priorities the farmer weights are each a **measured quantity first**, from this
municipality's own data, and only then a 0–100 score:

| Priority | Measured quantity | Better | Data |
|---|---|---|---|
| **Protect soil** | heavy-rain days (≥ 20 mm) per year that fall in months the rotation leaves the soil **bare** | lower | NASA POWER daily rain → mean heavy-rain days per calendar month in years of that ENSO class |
| **Conserve water** | **transpiration lost to water stress**, mm/yr: from a daily soil water balance, the water the crops wanted (Kc × ET0) but could not get because the root zone had dried past their limit | lower | daily POWER rain and FAO-56 ET0; soil water capacity from SoilGrids; rooting depth and stress threshold from FAO-56 Table 22; Kc from FAO-56 Table 12 |
| **Income stability** | change in the rotation's **gross revenue** in years of that ENSO class, % | higher | IBGE PAM: recent revenue per hectare per crop, and each crop's yield anomaly in that class |

## Step by step

### 1. Calendar → months in the field (`occupancy`)

Each crop has a sowing and a harvest (or, for cover crops, termination) month per region. The months
in between are the crop's cycle; FAO-56 stages are assigned by position: first month **initial**,
second **development**, then **mid-season**, last **end**. Two crops may share only the hand-over
month (one harvested, the next sown); anything else is an impossible calendar and is rejected.

A month with no crop is **bare soil**.

### 2. Monthly climate for each ENSO class (`monthly_climate_by_class`)

From NASA POWER, 1982 to today, at the municipality's centroid: for every complete calendar month,
total rain, number of days ≥ 20 mm, and total ET0. Each month takes the ENSO class of its crop year
(Jul–Jun); the means are taken over the years of each class. ET0 needs solar radiation, which POWER
lacks for some early-1980s days, so ET0 months with any gap are left out (93 % of days have ET0).

**ET0** is the FAO-56 Penman–Monteith grass-reference evapotranspiration (equations 6–42 of
FAO-56), from POWER's Tmax, Tmin, mean relative humidity (Eq. 19), 2 m wind, solar radiation and the
grid cell's elevation. The implementation reproduces FAO-56's worked Example 18 (Ra 41.09,
ET0 3.88 mm/day) in `tests/test_agromet.py`.

### 3. The three components

**Soil** = Σ over bare months of mean heavy-rain days in that month (for the ENSO class).
A rotation with a crop or a cover crop in every month scores 0 days.

**Water** — a daily root-zone water balance (FAO-56 chapter 8), run continuously from 1984 to the
last complete crop year for each rotation, then averaged over the years of each ENSO class.

| Piece | Equation / rule | Source |
|---|---|---|
| Water the root zone can hold | TAW = Σ layers 1000 (θFC − θWP) × thickness, down to the crop's rooting depth Zr (Eq. 82) | θFC = SoilGrids `wv0033`, θWP = `wv1500`, six layers to 2 m |
| Rooting depth, stress threshold | Zr and p per crop; Zr is the **upper** end of the range ("for modeling soil water stress or for rainfed conditions", note 1); p adjusted daily: p + 0.04 (5 − ETc), 0.1–0.8 (note 2) | FAO-56 Table 22 |
| Readily available water | RAW = p × TAW (Eq. 83) | |
| Daily depletion | Dr = Dr(yesterday) − rain + ET (Eq. 85); rain below 0.2 ET0 ignored; water above field capacity drains (Eqs. 86, 88); no irrigation, runoff or capillary rise | FAO-56 ch. 8 |
| Stress | Ks = 1 while Dr ≤ RAW, else (TAW − Dr) / ((1 − p) TAW) (Eq. 84); actual ET = Ks × Kc × ET0 (Eq. 80) | FAO-56 ch. 8 |
| Fallow | Kc = Kc ini of the crop just harvested; bare soil only dries its top layer, so evaporation stops once Dr > TEW = 1000 (θFC − 0.5 θWP) × 0.125 m (Eq. 73, Ze 0.10–0.15 m) | FAO-56 ch. 11, ch. 7 |
| Hand-over month | first crop days 1–15, next crop from day 16 | project choice |

The measured value is Σ over cropped days of (Kc ET0 − Ks Kc ET0): water the crop needed and did not
get. The card also shows **stress days** (days with Ks < 1), the month where most of it happens, the
TAW of each crop's root zone, and how many years the mean rests on. The model reproduces FAO-56's
equations exactly (`tests/test_soilwater.py`: Eq. 84 by hand, TAW/TEW integration, percolation,
evaporation cut-off).

Because water is stored between days, a wet week helps the dry week that follows, and a three-week
*veranico* inside a rainy month is felt — the monthly balance it replaces could do neither.

**Income** = (Σ revenue × (1 + yield anomaly)) / (Σ revenue) − 1, over the rotation's cash crops:
- *revenue*: IBGE PAM production value ÷ harvested area, mean of the last 5 years, nominal R$;
- *yield anomaly*: the crop's mean deviation from its yield trend in years of that ENSO class (the
  same composites shown in the yield section; winter crops are matched to the ENSO they grew
  through);
- cover crops have no revenue. It is income **stability**: a rotation that earns less but loses
  nothing in El Niño years can beat one that earns more and loses a third.

### 4. Scores and total (`normalise`, `weighted_total`, `rank`)

Each component is min–max scaled across the candidates of that municipality and ENSO class:
100 = best candidate on that priority, 0 = worst (all equal → all 100). Then

```
total = (w_soil × score_soil + w_water × score_water + w_income × score_income) / (w_soil + w_water + w_income)
```

over the priorities with weight > 0. The interface's sliders set the weights (0 Ignore … 3 High) and
recompute the total in the browser with the same formula (`web/src/fieldphase/scoring.ts`); the API
also ranks for any weights: `/api/v1/municipalities/{code}/rotations?soil=3&water=1&income=1&enso_class=la_nina`.

**Missing data is never filled in.** If a cash crop has no yield history for that ENSO class
(canola in Tupanciretã: fewer than 10 PAM years), its income component is empty, the rotation gets
no total while income has weight, and the card says why. Set income to "Ignore" and it is ranked on
soil and water.

## Where every parameter comes from

| Parameter | Source | Status |
|---|---|---|
| Kc ini / mid / end | FAO-56 Table 12, read from [fao.org](https://www.fao.org/4/x0490e/x0490e0b.htm) 2026-11-14; ranges → midpoint | cited |
| ET0 method | FAO-56 Penman–Monteith, [chapters 2–4](https://www.fao.org/4/x0490e/x0490e00.htm) | cited, tested against Example 18 |
| Heavy-rain threshold 20 mm | ETCCDI R20mm (same as the evidence section) | cited |
| Rain, heavy days, ET0 inputs | NASA POWER, this municipality, by ENSO class | data |
| Zr (upper end of range), p | FAO-56 Table 22, read from [fao.org](https://www.fao.org/4/x0490e/x0490e0e.htm) 2026-11-14 | cited |
| Water balance equations, fallow Kc, TEW | FAO-56 Eqs. 73, 80–88, [ch. 8](https://www.fao.org/4/x0490e/x0490e0e.htm), [ch. 7](https://www.fao.org/4/x0490e/x0490e0c.htm), [ch. 11](https://www.fao.org/4/x0490e/x0490e0h.htm) | cited, tested |
| θFC, θWP per layer | ISRIC SoilGrids 2.0 `wv0033`, `wv1500` at the centroid (250 m model) | data (modelled) |
| Revenue per hectare | IBGE PAM table 1612, last 5 years | data |
| Yield anomaly by ENSO class | IBGE PAM, linear-trend anomalies (evidence section) | data |
| Sowing / harvest months | general agronomic knowledge | **`suposicao`** — the CONAB *Calendário de Plantio e Colheita de Grãos no Brasil* (2022) is the source to check against ([PDF](https://antigo.conab.gov.br/outras-publicacoes/item/download/45710_77f0a5ee35e765e2248999f4c61e70c8)); it could not be read from the build environment (TLS certificate mismatch on CONAB's server). The UI shows the assumption warning. |
| Candidate list | crops IBGE records in each municipality, plus one cover crop per region | project choice |
| Min–max scaling, equal default weights | | project choice |

## Results for the current season (forecast: strong El Niño), equal weights

**Tupanciretã (RS)** — root-zone water: soy 78 mm, wheat/oats/canola 88 mm, maize 99 mm (SoilGrids)

| # | Rotation | Soil (heavy-rain days on bare soil) | Water (transpiration lost) | Income | Total |
|---|---|---|---|---|---|
| 1 | Soy → oats (cover) | 0 | 53 mm, 32 stress days | **+15.5 %** | 93 |
| 2 | Soy → oats (grain) | 0 | 53 mm | +4.4 % | 74 |
| 3 | Soy → fallow | **16.8 days** | 50 mm | +15.5 % | 67 |
| 4 | Maize → oats (cover) | 2.2 | 51 mm | −3.1 % (n = 2) | 62 |
| 5 | Soy → wheat | 3.0 | 66 mm | **−4.4 %** (wheat −32.5 %) | 27 |
| — | Soy → canola | 0 | 52 mm | no canola history | unranked |

**Switch to La Niña**: soy → grain oats 100, soy → cover oats 87, **soy → wheat 83 (from 27)**,
soy → fallow 54, maize → cover oats 29. Water stress roughly triples in La Niña years (soy: 153 mm
lost, 69 stress days, mostly January) — the southern drought side of the dipole.

**Luís Eduardo Magalhães (BA)**, strong El Niño — root zone: soy 151 mm, maize/cotton 194 mm,
sorghum/millet 226 mm: maize → fallow 94, soy → millet (cover) 60, soy → fallow 59, soy → sorghum 46
(237 mm lost, 102 stress days, May–July), cotton 14 (374 mm lost). Income rests on **n = 2** strong
El Niño years and every card says so.

**What the bucket changed.** Storing water between days cut cotton's El Niño deficit from 491 mm
(monthly balance) to 374 mm and sorghum's from 383 to 237 mm; it also made water stress visible in
Tupanciretã's El Niño years (the monthly balance showed none) — January dry spells inside wet months.

## Limitations (also stated in the interface)

- **Min–max scaling exaggerates small differences.** In Tupanciretã under El Niño the six rotations'
  water stress spans only 50–66 mm, yet scaling turns that 16 mm into scores of 100 vs 0, and it is
  what drops soy → wheat from 61 to 27. Raw values are always shown beside the scores. A better
  alternative is under discussion: absolute scales with physical meaning (share of the year's
  heavy rain falling on covered soil; share of crop water demand met; revenue kept in the class).
- **Soil properties are modelled.** SoilGrids is a 250 m prediction at the centroid. It gives the
  clay soil of Tupanciretã less available water (≈ 63 mm per metre) than LEM's sandier soil
  (≈ 118 mm/m), which field experience with Latossolos may contradict. TAW drives the water score:
  check it against local soil analyses.
- **One bucket, full roots from sowing, no runoff.** Early-season stress is understated; heavy rain
  that would run off is treated as infiltrating and then draining.
- **Gross revenue, not margin.** Production costs are not included (cotton is expensive to grow).
- **Calendars are assumptions** until checked against CONAB.
- **Small samples** for strong El Niño (n = 2–4 years in the water balance, 2–5 in yields) — every
  card shows n.
