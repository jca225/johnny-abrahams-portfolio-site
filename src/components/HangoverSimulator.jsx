import { useState, useMemo } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";

// ─── MODEL ────────────────────────────────────────────────────────────────────
const DT = 1 / 60;
const SIM_START = 16;
const SIM_END = 40;
const SLEEP_HOURS = 7.5;

// One "standard drink" = 14 g ethanol everywhere.
// peakHr  : time to peak BAC contribution from a single drink (gamma-shaped absorption)
// congeners (0..1): relative congener / sugar load — drives next-day inflammation
const DRINK_TYPES = {
  beer:    { label: "Beer",    peakHr: 0.55, etoh: 14, congeners: 0.10, emoji: "🍺" },
  wine:    { label: "Wine",    peakHr: 0.40, etoh: 14, congeners: 0.65, emoji: "🍷" },
  spirits: { label: "Spirits", peakHr: 0.30, etoh: 14, congeners: 0.40, emoji: "🥃" },
  shot:    { label: "Shot",    peakHr: 0.20, etoh: 14, congeners: 0.40, emoji: "🔥" },
};

// Volume of distribution (Widmark): male 0.68 L/kg, female 0.55 L/kg.
function Vd(weightKg, sex) { return sex === "male" ? 0.68 * weightKg : 0.55 * weightKg; }

// Michaelis–Menten elimination — at high BAC behaves zero-order at ~Vmax,
// at low BAC the rate falls off linearly through 0.
const KM_BAC = 0.005;                                      // g/dL
function vmaxFor(weightKg) {
  // Reported population Vmax 0.012 – 0.020 g/dL/hr; use 0.017 with mild weight scaling.
  return 0.017 + (weightKg - 70) * 0.00005;
}
function eliminationDelta(BAC, weightKg, vmaxMult) {
  if (BAC <= 0) return 0;
  const v = vmaxFor(weightKg) * vmaxMult;
  return Math.min(BAC, (v * BAC / (KM_BAC + BAC)) * DT);
}

// Gamma-shaped absorption — area under curve = etoh grams.
function absorptionRate(t, drinkType, food) {
  const { peakHr, etoh } = DRINK_TYPES[drinkType];
  const peak = food ? peakHr * 1.8 : peakHr;
  const k = 2 / peak;
  if (t < 0) return 0;
  return etoh * k * k * t * Math.exp(-k * t);
}

function sigmoid(x, midpoint, steepness) { return 1 / (1 + Math.exp(-steepness * (x - midpoint))); }

function formatHour(h) {
  const norm = ((h % 24) + 24) % 24;
  const ampm = norm >= 12 ? "PM" : "AM";
  const display = norm > 12 ? norm - 12 : norm === 0 ? 12 : norm;
  const mins = Math.round((display % 1) * 60);
  return `${Math.floor(display)}${mins > 0 ? `:${String(mins).padStart(2,"0")}` : ""}${ampm}`;
}

