import { useState, useMemo, useRef } from "react";
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
  return 0.017 + (weightKg - 70) * 0.00005;
}
function eliminationDelta(BAC, weightKg, vmaxMult) {
  if (BAC <= 0) return 0;
  const v = vmaxFor(weightKg) * vmaxMult;
  return Math.min(BAC, (v * BAC / (KM_BAC + BAC)) * DT);
}

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
  const { weightKg, sex, bedtimeHr, food, drinks, substances, running } = params;
  const Vd_val = Vd(weightKg, sex);
  const k_acald = 0.28;

  // Per-substance effects. Stacking is multiplicative on rate multipliers and
  // additive on perceived-bedtime shift — same direction as the underlying
  // physiology (each stimulant slows ethanol clearance, each adds to "stay-up"
  // pressure, and inflammatory markers compound).
  const substanceEffects = {
    caffeine: { vmaxMult: 0.92, perceivedBedtimeShift: 1.5, acaldMult: 1.1 },
    nicotine: { vmaxMult: 0.95, perceivedBedtimeShift: 1.0, acaldMult: 1.3 },
    adderall: { vmaxMult: 0.85, perceivedBedtimeShift: 3.0, acaldMult: 1.2 },
    bag:      { vmaxMult: 0.75, perceivedBedtimeShift: 4.0, acaldMult: 1.5 },
  };
  const subst = (substances ?? []).reduce(
    (acc, key) => {
      const e = substanceEffects[key];
      if (!e) return acc;
      return {
        vmaxMult: acc.vmaxMult * e.vmaxMult,
        perceivedBedtimeShift: acc.perceivedBedtimeShift + e.perceivedBedtimeShift,
        acaldMult: acc.acaldMult * e.acaldMult,
      };
    },
    { vmaxMult: 1.0, perceivedBedtimeShift: 0, acaldMult: 1.0 }
  );

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
  const SWS_disruption = sigmoid(bacOnset, 0.04, 40);
  const BACdropRate = bacOnset / SLEEP_HOURS;
  const reboundFrag = Math.min(1, BACdropRate / 0.02);
  const REM_disruption = 0.4 * sigmoid(bacOnset, 0.03, 35) + 0.6 * reboundFrag;

  const totalGrams = drinks.reduce((s, d) => s + DRINK_TYPES[d.type].etoh, 0);
  const meanCongeners = drinks.length === 0
    ? 0
    : drinks.reduce((s, d) => s + DRINK_TYPES[d.type].congeners, 0) / drinks.length;
  const acaldComponent = Math.min(1, acaldOnset / 0.05);
  const congenerComponent = meanCongeners * Math.min(1, totalGrams / 60);
  const inflammatoryScore = 0.65 * acaldComponent + 0.35 * congenerComponent;
  // Saturation thresholds tightened to match self-reported hangover scales:
  // dehydration tops out around 4 standard drinks (vasopressin suppression
  // saturates fast), and fragmentation kicks in earlier as BAC clears.
  const dehydrationScore = Math.min(1, totalGrams / 60);
  const fragmentationScore = Math.min(1, BACdropRate / 0.018);

  const runningDiscount = running ? 0.72 : 1.0;
  // Equal-weighted mean of five components, scaled to /10. The 1.15× boost
  // pushes mid-range scores toward the "feels right" band: 6 beers ≈ 7,
  // 8 beers ≈ 8. Floor is unchanged for very light drinking.
  const rawHangover = (
    0.20 * SWS_disruption +
    0.20 * REM_disruption +
    0.20 * inflammatoryScore +
    0.20 * dehydrationScore +
    0.20 * fragmentationScore
  ) * 10 * 1.15;
  const hangoverScore = Math.min(10, rawHangover * runningDiscount);

  const sleepData = [];
  for (let i = 0; i < SLEEP_HOURS; i += 0.25) {
    const frac = i / SLEEP_HOURS;
    const isFirstHalf = frac < 0.5;
    const normalSWS = frac < 0.5 ? Math.sin(frac * Math.PI * 2) * 0.8 : 0.1;
    const normalREM = frac > 0.5 ? Math.sin((frac - 0.5) * Math.PI * 2) * 0.9 : 0.05;
    const swsBoost = isFirstHalf ? sigmoid(bacOnset, 0.04, 35) * 0.25 : 0;
    const swsLoss  = isFirstHalf ? 0 : SWS_disruption * (frac - 0.5) * 2;
    const actualSWS = normalSWS * (1 + swsBoost - swsLoss);
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
    <div className="hg-prop-row">
      <div className="hg-prop-label">{label}</div>
      <div className="hg-prop-control">{children}</div>
      {hint && <div className="hg-prop-hint">{hint}</div>}
    </div>
  );
}

