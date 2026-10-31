import type { Calibration as Data } from "@viewport/core";

const SURE = ["Guessing", "Unsure", "Fairly sure", "Sure", "Certain"];
/** Fewer graded answers than this says nothing about calibration yet. */
const ENOUGH = 3;
const W = 340;
const H = 170;
const PAD = { top: 12, right: 8, bottom: 28, left: 36 };

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * How sure you said you were, against how often you were right. Each bar is the share
 * right at one confidence level; the dashed mark is where it would sit if your
 * confidence matched your results.
 */
export function Calibration({ data }: { data: Data }) {
  if (data.answers < ENOUGH) return null;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / 5;
  const barW = Math.min(28, slot * 0.5);
  const y = (v: number) => PAD.top + plotH * (1 - v);
  const sure = data.buckets.filter((b) => b.confidence >= 4);
  const sureN = sure.reduce((n, b) => n + b.answers, 0);
  const sureRight = sureN === 0 ? undefined : sure.reduce((n, b) => n + b.right * b.answers, 0) / sureN;
  const week = data.weeks.at(-1);

  return (
    <section className="calibration">
      <h2>How sure you were, and how right</h2>
      <p>
        {sureRight === undefined
          ? `From ${data.answers} graded answers over the last eight weeks.`
          : `When you said Sure or Certain, you were right ${pct(sureRight)} of the time (${sureN} answer${sureN === 1 ? "" : "s"}).`}
        {week && ` This week you felt ${pct(week.sure)} sure on average and were ${pct(week.right)} right.`}
      </p>
      <svg className="calibration-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Share of answers right at each confidence level">
        {[0, 0.5, 1].map((v) => (
          <g key={v} className="grid">
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end">
              {pct(v)}
            </text>
          </g>
        ))}
        {data.buckets.map((b, i) => {
          const cx = PAD.left + slot * i + slot / 2;
          const ideal = i / 4;
          const top = y(b.right);
          return (
            <g key={b.confidence} data-confidence={b.confidence}>
              <title>{b.answers === 0 ? `${SURE[i]}: no answers yet` : `${SURE[i]}: ${b.answers} answer${b.answers === 1 ? "" : "s"}, ${pct(b.right)} right`}</title>
              {/* A hit area as tall as the plot, so a short bar is still easy to hover. */}
              <rect className="hit" x={cx - slot / 2} y={PAD.top} width={slot} height={plotH} />
              {b.answers > 0 && (
                <path
                  className="bar"
                  d={`M${cx - barW / 2},${y(0)} V${Math.min(top + 4, y(0))} Q${cx - barW / 2},${top} ${cx - barW / 2 + 4},${top} H${cx + barW / 2 - 4} Q${cx + barW / 2},${top} ${cx + barW / 2},${Math.min(top + 4, y(0))} V${y(0)} Z`}
                />
              )}
              <line className="ideal" x1={cx - barW / 2 - 4} x2={cx + barW / 2 + 4} y1={y(ideal)} y2={y(ideal)} />
              <text className="axis" x={cx} y={H - 10} textAnchor="middle">
                {SURE[i]}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="muted legend">
        Bars: share right at each level, partial answers counting half. <span className="ideal-key">Dashes</span>: where a well-calibrated answer would sit.
      </p>
      <details>
        <summary>As a table</summary>
        <table className="calibration-table">
          <thead>
            <tr>
              <th>How sure</th>
              <th>Answers</th>
              <th>Right</th>
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((b, i) => (
              <tr key={b.confidence}>
                <td>{SURE[i]}</td>
                <td>{b.answers}</td>
                <td>{b.answers === 0 ? "–" : pct(b.right)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