function simulate(params) {
  const { weightKg, sex, bedtimeHr, food, drinks, substance, running } = params;

  const Vd_val = Vd(weightKg, sex);
  // Acetaldehyde clearance (population mean ALDH2 activity).
  const k_acald = 0.28;

  const substanceEffects = {
    none:     { vmaxMult: 1.00, perceivedBedtimeShift: 0,   acaldMult: 1.0 },
    caffeine: { vmaxMult: 0.92, perceivedBedtimeShift: 1.5, acaldMult: 1.1 },
    adderall: { vmaxMult: 0.85, perceivedBedtimeShift: 3.0, acaldMult: 1.2 },
    bag:      { vmaxMult: 0.75, perceivedBedtimeShift: 4.0, acaldMult: 1.5 },
  };
  const subst = substanceEffects[substance];

  let BAC = 0, AcAld = 0;
  const timeline = [];
  let BACatSleepOnset = null, AcAlDateSleepOnset = null;
  let maxBAC = 0, maxAcAld = 0;

  for (let t = SIM_START; t <= SIM_END; t += DT) {
    let totalAbsorption = 0;
    drinks.forEach(d => {
      if (t >= d.hour) {
        totalAbsorption += absorptionRate(t - d.hour, d.type, food) / (Vd_val * 10);
      }
    });

    const elim = eliminationDelta(BAC, weightKg, subst.vmaxMult);
    BAC = Math.max(0, BAC + totalAbsorption * DT - elim);

    // Acetaldehyde balance: produced from elimination flux, cleared first-order.
    const acaldProduction = (elim / DT) * 0.15 * subst.acaldMult;
    AcAld = Math.max(0, AcAld + (acaldProduction - k_acald * AcAld) * DT);

    const gamma = Math.min(0.99, 0.3 + 0.7 * (BAC / 0.15));
    maxBAC = Math.max(maxBAC, BAC);
    maxAcAld = Math.max(maxAcAld, AcAld);

    if (Math.abs(t - bedtimeHr) < DT) { BACatSleepOnset = BAC; AcAlDateSleepOnset = AcAld; }

    if (Math.round(t * 60) % 6 === 0) {
      timeline.push({
        t: Math.round(t * 10) / 10,
        hour: formatHour(t),
        BAC: Math.round(BAC * 1000) / 1000,
        AcAld: Math.round(AcAld * 1000) / 1000,
        gamma: Math.round(gamma * 100) / 100,
        perceivedFun: Math.round(gamma * 10 * 10) / 10,
        actualCost: Math.round(Math.max(0.3, (t - bedtimeHr <= 0 ? Math.abs(t - bedtimeHr) : 3 * (t - bedtimeHr))) * (1 + BAC * 5) * 10) / 10,
      });
    }
  }

  const bacOnset = BACatSleepOnset ?? 0;
  const acaldOnset = AcAlDateSleepOnset ?? 0;

  // ── Hangover composition ──────────────────────────────────────────────────
  // 1. SWS suppression (slow-wave, second half of the night, dominant in late-night BAC presence)
  const SWS_disruption = sigmoid(bacOnset, 0.04, 40);

  // 2. REM suppression — first half driven by BAC, second-half rebound is fragmenting
  const BACdropRate = bacOnset / SLEEP_HOURS;
  const reboundFrag = Math.min(1, BACdropRate / 0.02);
  const REM_disruption = 0.4 * sigmoid(bacOnset, 0.03, 35) + 0.6 * reboundFrag;

  // 3. Acetaldehyde + congener inflammatory load
  const totalGrams = drinks.reduce((s, d) => s + DRINK_TYPES[d.type].etoh, 0);
  const meanCongeners = drinks.length === 0
    ? 0
    : drinks.reduce((s, d) => s + DRINK_TYPES[d.type].congeners, 0) / drinks.length;
  const acaldComponent = Math.min(1, acaldOnset / 0.05);
  const congenerComponent = meanCongeners * Math.min(1, totalGrams / 60);
  const inflammatoryScore = 0.65 * acaldComponent + 0.35 * congenerComponent;

  // 4. Dehydration — alcohol is a vasopressin antagonist; load grows ~linearly with grams
  const dehydrationScore = Math.min(1, totalGrams / 90);   // 90g ≈ 6.4 standard drinks

  // 5. Sleep fragmentation — ramp-up of BAC clearance during sleep means microarousals
  const fragmentationScore = Math.min(1, BACdropRate / 0.025);

  // 6. Compose. Five terms, each weighted equally (0.20 × 5 = 1.0). Scale to 0–10.
  const runningDiscount = running ? 0.72 : 1.0;
  const rawHangover = (
    0.20 * SWS_disruption +
    0.20 * REM_disruption +
    0.20 * inflammatoryScore +
    0.20 * dehydrationScore +
    0.20 * fragmentationScore
  ) * 10;
  const hangoverScore = Math.min(10, rawHangover * runningDiscount);

  // ── Sleep architecture profile ────────────────────────────────────────────
  const sleepData = [];
  for (let i = 0; i < SLEEP_HOURS; i += 0.25) {
    const frac = i / SLEEP_HOURS;
    const isFirstHalf = frac < 0.5;
    const normalSWS = frac < 0.5 ? Math.sin(frac * Math.PI * 2) * 0.8 : 0.1;
    const normalREM = frac > 0.5 ? Math.sin((frac - 0.5) * Math.PI * 2) * 0.9 : 0.05;
    // Alcohol increases SWS modestly in the first ~third (anesthetic-like), then
    // dramatically suppresses SWS and fragments sleep in the back half.
    const swsBoost = isFirstHalf ? sigmoid(bacOnset, 0.04, 35) * 0.25 : 0;
    const swsLoss  = isFirstHalf ? 0 : SWS_disruption * (frac - 0.5) * 2;
    const actualSWS = normalSWS * (1 + swsBoost - swsLoss);
    // REM is suppressed in first half; rebounds (fragmented) in second half.
    const remLoss   = isFirstHalf ? sigmoid(bacOnset, 0.03, 35) : 0;
    const remRebound= isFirstHalf ? 0 : reboundFrag * 0.3;
    const actualREM = normalREM * (1 - remLoss) * (1 - remRebound * (frac - 0.5));
    sleepData.push({
      hour: formatHour(bedtimeHr + i),
      "Ideal SWS": Math.round(normalSWS * 100) / 100,
      "Ideal REM": Math.round(normalREM * 100) / 100,
      "Actual SWS": Math.round(Math.max(0, actualSWS) * 100) / 100,
      "Actual REM": Math.round(Math.max(0, actualREM) * 100) / 100,
    });
  }

  return {
    timeline, sleepData,
    hangoverScore: Math.round(hangoverScore * 10) / 10,
    SWS_disruption: Math.round(SWS_disruption * 100),
    REM_disruption: Math.round(REM_disruption * 100),
    inflammatoryScore: Math.round(inflammatoryScore * 100),
    dehydrationScore: Math.round(dehydrationScore * 100),
    fragmentationScore: Math.round(fragmentationScore * 100),
    maxBAC: Math.round(maxBAC * 1000) / 1000,
    bacOnset: Math.round(bacOnset * 1000) / 1000,
    totalGrams: Math.round(totalGrams),
    drinkCount: drinks.length,
  };
}