function Tag({ children, active, onClick, color = "#37352f", bg = "#f1f1ef", activeBg = "#e3e3e0" }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 12px", borderRadius: 4, border: "none",
      background: active ? activeBg : bg,
      color: active ? color : "#9b9b97",
      fontSize: 13, cursor: "pointer", fontFamily: "inherit",
      fontWeight: active ? 500 : 400,
      transition: "all 0.1s",
      outline: active ? `1.5px solid ${color}40` : "none",
      whiteSpace: "nowrap",
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
          style={{ flex: 1, accentColor: "#37352f", height: 3, cursor: "pointer", minWidth: 0 }} />
        <span style={{ fontSize: 13, color: "#37352f", minWidth: 70, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {display ?? value}
        </span>
      </div>
    </PropertyRow>
  );
}

function Toggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} style={{
      width: 40, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
      background: value ? "#37352f" : "#e0dfdd", position: "relative", transition: "background 0.2s",
      flexShrink: 0,
    }}>
      <div style={{
        width: 18, height: 18, borderRadius: 9, background: "#fff",
        position: "absolute", top: 3, left: value ? 19 : 3, transition: "left 0.2s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

function StatCard({ label, value, sub, warn, good }) {
  const color = warn ? "#c04040" : good ? "#3d9970" : "#37352f";
  return (
    <div className="hg-stat-card">
      <div style={{ fontSize: 11, color: "#9b9b97", marginBottom: 6, letterSpacing: "0.02em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color, letterSpacing: "-0.03em", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#b0aeaa", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const MAX_PER_SLOT = 4;

const DOUBLE_TAP_MS = 280;

function DrinkGrid({ drinks, setDrinks, drinkType }) {
  const slots = [];
  for (let h = 16; h <= 29.5; h += 0.5) slots.push(h);

  // Tap = toggle (empty ↔ 1). Double-tap (or shift-click on desktop) = stack +1 from
  // the slot's pre-tap state, so a single quick double-tap on a 1-drink slot goes to 2,
  // not back to 0.
  const lastTapRef = useRef(null);

  const writeSlot = (hour, nextHere) => {
    const others = drinks.filter(d => d.hour !== hour);
    setDrinks([...others, ...nextHere].sort((a, b) => a.hour - b.hour));
  };

  const stackOnto = (hour, base) => {
    if (base.length >= MAX_PER_SLOT) return base;
    return [...base, { hour, type: drinkType }];
  };

  const handleClick = (hour, evt) => {
    const here = drinks.filter(d => d.hour === hour);
    const allSameAsCurrent = here.length > 0 && here.every(d => d.type === drinkType);

    // Desktop power-user shortcut: shift- or alt-click stacks one drink onto the slot.
    if (evt.shiftKey || evt.altKey) {
      writeSlot(hour, stackOnto(hour, here));
      return;
    }

    const now = Date.now();
    const last = lastTapRef.current;

    // Double-tap on the same slot → undo the toggle and stack +1 instead.
    if (last && last.hour === hour && (now - last.time) < DOUBLE_TAP_MS) {
      lastTapRef.current = null;
      writeSlot(hour, stackOnto(hour, last.prevHere));
      return;
    }

    // Single tap. Three cases:
    //  (a) Empty slot       → add one drink of the currently-selected type.
    //  (b) All-same-as-cur. → clear the slot (toggle off).
    //  (c) Different/mixed  → stack one drink of the current type, so switching
    //                         drink type and tapping is the natural way to mix
    //                         (e.g. add a shot to a slot that already has a beer).
    lastTapRef.current = { hour, prevHere: here, time: now };
    if (here.length === 0) {
      writeSlot(hour, [{ hour, type: drinkType }]);
    } else if (allSameAsCurrent) {
      writeSlot(hour, []);
    } else {
      writeSlot(hour, stackOnto(hour, here));
    }
  };

  return (
    <div>
      <div className="hg-drink-grid">
        {slots.map(h => {
          const here = drinks.filter(d => d.hour === h);
          const count = here.length;
          const active = count > 0;
          // Distinct drink types in this slot, in order of first appearance.
          const uniqueTypes = [];
          here.forEach(d => { if (!uniqueTypes.includes(d.type)) uniqueTypes.push(d.type); });
          const isMixed = uniqueTypes.length > 1;
          const displayEmojis = uniqueTypes.map(t => DRINK_TYPES[t].emoji).join("");
          const slotFontSize = active
            ? (uniqueTypes.length >= 3 ? 11 : uniqueTypes.length === 2 ? 14 : 18)
            : 10;
          const isMid = h === 24;
          const is2am = h === 26;
          // Friendly tooltip: "9PM — 2 beers, 1 shot"
          const breakdown = uniqueTypes
            .map(t => {
              const n = here.filter(d => d.type === t).length;
              return `${n} ${DRINK_TYPES[t].label.toLowerCase()}${n > 1 ? "s" : ""}`;
            })
            .join(", ");
          return (
            <button
              key={h}
              onClick={(e) => handleClick(h, e)}
              title={
                count === 0
                  ? `${formatHour(h)} — empty (tap to add ${DRINK_TYPES[drinkType].label.toLowerCase()})`
                  : `${formatHour(h)} — ${breakdown}`
              }
              className="hg-slot"
              style={{
                borderColor: active ? "#37352f" : isMid ? "#c0bfbb" : is2am ? "#e0a0a0" : "#e9e9e7",
                background: active ? "#37352f" : "#fbfbfa",
                color: active ? "#fff" : isMid ? "#9b9b97" : is2am ? "#c07070" : "#c0bfbb",
                fontSize: slotFontSize,
              }}
            >
              {active ? displayEmojis : formatHour(h).replace(":00","").replace("PM","p").replace("AM","a")}
              {count > 1 && (
                <span
                  className="hg-slot-badge"
                  style={isMixed ? { background: "#c07030" } : undefined}
                >
                  ×{count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="hg-grid-legend">
        <span>▏midnight</span>
        <span style={{ color: "#e0a0a0" }}>▏2am — diminishing returns</span>
        <span className="hg-grid-help">tap = toggle · switch type &amp; tap = mix · double-tap = stack · max 4</span>
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
  const [substances, setSubstances] = useState([]);
  const [running, setRunning] = useState(false);
  const [drinkType, setDrinkType] = useState("beer");
  const [drinks, setDrinks] = useState([
    { hour: 20, type: "beer" }, { hour: 20.5, type: "beer" },
    { hour: 21, type: "beer" }, { hour: 21.5, type: "beer" },
    { hour: 22, type: "beer" }, { hour: 22.5, type: "beer" },
  ]);
  const [chartTab, setChartTab] = useState("bac");

  const result = useMemo(() => simulate({ weightKg, sex, bedtimeHr, food, drinks, substances, running }),
    [weightKg, sex, bedtimeHr, food, drinks, substances, running]);

  const meta = hangoverMeta(result.hangoverScore);

  return (
    <div className="hg-page">
      <style>{`
        /* ── Layout shell ─────────────────────────────────────────────────── */
        .hg-page {
          background: #fff;
          color: #37352f;
          font-family: 'Charter', 'Georgia', serif;
        }
        .hg-content {
          max-width: 900px;
          margin: 0 auto;
          padding: clamp(28px, 6vw, 60px) clamp(20px, 5vw, 96px) clamp(40px, 8vw, 60px);
        }

        /* ── Header ──────────────────────────────────────────────────────── */
        .hg-eyebrow { font-family: 'system-ui', sans-serif; font-size: 12px; color: #9b9b97; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 10px; }
        .hg-title { font-size: clamp(28px, 6vw, 40px); font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; color: #37352f; margin: 0 0 10px; }
        .hg-blurb { font-size: clamp(14px, 2.5vw, 16px); color: #787774; line-height: 1.6; max-width: 580px; margin: 0 0 28px; }

        /* ── Step indicator ──────────────────────────────────────────────── */
        .hg-steps { display: flex; gap: 8px; align-items: center; margin-bottom: 24px; font-family: 'system-ui', sans-serif; font-size: 12px; color: #9b9b97; flex-wrap: wrap; }
        .hg-step { display: inline-flex; align-items: center; gap: 6px; }
        .hg-step .dot { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid #c0bfbb; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; color: #c0bfbb; font-weight: 600; }
        .hg-step.active .dot { border-color: #37352f; background: #37352f; color: #fff; }
        .hg-step.done .dot { border-color: #3d9970; background: #3d9970; color: #fff; }
        .hg-step.active .hg-step-label { color: #37352f; }
        .hg-step-sep { color: #d5d4cd; }

        /* ── Property rows ──────────────────────────────────────────────── */
        .hg-prop-row {
          display: flex; align-items: center; min-height: 40px; gap: 14px;
          border-radius: 4px; padding: 4px 6px; margin: 1px -6px;
          flex-wrap: wrap;
        }
        .hg-prop-row:hover { background: #f1f1ef; }
        .hg-prop-label { width: 170px; flex-shrink: 0; font-size: 13px; color: #787774; font-family: 'system-ui', sans-serif; }
        .hg-prop-control { flex: 1; min-width: 200px; font-size: 13px; color: #37352f; font-family: 'system-ui', sans-serif; }
        .hg-prop-hint { font-size: 11px; color: #c0bfbb; font-family: 'system-ui', sans-serif; }
        @media (max-width: 600px) {
          .hg-prop-label { width: 100%; margin-bottom: 2px; font-size: 12px; }
          .hg-prop-control { width: 100%; flex: 1 0 100%; min-width: 0; }
          .hg-prop-hint { width: 100%; margin-top: 2px; }
        }

        /* ── Sliders ─────────────────────────────────────────────────────── */
        input[type=range] { -webkit-appearance: none; appearance: none; background: #e9e9e7; border-radius: 2px; height: 3px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 9px; background: #37352f; cursor: pointer; }
        input[type=range]::-moz-range-thumb { width: 18px; height: 18px; border-radius: 9px; background: #37352f; cursor: pointer; border: none; }
        ::selection { background: #d4e8ff; }

        /* ── Drink grid ──────────────────────────────────────────────────── */
        .hg-drink-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(42px, 1fr)); gap: 5px; }
        .hg-slot {
          position: relative; aspect-ratio: 1; border-radius: 6px; border: 1px solid;
          font-family: 'system-ui', sans-serif; cursor: pointer; transition: all 0.1s;
          display: flex; align-items: center; justify-content: center;
          padding: 0; -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .hg-slot-badge {
          position: absolute; top: -6px; right: -6px;
          background: #c04040; color: #fff;
          font-size: 10px; font-weight: 600;
          border-radius: 9px; min-width: 18px; height: 18px; padding: 0 4px;
          display: flex; align-items: center; justify-content: center;
          font-family: 'system-ui', sans-serif;
          border: 1.5px solid #fbfbfa;
          font-variant-numeric: tabular-nums;
        }
        .hg-grid-legend { display: flex; gap: 14px; margin-top: 12px; font-size: 11px; color: #c0bfbb; flex-wrap: wrap; font-family: 'system-ui', sans-serif; }
        .hg-grid-help { margin-left: auto; }
        @media (max-width: 600px) { .hg-grid-help { margin-left: 0; width: 100%; } }

        /* ── Stat cards ──────────────────────────────────────────────────── */
        .hg-stat-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 36px; }
        @media (max-width: 600px) { .hg-stat-row { grid-template-columns: repeat(2, 1fr); } }
        .hg-stat-card {
          padding: 14px 16px; background: #fbfbfa; border: 1px solid #e9e9e7;
          border-radius: 8px; font-family: 'system-ui', sans-serif;
        }

        /* ── Score callout ──────────────────────────────────────────────── */
        .hg-score-callout {
          display: flex; align-items: center; gap: 16px;
          border-radius: 12px; padding: 16px 20px; margin-bottom: 32px;
          flex-wrap: wrap;
        }

        /* ── Results divider (between inputs and results) ───────────────── */
        .hg-results-divider {
          display: flex; align-items: center; gap: 16px;
          margin: 40px 0 24px;
          scroll-margin-top: 80px;
        }
        .hg-results-rule { flex: 1; height: 1px; background: #e9e9e7; }
        .hg-results-label {
          font-family: 'system-ui', sans-serif; font-size: 11px; font-weight: 600;
          letter-spacing: 0.18em; text-transform: uppercase; color: #9b9b97;
        }

        /* ── Tabs (chart selector) ──────────────────────────────────────── */
        .hg-tabs { display: flex; gap: 0; border-bottom: 1px solid #e9e9e7; margin-bottom: 16px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .hg-tab {
          background: none; border: none; padding: 8px 14px; font-size: 13px;
          cursor: pointer; font-family: 'system-ui', sans-serif; margin-bottom: -1px;
          transition: all 0.15s; white-space: nowrap; color: #9b9b97;
          border-bottom: 2px solid transparent;
        }
        .hg-tab.active { color: #37352f; border-bottom-color: #37352f; }

        /* ── Primary CTA button ─────────────────────────────────────────── */
        .hg-cta {
          width: 100%; padding: 18px; margin-top: 32px;
          background: #37352f; color: #fff;
          border: none; border-radius: 10px;
          font-family: 'system-ui', sans-serif; font-size: 16px; font-weight: 600;
          letter-spacing: -0.01em; cursor: pointer; transition: transform 0.1s, background 0.15s;
          display: flex; align-items: center; justify-content: center; gap: 10px;
          -webkit-tap-highlight-color: transparent;
        }
        .hg-cta:hover { background: #1a1a19; }
        .hg-cta:active { transform: scale(0.99); }
        .hg-cta-secondary {
          background: none; color: #787774; border: 1px solid #e9e9e7;
          font-weight: 500; padding: 12px;
        }
        .hg-cta-secondary:hover { background: #fbfbfa; color: #37352f; }

        /* ── Misc ─────────────────────────────────────────────────────── */
        .hg-section-title { font-family: 'system-ui', sans-serif; font-size: 13px; font-weight: 600; color: #37352f; letter-spacing: -0.01em; margin: 32px 0 8px; }
        .hg-warn-callout {
          font-family: 'system-ui', sans-serif; font-size: 12px; color: #c07030;
          background: #fdf8ee; border-radius: 6px; padding: 8px 12px; margin: 6px 0;
          border: 1px solid #f0e0b0; line-height: 1.4;
        }
        .hg-footer-note {
          border-top: 1px solid #e9e9e7; margin-top: 48px; padding: 24px 0 0;
          font-family: 'system-ui', sans-serif; font-size: 11px; color: #c0bfbb; line-height: 1.7;
        }
      `}</style>

      <div className="hg-content">
        {/* Title block — visible on both views */}
        <div className="hg-eyebrow">🧪 Science / Weekend Optimization</div>
        <h1 className="hg-title">Hangover Simulator</h1>
        <p className="hg-blurb">
          ODE-based model of BAC (Widmark + Michaelis–Menten elimination), acetaldehyde and
          congener inflammation, dehydration load, and sleep architecture disruption.
        </p>

        <Section title="Physiology" icon="🧬">
              <SliderProp label="Body weight" value={weightKg} min={45} max={130} onChange={setWeightKg}
                display={`${weightKg} kg`} hint={`${Math.round(weightKg * 2.205)} lb`} />
              <PropertyRow label="Sex" hint="affects Vd (volume of distribution)">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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

            <Section title="Drink schedule" icon="🍺">
              <PropertyRow label="Drink type">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {Object.entries(DRINK_TYPES).map(([k, v]) => (
                    <Tag key={k} active={drinkType === k} onClick={() => setDrinkType(k)}>{v.emoji} {v.label}</Tag>
                  ))}
                </div>
              </PropertyRow>
              <div style={{ marginTop: 14 }}>
                <DrinkGrid drinks={drinks} setDrinks={setDrinks} drinkType={drinkType} />
              </div>
              <div style={{ marginTop: 12, fontSize: 12, color: "#9b9b97", fontFamily: "'system-ui', sans-serif" }}>
                {result.drinkCount} drink{result.drinkCount !== 1 ? "s" : ""} · {result.totalGrams} g ethanol
                {drinks.length > 0 && ` · last at ${formatHour(Math.max(...drinks.map(d => d.hour)))}`}
              </div>
            </Section>

            <Section title="Modifiers" icon="⚗️">
              <PropertyRow label="Other substances" hint="select any · multi-toggle">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {[
                    { k: "none", label: "None" },
                    { k: "caffeine", label: "☕ Caffeine" },
                    { k: "nicotine", label: "🚬 Nicotine" },
                    { k: "adderall", label: "💊 Adderall" },
                    { k: "bag", label: "👜 Bag" },
                  ].map(({ k, label }) => {
                    const isActive = k === "none" ? substances.length === 0 : substances.includes(k);
                    return (
                      <Tag
                        key={k}
                        active={isActive}
                        onClick={() => {
                          if (k === "none") {
                            setSubstances([]);
                          } else {
                            setSubstances((prev) =>
                              prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]
                            );
                          }
                        }}
                        color={k === "none" ? "#37352f" : "#c04040"}
                        activeBg={k === "none" ? "#e3e3e0" : "#fde8e8"}
                      >
                        {label}
                      </Tag>
                    );
                  })}
                </div>
              </PropertyRow>
              {substances.length > 0 && (
                <div className="hg-warn-callout">
                  ⚠ {substances.length === 1 ? "Shifts" : `Stacking ${substances.length} stimulants compounds`} perceived bedtime later, slows ethanol elimination — BAC at sleep onset will be higher than expected
                </div>
              )}
          <PropertyRow label="Morning run" hint="−28% hangover score">
            <Toggle value={running} onChange={setRunning} />
          </PropertyRow>
        </Section>

        {/* Divider into the results region */}
        <div id="results" className="hg-results-divider">
          <span className="hg-results-rule" />
          <span className="hg-results-label">Results</span>
          <span className="hg-results-rule" />
        </div>

        {/* Score callout */}
        <div
          className="hg-score-callout"
          style={{ background: meta.bg, border: `1px solid ${meta.color}30` }}
        >
              <span style={{ fontSize: 36 }}>{meta.emoji}</span>
              <div>
                <div style={{ fontSize: 13, color: meta.color, fontFamily: "'system-ui', sans-serif", fontWeight: 500 }}>Predicted next-day outcome</div>
                <div style={{ fontSize: 28, fontWeight: 700, color: meta.color, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
                  {meta.label} <span style={{ fontSize: 18, opacity: 0.6 }}>({result.hangoverScore}/10)</span>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="hg-stat-row">
              <StatCard label="Peak BAC" value={`${result.maxBAC} g/dL`}
                sub={result.maxBAC > 0.08 ? "Above legal limit" : "Below legal limit"}
                warn={result.maxBAC > 0.08} good={result.maxBAC < 0.04} />
              <StatCard label="BAC at sleep" value={`${result.bacOnset} g/dL`}
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

            {/* Charts */}
            <div className="hg-section-title">📊 Charts</div>
            <div className="hg-tabs">
              {[
                { id: "bac", label: "BAC & AcAld" },
                { id: "rl", label: "RL Discounting" },
                { id: "sleep", label: "Sleep Architecture" },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setChartTab(t.id)}
                  className={`hg-tab ${chartTab === t.id ? "active" : ""}`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {chartTab === "bac" && (
              <div>
                <p style={{ fontSize: 12, color: "#9b9b97", marginBottom: 12, lineHeight: 1.5, fontFamily: "'system-ui', sans-serif" }}>
                  BAC computed via Widmark ODE with gamma-distributed absorption per drink type and
                  Michaelis–Menten elimination. Acetaldehyde follows first-order clearance.
                </p>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={result.timeline} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
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
                <p style={{ fontSize: 12, color: "#9b9b97", marginBottom: 12, lineHeight: 1.5, fontFamily: "'system-ui', sans-serif" }}>
                  Discount factor γ = 0.3 + 0.7·(BAC/0.15). As BAC rises, drunk-you weights immediate
                  fun heavily and discounts tomorrow's misery almost entirely.
                </p>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={result.timeline.filter(d => d.t <= bedtimeHr + 1)} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
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
                <p style={{ fontSize: 11, color: "#c0bfbb", marginTop: 8, fontStyle: "italic", fontFamily: "'system-ui', sans-serif" }}>
                  Gap between green and red = how much drunk-you overestimates the next drink
                </p>
              </div>
            )}

            {chartTab === "sleep" && (
              <div>
                <p style={{ fontSize: 12, color: "#9b9b97", marginBottom: 12, lineHeight: 1.5, fontFamily: "'system-ui', sans-serif" }}>
                  Dashed = ideal. Solid = alcohol-disrupted. SWS gets a small early boost
                  (anesthetic-like), then collapses in the back half. REM is suppressed early
                  and rebounds fragmented as BAC clears.
                </p>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={result.sleepData} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
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
                <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 12, flexWrap: "wrap", fontFamily: "'system-ui', sans-serif" }}>
                  <span style={{ color: result.SWS_disruption > 50 ? "#c07030" : "#9b9b97" }}>SWS loss: {result.SWS_disruption}%</span>
                  <span style={{ color: result.REM_disruption > 50 ? "#c07030" : "#9b9b97" }}>REM loss: {result.REM_disruption}%</span>
                  <span style={{ color: result.fragmentationScore > 60 ? "#c07030" : "#9b9b97" }}>Fragmentation: {result.fragmentationScore}%</span>
                </div>
              </div>
            )}

            <Section title="Model equations" icon="∂" defaultOpen={false}>
              <div style={{ fontFamily: "'Courier New', monospace", fontSize: 12, color: "#787774", lineHeight: 2, padding: "8px 0", overflowX: "auto" }}>
                <div>dBAC/dt = Σ absorption_i(t) − V·BAC/(K_m + BAC)</div>
                <div>dAcAld/dt = k_prod·(elim flux) − k_clear·AcAld</div>
                <div style={{ marginTop: 8 }}>V_max ≈ 0.017 g/dL/hr · K_m = 0.005</div>
                <div>Vd(♂) = 0.68 L/kg · Vd(♀) = 0.55 L/kg</div>
                <div>γ(t) = min(0.99, 0.3 + 0.7·BAC/0.15)</div>
                <div style={{ marginTop: 8 }}>H = 0.20·SWS + 0.20·REM + 0.20·Infl</div>
                <div>&nbsp;&nbsp;&nbsp;&nbsp;+ 0.20·Dehyd + 0.20·Frag</div>
                <div>SWS = σ(BAC_onset, μ=0.04, k=40)</div>
                <div>REM = 0.4·σ(BAC, 0.03) + 0.6·rebound</div>
                <div>Infl = 0.65·AcAld + 0.35·congener·dose</div>
                <div>Dehyd = min(1, total_g / 90)</div>
                <div>Frag = min(1, BAC_drop_rate / 0.025)</div>
              </div>
            </Section>

        <div className="hg-footer-note">
          Widmark BAC · Michaelis–Menten elimination · Gamma absorption · Acetaldehyde &amp; congener
          inflammation · Vasopressin-mediated dehydration · SWS suppression &amp; REM rebound · Sleep
          fragmentation · PFC-impairment discount factor · Nothing good happens after 2am.
        </div>
      </div>
    </div>
  );
}
