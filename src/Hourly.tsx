import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { ChartId, Item } from './store';
import { SegmentedControl } from '@mantine/core';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Hour } from './api';
import { darkSpans } from './sun';
import { compass, deg, feet, hourShort, inches, mph, pct, uvCategory, uvValue } from './format';

const HOUR = 3600e3;
const C1 = 'var(--s1)';
const C2 = 'var(--s2)';
const C3 = 'var(--s3)';

interface TipRow {
  name: string;
  value: string;
  color?: string;
}

interface Frame {
  data: Hour[];
  byT: Map<number, Hour>;
  xTicks: number[];
  midnights: number[];
  nights: [number, number][];
}

function useFrame(hours: Hour[], range: number, lat: number, lon: number): Frame {
  return useMemo(() => {
    const data = hours.slice(0, range + 1);
    const tMax = data[data.length - 1].t;
    const step = range <= 24 ? 3 : range <= 48 ? 6 : 24;
    // Shade the hours that are actually dark at this spot (civil dusk to civil dawn).
    const nights = darkSpans(data[0].t, tMax, lat, lon);
    return {
      data,
      byT: new Map(data.map((h) => [h.t, h])),
      xTicks: data.filter((h) => h.hr % step === 0).map((h) => h.t),
      midnights: data.filter((h) => h.hr === 0).map((h) => h.t),
      nights,
    };
  }, [hours, range, lat, lon]);
}

function niceTicks(lo: number, hi: number) {
  const span = hi - lo;
  const step = span <= 20 ? 5 : span <= 50 ? 10 : span <= 100 ? 20 : 50;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  return ticks;
}

function XTick({ x, y, payload, byT }: any) {
  const h: Hour | undefined = byT.get(payload.value);
  if (!h) return null;
  const midnight = h.hr === 0;
  return (
    <text x={x} y={y + 12} textAnchor="middle" className={midnight ? 'tick daylab' : 'tick'}>
      {midnight ? h.dow : hourShort(h.hr)}
    </text>
  );
}

function Tip({ active, label, byT, rows, head }: any) {
  const h: Hour | undefined = byT.get(label);
  if (!active || !h) return null;
  return (
    <div className="tip">
      <div className="tip-time">
        {h.label}
        {head ? <span> · {head(h)}</span> : null}
      </div>
      {(rows(h) as TipRow[]).map((r) => (
        <div className="tip-row" key={r.name}>
          <span className="key" style={{ background: r.color ?? 'transparent' }} />
          <b>{r.value}</b>
          <span>{r.name}</span>
        </div>
      ))}
    </div>
  );
}

interface PanelProps {
  title: string;
  legend?: { name: string; color: string }[];
  frame: Frame;
  data?: object[];
  domain: [number, number];
  yTicks: number[];
  yFormat?: (v: number) => string;
  rows: (h: Hour) => TipRow[];
  head?: (h: Hour) => string | undefined;
  children: ReactNode;
}