function hangoverMeta(score) {
  if (score < 2) return { label: "You're fine", emoji: "😌", color: "#3d9970", bg: "#f0faf5" };
  if (score < 4) return { label: "A bit groggy", emoji: "😴", color: "#b07d2e", bg: "#fdf8ee" };
  if (score < 6) return { label: "Rough morning", emoji: "😮‍💨", color: "#c07030", bg: "#fdf3ee" };
  if (score < 8) return { label: "Bad day", emoji: "🤕", color: "#c04040", bg: "#fdf0f0" };
  return { label: "Bed-ridden", emoji: "💀", color: "#8b1a1a", bg: "#fdf0f0" };
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

function Section({ title, icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid #e9e9e7", paddingBottom: open ? 20 : 0 }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 6, background: "none", border: "none",
        cursor: "pointer", padding: "16px 0 12px", width: "100%", textAlign: "left",
      }}>
        <span style={{ fontSize: 13, color: "#9b9b97", transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}>▶</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#37352f", letterSpacing: "-0.01em" }}>{icon} {title}</span>
      </button>
      {open && <div style={{ paddingLeft: 4 }}>{children}</div>}
    </div>
  );
}

function PropertyRow({ label, children, hint }) {
  return (
    <div style={{ display: "flex", alignItems: "center", minHeight: 36, gap: 0, borderRadius: 4, padding: "2px 4px", margin: "1px -4px" }}
      onMouseEnter={e => e.currentTarget.style.background = "#f1f1ef"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <div style={{ width: 180, flexShrink: 0, fontSize: 13, color: "#787774", display: "flex", alignItems: "center", gap: 6 }}>
        {label}
      </div>
      <div style={{ flex: 1, fontSize: 13, color: "#37352f" }}>{children}</div>
      {hint && <div style={{ fontSize: 11, color: "#c0bfbb", marginLeft: 8 }}>{hint}</div>}
    </div>
  );
}

function Tag({ children, active, onClick, color = "#37352f", bg = "#f1f1ef", activeBg = "#e3e3e0" }) {
  return (
    <button onClick={onClick} style={{
      padding: "3px 10px", borderRadius: 4, border: "none",
      background: active ? activeBg : bg,
      color: active ? color : "#9b9b97",
      fontSize: 12, cursor: "pointer", fontFamily: "inherit",
      fontWeight: active ? 500 : 400,
      transition: "all 0.1s",
      outline: active ? `1.5px solid ${color}40` : "none",
    }}>
      {children}
    </button>
  );
}

function SliderProp({ label, value, min, max, step = 1, onChange, display, hint }) {
  return (
    <PropertyRow label={label} hint={hint}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)}
          style={{ flex: 1, accentColor: "#37352f", height: 3, cursor: "pointer" }} />
        <span style={{ fontSize: 12, color: "#37352f", minWidth: 60, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {display ?? value}
        </span>
      </div>
    </PropertyRow>
  );
}

function Toggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} style={{
      width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
      background: value ? "#37352f" : "#e0dfdd", position: "relative", transition: "background 0.2s",
    }}>
      <div style={{
        width: 14, height: 14, borderRadius: 7, background: "#fff",
        position: "absolute", top: 3, left: value ? 19 : 3, transition: "left 0.2s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

function StatCard({ label, value, sub, warn, good }) {
  const color = warn ? "#c04040" : good ? "#3d9970" : "#37352f";
  return (
    <div style={{
      padding: "14px 16px", background: "#fbfbfa", border: "1px solid #e9e9e7",
      borderRadius: 8, flex: 1, minWidth: 120,
    }}>
      <div style={{ fontSize: 11, color: "#9b9b97", marginBottom: 6, letterSpacing: "0.02em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color, letterSpacing: "-0.03em", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#b0aeaa", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const MAX_PER_SLOT = 4;

function DrinkGrid({ drinks, setDrinks, drinkType }) {
  const slots = [];
  for (let h = 16; h <= 29.5; h += 0.5) slots.push(h);

  // Click cycles count up to MAX_PER_SLOT, then back to 0.
  const cycle = (hour, evt) => {
    const here = drinks.filter(d => d.hour === hour);
    const others = drinks.filter(d => d.hour !== hour);
    if (evt.shiftKey || evt.altKey) {
      // shift/alt-click: remove one
      if (here.length === 0) return;
      const next = here.slice(0, -1);
      setDrinks([...others, ...next].sort((a, b) => a.hour - b.hour));
      return;
    }
    if (here.length >= MAX_PER_SLOT) {
      setDrinks(others.sort((a, b) => a.hour - b.hour));
    } else {
      const next = [...here, { hour, type: drinkType }];
      setDrinks([...others, ...next].sort((a, b) => a.hour - b.hour));
    }
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {slots.map(h => {
          const here = drinks.filter(d => d.hour === h);
          const count = here.length;
          const active = count > 0;
          const topType = active ? here[here.length - 1].type : null;
          const isMid = h === 24;
          const is2am = h === 26;
          return (
            <button
              key={h}
              onClick={(e) => cycle(h, e)}
              title={`${formatHour(h)} — ${count} drink${count !== 1 ? "s" : ""}${count > 0 ? " (shift-click to remove)" : ""}`}
              style={{
                position: "relative",
                width: 38, height: 38, borderRadius: 6, border: "1px solid",
                borderColor: active ? "#37352f" : isMid ? "#c0bfbb" : is2am ? "#e0a0a0" : "#e9e9e7",
                background: active ? "#37352f" : "#fbfbfa",
                color: active ? "#fff" : isMid ? "#9b9b97" : is2am ? "#c07070" : "#c0bfbb",
                cursor: "pointer", fontSize: active ? 16 : 9,
                fontFamily: "inherit", transition: "all 0.1s",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {active ? DRINK_TYPES[topType].emoji : formatHour(h).replace(":00","").replace("PM","p").replace("AM","a")}
              {count > 1 && (
                <span style={{
                  position: "absolute", top: -6, right: -6,
                  background: "#c04040", color: "#fff",
                  fontSize: 10, fontWeight: 600,
                  borderRadius: 9, width: 18, height: 18,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "'system-ui', sans-serif",
                  border: "1.5px solid #fbfbfa",
                  fontVariantNumeric: "tabular-nums",
                }}>×{count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 11, color: "#c0bfbb", flexWrap: "wrap" }}>
        <span>▏midnight</span>
        <span style={{ color: "#e0a0a0" }}>▏2am — diminishing returns</span>
        <span style={{ marginLeft: "auto" }}>click to add · shift-click to remove</span>
      </div>
    </div>
  );
}

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e9e9e7", padding: "8px 12px", borderRadius: 8, fontSize: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}>
      <div style={{ color: "#9b9b97", marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: "#37352f", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: p.color || p.stroke }} />
          <span style={{ color: "#787774" }}>{p.name}:</span>
          <span style={{ fontWeight: 500 }}>{typeof p.value === "number" ? p.value.toFixed(3) : p.value}</span>
        </div>
      ))}
    </div>
  );
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function HangoverNotion() {
  const [weightKg, setWeightKg] = useState(75);
  const [sex, setSex] = useState("male");
  const [bedtimeHr, setBedtimeHr] = useState(23);
  const [food, setFood] = useState(true);
  const [substance, setSubstance] = useState("none");
  const [running, setRunning] = useState(false);
  const [drinkType, setDrinkType] = useState("beer");
  const [drinks, setDrinks] = useState([
    { hour: 20, type: "beer" }, { hour: 20.5, type: "beer" },
    { hour: 21, type: "beer" }, { hour: 21.5, type: "beer" },
    { hour: 22, type: "beer" }, { hour: 22.5, type: "beer" },
  ]);
  const [chartTab, setChartTab] = useState("bac");

  const result = useMemo(() => simulate({ weightKg, sex, bedtimeHr, food, drinks, substance, running }),
    [weightKg, sex, bedtimeHr, food, drinks, substance, running]);

  const meta = hangoverMeta(result.hangoverScore);

  return (
    <div style={{
      minHeight: "100vh", background: "#fff", color: "#37352f",
      fontFamily: "'Georgia', 'Charter', serif",
    }}>
      <style>{`
        input[type=range] { -webkit-appearance: none; appearance: none; background: #e9e9e7; border-radius: 2px; height: 3px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 7px; background: #37352f; cursor: pointer; }
        ::selection { background: #d4e8ff; }
      `}</style>

      {/* Page header */}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "60px 96px 0" }}>
        <div style={{ marginBottom: 8, fontSize: 13, color: "#9b9b97" }}>
          🧪 Science / Weekend Optimization
        </div>
        <h1 style={{
          fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.15,
          color: "#37352f", marginBottom: 8,
        }}>
          Hangover Simulator
        </h1>
        <p style={{ fontSize: 16, color: "#787774", lineHeight: 1.6, maxWidth: 580, marginBottom: 32 }}>
          ODE-based model of BAC (Widmark + Michaelis–Menten elimination), acetaldehyde and
          congener inflammation, dehydration load, and sleep architecture disruption.
        </p>

        {/* Score callout */}
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 16,
          background: meta.bg, border: `1px solid ${meta.color}30`,
          borderRadius: 12, padding: "16px 24px", marginBottom: 40,
        }}>
          <span style={{ fontSize: 36 }}>{meta.emoji}</span>
          <div>
            <div style={{ fontSize: 13, color: meta.color, fontFamily: "'system-ui', sans-serif", fontWeight: 500 }}>Predicted next-day outcome</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: meta.color, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
              {meta.label} <span style={{ fontSize: 18, opacity: 0.6 }}>({result.hangoverScore}/10)</span>
            </div>
          </div>
        </div>

        {/* Stat row */}
        <div style={{ display: "flex", gap: 10, marginBottom: 48, flexWrap: "wrap" }}>
          <StatCard label="Peak BAC" value={`${result.maxBAC} g/dL`}
            sub={result.maxBAC > 0.08 ? "Above legal limit" : "Below legal limit"}
            warn={result.maxBAC > 0.08} good={result.maxBAC < 0.04} />
          <StatCard label="BAC at sleep onset" value={`${result.bacOnset} g/dL`}
            sub="Drives SWS suppression" warn={result.bacOnset > 0.04} good={result.bacOnset === 0} />
          <StatCard label="SWS suppression" value={`${result.SWS_disruption}%`}
            sub="Slow-wave, late night" warn={result.SWS_disruption > 50} />
          <StatCard label="REM disruption" value={`${result.REM_disruption}%`}
            sub="Suppressed early, rebound late" warn={result.REM_disruption > 50} />
          <StatCard label="Inflammation" value={`${result.inflammatoryScore}%`}
            sub="Acetaldehyde + congeners" warn={result.inflammatoryScore > 60} />
          <StatCard label="Dehydration" value={`${result.dehydrationScore}%`}
            sub={`${result.totalGrams} g ethanol total`} warn={result.dehydrationScore > 60} />
          <StatCard label="Fragmentation" value={`${result.fragmentationScore}%`}
            sub="Clearance microarousals" warn={result.fragmentationScore > 60} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80 }}>
          {/* LEFT: Properties */}
          <div>
            <Section title="Physiology" icon="🧬">
              <SliderProp label="Body weight" value={weightKg} min={45} max={130} onChange={setWeightKg}
                display={`${weightKg} kg`} hint={`${Math.round(weightKg * 2.205)} lb`} />
              <PropertyRow label="Sex" hint="affects Vd (volume of distribution)">
                <div style={{ display: "flex", gap: 6 }}>
                  <Tag active={sex === "male"} onClick={() => setSex("male")} color="#37352f" activeBg="#e3e3e0">Male (Vd 0.68)</Tag>
                  <Tag active={sex === "female"} onClick={() => setSex("female")} color="#37352f" activeBg="#e3e3e0">Female (Vd 0.55)</Tag>
                </div>
              </PropertyRow>
              <SliderProp label="Usual bedtime" value={bedtimeHr} min={21} max={26} step={0.5} onChange={setBedtimeHr}
                display={formatHour(bedtimeHr)} />
              <PropertyRow label="Food in stomach" hint="1.8× slower absorption">
                <Toggle value={food} onChange={setFood} />
              </PropertyRow>
            </Section>

            <Section title="Modifiers" icon="⚗️">
              <PropertyRow label="Other substances">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {[
                    { k: "none", label: "None" },
                    { k: "caffeine", label: "☕ Caffeine" },
                    { k: "adderall", label: "💊 Adderall" },
                    { k: "bag", label: "👜 Bag" },
                  ].map(({ k, label }) => (
                    <Tag key={k} active={substance === k} onClick={() => setSubstance(k)}
                      color={k === "none" ? "#37352f" : "#c04040"} activeBg={k === "none" ? "#e3e3e0" : "#fde8e8"}>
                      {label}
                    </Tag>
                  ))}
                </div>
              </PropertyRow>
              {substance !== "none" && (
                <div style={{ fontSize: 12, color: "#c07030", background: "#fdf8ee", borderRadius: 6, padding: "8px 12px", margin: "6px 0", border: "1px solid #f0e0b0" }}>
                  ⚠ Shifts perceived bedtime later, slows ethanol elimination — BAC at sleep onset will be higher than expected
                </div>
              )}
              <PropertyRow label="Morning run" hint="−28% hangover score">
                <Toggle value={running} onChange={setRunning} />
              </PropertyRow>
            </Section>

            <Section title="Model equations" icon="∂" defaultOpen={false}>
              <div style={{ fontFamily: "'Courier New', monospace", fontSize: 12, color: "#787774", lineHeight: 2, padding: "8px 0" }}>
                <div>dBAC/dt = Σ absorption_i(t) − V·BAC/(K_m + BAC)</div>
                <div>dAcAld/dt = k_prod·(elim flux) − k_clear·AcAld</div>
                <div style={{ marginTop: 8 }}>V_max ≈ 0.017 g/dL/hr · K_m = 0.005</div>
                <div>Vd(♂) = 0.68 L/kg · Vd(♀) = 0.55 L/kg</div>
                <div>γ(t) = min(0.99, 0.3 + 0.7·BAC/0.15)</div>
                <div style={{ marginTop: 8 }}>H = 0.20·SWS + 0.20·REM + 0.20·Infl</div>
                <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ 0.20·Dehyd + 0.20·Frag</div>
                <div>SWS = σ(BAC_onset, μ=0.04, k=40)</div>
                <div>REM = 0.4·σ(BAC, 0.03) + 0.6·rebound</div>
                <div>Infl = 0.65·AcAld + 0.35·congener·dose</div>
                <div>Dehyd = min(1, total_g / 90)</div>
                <div>Frag = min(1, BAC_drop_rate / 0.025)</div>
              </div>
            </Section>
          </div>

          {/* RIGHT: Drink schedule + charts */}
          <div>
            <Section title="Drink schedule" icon="🍺">
              <PropertyRow label="Drink type">
                <div style={{ display: "flex", gap: 5 }}>
                  {Object.entries(DRINK_TYPES).map(([k, v]) => (
                    <Tag key={k} active={drinkType === k} onClick={() => setDrinkType(k)}>{v.emoji} {v.label}</Tag>
                  ))}
                </div>
              </PropertyRow>
              <div style={{ marginTop: 12 }}>
                <DrinkGrid drinks={drinks} setDrinks={setDrinks} drinkType={drinkType} />
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: "#9b9b97" }}>
                {result.drinkCount} drink{result.drinkCount !== 1 ? "s" : ""} · {result.totalGrams} g ethanol
                {drinks.length > 0 && ` · last at ${formatHour(Math.max(...drinks.map(d => d.hour)))}`}
              </div>
            </Section>

            <Section title="Charts" icon="📊">
              {/* Tab bar */}
              <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #e9e9e7", marginBottom: 16 }}>
                {[
                  { id: "bac", label: "BAC & AcAld" },
                  { id: "rl", label: "RL Discounting" },
                  { id: "sleep", label: "Sleep Architecture" },
                ].map(t => (
                  <button key={t.id} onClick={() => setChartTab(t.id)} style={{
                    background: "none", border: "none", borderBottom: `2px solid ${chartTab === t.id ? "#37352f" : "transparent"}`,
                    padding: "6px 12px", fontSize: 12, color: chartTab === t.id ? "#37352f" : "#9b9b97",
                    cursor: "pointer", fontFamily: "inherit", marginBottom: -1, transition: "all 0.15s",
                  }}>
                    {t.label}
                  </button>
                ))}
              </div>

              {chartTab === "bac" && (
                <div>
                  <p style={{ fontSize: 12, color: "#9b9b97", marginBottom: 12, lineHeight: 1.5 }}>
                    BAC computed via Widmark ODE with gamma-distributed absorption per drink type
                    and Michaelis–Menten elimination. Acetaldehyde follows first-order clearance.
                  </p>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={result.timeline}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f1ef" />
                      <XAxis dataKey="hour" tick={{ fill: "#c0bfbb", fontSize: 10 }} interval={11} />
                      <YAxis yAxisId="bac" tick={{ fill: "#c0bfbb", fontSize: 10 }} domain={[0, "auto"]} />
                      <YAxis yAxisId="acald" orientation="right" tick={{ fill: "#c0bfbb", fontSize: 10 }} />
                      <Tooltip content={<ChartTooltip />} />
                      <ReferenceLine yAxisId="bac" y={0.08} stroke="#e0a0a0" strokeDasharray="4 2" label={{ value: "0.08 legal", fill: "#e0a0a0", fontSize: 10 }} />
                      <ReferenceLine yAxisId="bac" y={0.03} stroke="#c8d8a0" strokeDasharray="4 2" label={{ value: "0.03 REM", fill: "#9b9b97", fontSize: 10 }} />
                      <ReferenceLine yAxisId="bac" x={formatHour(bedtimeHr)} stroke="#c0bfbb" strokeDasharray="2 2" label={{ value: "sleep", fill: "#c0bfbb", fontSize: 10 }} />
                      <Line yAxisId="bac" type="monotone" dataKey="BAC" stroke="#37352f" strokeWidth={2} dot={false} name="BAC (g/dL)" />
                      <Line yAxisId="acald" type="monotone" dataKey="AcAld" stroke="#c07030" strokeWidth={1.5} dot={false} name="Acetaldehyde" strokeDasharray="5 3" />
                      <Legend wrapperStyle={{ fontSize: 11, color: "#9b9b97" }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {chartTab === "rl" && (
                <div>
                  <p style={{ fontSize: 12, color: "#9b9b97", marginBottom: 12, lineHeight: 1.5 }}>
                    Discount factor γ = 0.3 + 0.7·(BAC/0.15). As BAC rises, drunk-you weights
                    immediate fun heavily and discounts tomorrow's misery almost entirely.
                  </p>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={result.timeline.filter(d => d.t <= bedtimeHr + 1)}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f1ef" />
                      <XAxis dataKey="hour" tick={{ fill: "#c0bfbb", fontSize: 10 }} interval={11} />
                      <YAxis yAxisId="left" tick={{ fill: "#c0bfbb", fontSize: 10 }} domain={[0, 1]} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fill: "#c0bfbb", fontSize: 10 }} />
                      <Tooltip content={<ChartTooltip />} />
                      <ReferenceLine yAxisId="left" y={0.67} stroke="#c0bfbb" strokeDasharray="3 2" label={{ value: "BAC 0.08", fill: "#c0bfbb", fontSize: 10 }} />
                      <Line yAxisId="left" type="monotone" dataKey="gamma" stroke="#37352f" strokeWidth={2} dot={false} name="Discount factor γ" />
                      <Line yAxisId="right" type="monotone" dataKey="perceivedFun" stroke="#3d9970" strokeWidth={1.5} dot={false} name="Perceived fun" />
                      <Line yAxisId="right" type="monotone" dataKey="actualCost" stroke="#c04040" strokeWidth={1.5} dot={false} name="Actual cost" strokeDasharray="4 2" />
                      <Legend wrapperStyle={{ fontSize: 11, color: "#9b9b97" }} />
                    </LineChart>
                  </ResponsiveContainer>
                  <p style={{ fontSize: 11, color: "#c0bfbb", marginTop: 8, fontStyle: "italic" }}>
                    Gap between green and red = how much drunk-you overestimates the next drink
                  </p>
                </div>
              )}

              {chartTab === "sleep" && (
                <div>
                  <p style={{ fontSize: 12, color: "#9b9b97", marginBottom: 12, lineHeight: 1.5 }}>
                    Dashed = ideal. Solid = alcohol-disrupted. SWS gets a small early boost
                    (anesthetic-like), then collapses in the back half. REM is suppressed early
                    and rebounds fragmented as BAC clears.
                  </p>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={result.sleepData}>
                      <defs>
                        {[["sws","#3d9970"],["rem","#4a7fb5"]].map(([id,c]) => (
                          <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={c} stopOpacity={0.15} />
                            <stop offset="95%" stopColor={c} stopOpacity={0.01} />
                          </linearGradient>
                        ))}
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f1ef" />
                      <XAxis dataKey="hour" tick={{ fill: "#c0bfbb", fontSize: 10 }} interval={3} />
                      <YAxis tick={{ fill: "#c0bfbb", fontSize: 10 }} domain={[0, 1]} />
                      <Tooltip content={<ChartTooltip />} />
                      <Area type="monotone" dataKey="Ideal SWS" stroke="#c0d8c0" strokeWidth={1} fill="none" strokeDasharray="4 2" />
                      <Area type="monotone" dataKey="Ideal REM" stroke="#b0c8e0" strokeWidth={1} fill="none" strokeDasharray="4 2" />
                      <Area type="monotone" dataKey="Actual SWS" stroke="#3d9970" strokeWidth={2} fill="url(#sws)" />
                      <Area type="monotone" dataKey="Actual REM" stroke="#4a7fb5" strokeWidth={2} fill="url(#rem)" />
                      <Legend wrapperStyle={{ fontSize: 11, color: "#9b9b97" }} />
                    </AreaChart>
                  </ResponsiveContainer>
                  <div style={{ display: "flex", gap: 20, marginTop: 10, fontSize: 12, flexWrap: "wrap" }}>
                    <span style={{ color: result.SWS_disruption > 50 ? "#c07030" : "#9b9b97" }}>SWS loss: {result.SWS_disruption}%</span>
                    <span style={{ color: result.REM_disruption > 50 ? "#c07030" : "#9b9b97" }}>REM loss: {result.REM_disruption}%</span>
                    <span style={{ color: result.fragmentationScore > 60 ? "#c07030" : "#9b9b97" }}>Fragmentation: {result.fragmentationScore}%</span>
                  </div>
                </div>
              )}
            </Section>
          </div>
        </div>

        {/* Footer */}
        <div style={{ borderTop: "1px solid #e9e9e7", marginTop: 48, padding: "24px 0 60px", fontSize: 12, color: "#c0bfbb", lineHeight: 1.8 }}>
          Widmark BAC · Michaelis–Menten elimination · Gamma absorption · Acetaldehyde &amp;
          congener inflammation · Vasopressin-mediated dehydration · SWS suppression &amp; REM
          rebound · Sleep fragmentation · PFC-impairment discount factor · Nothing good happens
          after 2am.
        </div>
      </div>
    </div>
  );
}