/** One chart card. All panels share a syncId, so hovering any of them moves the crosshair in all. */
function Panel({ title, legend, frame, data, domain, yTicks, yFormat, rows, head, children }: PanelProps) {
  return (
    <div className="card panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {legend && (
          <div className="legend">
            {legend.map((l) => (
              <span className="li" key={l.name}>
                <span className="key" style={{ background: l.color }} />
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="plot">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data ?? frame.data} syncId="hourly" margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            {frame.nights.map(([a, b]) => (
              <ReferenceArea key={a} x1={a} x2={b} fill="var(--night)" fillOpacity={1} stroke="none" />
            ))}
            {frame.midnights.map((t) => (
              <ReferenceLine key={t} x={t} stroke="var(--axis)" />
            ))}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={frame.xTicks}
              interval={0}
              tick={<XTick byT={frame.byT} />}
              tickLine={false}
              axisLine={{ stroke: 'var(--axis)' }}
              height={22}
            />
            <YAxis
              width={38}
              domain={domain}
              ticks={yTicks}
              tickFormatter={yFormat}
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              tickLine={false}
              axisLine={false}
              interval={0}
            />
            <Tooltip
              content={<Tip byT={frame.byT} rows={rows} head={head} />}
              cursor={{ stroke: 'var(--ink-2)', strokeWidth: 1 }}
              isAnimationActive={false}
              offset={14}
              wrapperStyle={{ zIndex: 5, pointerEvents: 'none', outline: 'none' }}
            />
            {children}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const lineProps = (color: string) => ({
  type: 'monotone' as const,
  stroke: color,
  strokeWidth: 2,
  dot: false,
  activeDot: { r: 4, stroke: 'var(--surface)', strokeWidth: 2, fill: color },
  isAnimationActive: false,
});

function extent(data: Hour[], keys: (keyof Hour)[]) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of data)
    for (const k of keys) {
      const v = h[k];
      if (typeof v === 'number') {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  return [lo, hi];
}

/** Rain and snow come as multi-hour totals, so they are drawn as one bar per forecast bucket. */
function buckets(data: Hour[], key: 'qpf' | 'snow') {
  const startKey = key === 'qpf' ? 'qpfStart' : 'snowStart';
  const tMax = data[data.length - 1].t;
  const out: { x1: number; x2: number; v: number }[] = [];
  let prev: number | undefined;
  for (const h of data) {
    const s = h[startKey];
    const v = h[key];
    if (s == null || v == null) {
      prev = undefined;
      continue;
    }
    if (s === prev) out[out.length - 1].x2 = Math.min(h.t + HOUR, tMax);
    else out.push({ x1: h.t, x2: Math.min(h.t + HOUR, tMax), v });
    prev = s;
  }
  return out.filter((b) => b.v > 0 && b.x2 > b.x1);
}

function Bar({ x, y, width, height, fill }: any) {
  // Inset so neighbouring buckets are separated by a gap; rounded at the top, square at the baseline.
  const gap = Math.min(3, width * 0.15);
  const w = Math.max(1, width - gap * 2);
  const x0 = x + gap;
  const r = Math.min(4, w / 2, height);
  return (
    <path
      d={`M${x0},${y + height}V${y + r}Q${x0},${y} ${x0 + r},${y}H${x0 + w - r}Q${x0 + w},${y} ${x0 + w},${y + r}V${y + height}Z`}
      fill={fill}
    />
  );
}

function AmountPanel({ frame, kind, title }: { frame: Frame; kind: 'qpf' | 'snow'; title: string }) {
  const bars = useMemo(() => buckets(frame.data, kind), [frame.data, kind]);
  if (!bars.length) return null;
  const rain = kind === 'qpf';
  const color = rain ? C1 : C2;
  const max = Math.max(...bars.map((b) => b.v));
  const top = [0.1, 0.2, 0.5, 1, 2, 4, 6, 10, 20, 40].find((t) => t >= max) ?? Math.ceil(max / 10) * 10;
  const hrsKey = rain ? 'qpfHrs' : 'snowHrs';
  return (
    <Panel
      title={title}
      frame={frame}
      domain={[0, top]}
      yTicks={[0, top / 2, top]}
      rows={(h) => [
        {
          name: `${rain ? 'precip' : 'snow'} over ${h[hrsKey] ?? 1} hr`,
          value: inches(h[kind], rain ? 2 : 1),
          color,
        },
        ...(h.snowLvl != null ? [{ name: 'snow level', value: feet(h.snowLvl) }] : []),
        ...(h.frzLvl != null ? [{ name: 'freezing level', value: feet(h.frzLvl) }] : []),
      ]}
    >
      {bars.map((b) => (
        <ReferenceArea key={b.x1} x1={b.x1} x2={b.x2} y1={0} y2={b.v} fill={color} shape={<Bar />} />
      ))}
      <Line dataKey={kind} stroke="none" dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
    </Panel>
  );
}

function HourlyTable({ data }: { data: Hour[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {['Time', 'Forecast', 'Temp', 'Feels', 'Dew pt', 'Precip', 'Cloud', 'Humidity', 'Wind', 'Gust', 'Rain', 'Snow', 'UV'].map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((h, i) => (
            <tr key={h.t} className={h.hr === 0 && i > 0 ? 'newday' : ''}>
              <td>{h.label}</td>
              <td>{h.short ?? ''}</td>
              <td>{deg(h.temp)}</td>
              <td>{deg(h.feels)}</td>
              <td>{deg(h.dew)}</td>
              <td>{pct(h.pop)}</td>
              <td>{pct(h.sky)}</td>
              <td>{pct(h.rh)}</td>
              <td>{h.dir != null ? `${compass(h.dir)} ` : ''}{mph(h.wind)}</td>
              <td>{mph(h.gust)}</td>
              <td>{h.qpf != null ? `${inches(h.qpf)} / ${h.qpfHrs}h` : '–'}</td>
              <td>{h.snow != null ? `${inches(h.snow, 1)} / ${h.snowHrs}h` : '–'}</td>
              <td>{uvValue(h.uv)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  hours: Hour[];
  lat: number;
  lon: number;
  source: 'nws' | 'openmeteo' | 'metno';
  charts: Item<ChartId>[];
}

export default function Hourly({ hours, lat, lon, source, charts }: Props) {
  const [range, setRange] = useState('48');
  const [tableOpen, setTableOpen] = useState(false);
  const hrs = Number(range);
  const frame = useFrame(hours, hrs, lat, lon);
  const { data } = frame;

  const [tLo, tHi] = extent(data, ['temp', 'feels']);
  const tempDomain: [number, number] = [Math.floor((tLo - 1) / 5) * 5, Math.ceil((tHi + 1) / 5) * 5];

  const windMax = extent(data, ['wind', 'gust'])[1];
  const windTop = Math.max(10, Math.ceil((windMax * 1.3) / 5) * 5);
  const arrowEvery = hrs <= 24 ? 2 : hrs <= 48 ? 4 : 12;
  const windData = useMemo(() => data.map((h) => ({ ...h, arrowY: windTop * 0.93 })), [data, windTop]);

  // Not every source has every series (no precip chance or gusts outside the US, UV only ~5 days out).
  const has = (k: keyof Hour) => data.some((h) => h[k] != null);
  const uvMax = extent(data, ['uv', 'uvClear'])[1];
  const uvTop = Math.max(3, Math.ceil(uvMax));
  const uvStep = uvTop <= 6 ? 1 : uvTop <= 12 ? 2 : 4;

  const hasAmounts = data.some((h) => (h.qpf ?? 0) > 0 || (h.snow ?? 0) > 0);
  // One "no rain or snow" note, after whichever of the two amount charts is shown last.
  const amountIds = charts.filter((c) => c.on && (c.id === 'rain' || c.id === 'snow')).map((c) => c.id);
  const showNoAmounts = (id: ChartId) => !hasAmounts && amountIds[amountIds.length - 1] === id;

  return (
    <>
      <div className="hourly-head">
        <h2>Hourly</h2>
        <SegmentedControl
          size="xs"
          value={range}
          onChange={setRange}
          data={[
            { label: '24 hours', value: '24' },
            { label: '48 hours', value: '48' },
            { label: '7 days', value: '168' },
          ]}
        />
      </div>

      <div className="charts">
        {charts.filter((c) => c.on).map((c) => {
          switch (c.id) {
            case 'temp':
              return (
                <Fragment key={c.id}>
                  <Panel
          title="Temperature (°F)"
          legend={[
            { name: 'Temperature', color: C1 },
            ...(has('feels') ? [{ name: 'Feels like', color: C2 }] : []),
          ]}
          frame={frame}
          domain={tempDomain}
          yTicks={niceTicks(...tempDomain)}
          yFormat={(v) => `${v}°`}
          head={(h) => h.short}
          rows={(h) => [
            { name: 'temperature', value: deg(h.temp), color: C1 },
            ...(has('feels') ? [{ name: 'feels like', value: deg(h.feels), color: C2 }] : []),
          ]}
        >
          <Line dataKey="feels" {...lineProps(C2)} />
          <Line dataKey="temp" {...lineProps(C1)} />
        </Panel>
                </Fragment>
              );
            case 'humidity':
              return (
                <Fragment key={c.id}>
                  <Panel
          title={has('pop') ? 'Precipitation chance, cloud cover, humidity (%)' : 'Cloud cover and humidity (%)'}
          legend={[
            ...(has('pop') ? [{ name: 'Chance of precip', color: C1 }] : []),
            { name: 'Cloud cover', color: C2 },
            { name: 'Humidity', color: C3 },
          ]}
          frame={frame}
          domain={[0, 100]}
          yTicks={[0, 25, 50, 75, 100]}
          rows={(h) => [
            ...(has('pop') ? [{ name: 'chance of precip', value: pct(h.pop), color: C1 }] : []),
            { name: 'cloud cover', value: pct(h.sky), color: C2 },
            { name: 'humidity', value: pct(h.rh), color: C3 },
          ]}
        >
          <Line dataKey="rh" {...lineProps(C3)} />
          <Line dataKey="sky" {...lineProps(C2)} />
          <Area dataKey="pop" {...lineProps(C1)} fill={C1} fillOpacity={0.12} />
        </Panel>
                </Fragment>
              );
            case 'rain':
              return (
                <Fragment key={c.id}>
                  <AmountPanel
          frame={frame}
          kind="qpf"
          title={source === 'nws' ? 'Rain (liquid precipitation, inches)' : 'Precipitation (rain or melted snow, inches)'}
        />
                  {showNoAmounts('rain') && <p className="panel-note">No measurable rain or snow in the forecast for this period.</p>}
                </Fragment>
              );
            case 'snow':
              return (
                <Fragment key={c.id}>
                  <AmountPanel frame={frame} kind="snow" title="Snowfall (inches)" />
                  {showNoAmounts('snow') && <p className="panel-note">No measurable rain or snow in the forecast for this period.</p>}
                </Fragment>
              );
            case 'wind':
              return (
                <Fragment key={c.id}>
                  <Panel
          title="Wind (mph)"
          legend={has('gust') ? [{ name: 'Sustained', color: C1 }, { name: 'Gusts', color: C2 }] : undefined}
          frame={frame}
          data={windData}
          domain={[0, windTop]}
          yTicks={niceTicks(0, windTop)}
          rows={(h) => [
            { name: h.dir != null ? `from ${compass(h.dir)}` : 'sustained', value: mph(h.wind), color: C1 },
            ...(has('gust') ? [{ name: 'gusts', value: mph(h.gust), color: C2 }] : []),
          ]}
        >
          <Line dataKey="gust" {...lineProps(C2)} />
          <Line dataKey="wind" {...lineProps(C1)} />
          {/* Direction arrows along the top, pointing the way the wind is blowing. */}
          <Line
            dataKey="arrowY"
            stroke="none"
            isAnimationActive={false}
            activeDot={false}
            legendType="none"
            dot={({ cx, cy, index, payload }: any) =>
              index % arrowEvery === 0 && payload.dir != null && cx != null ? (
                <path
                  key={index}
                  className="arrow"
                  d="M0,-6L4,5L0,2.5L-4,5Z"
                  transform={`translate(${cx},${cy}) rotate(${payload.dir + 180})`}
                />
              ) : (
                <g key={index} />
              )
            }
          />
        </Panel>
                </Fragment>
              );
            case 'uv':
              return has('uv') ? (
                <Fragment key={c.id}>
                  <Panel
            title="UV index"
            legend={[
              { name: 'Forecast', color: C1 },
              { name: 'If skies are clear', color: C2 },
            ]}
            frame={frame}
            domain={[0, uvTop]}
            yTicks={Array.from({ length: Math.floor(uvTop / uvStep) + 1 }, (_, i) => i * uvStep)}
            rows={(h) => [
              { name: uvCategory(h.uv) || 'forecast', value: uvValue(h.uv), color: C1 },
              { name: 'if skies are clear', value: uvValue(h.uvClear), color: C2 },
            ]}
          >
            <Line dataKey="uvClear" {...lineProps(C2)} />
            <Area dataKey="uv" {...lineProps(C1)} fill={C1} fillOpacity={0.12} />
          </Panel>
                </Fragment>
              ) : null;
            case 'table':
              return (
                <Fragment key={c.id}>
                  <details className="card table-card" onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Hourly table</summary>
        {tableOpen && <HourlyTable data={data} />}
      </details>
                </Fragment>
              );
          }
        })}
      </div>
    </>
  );
}
