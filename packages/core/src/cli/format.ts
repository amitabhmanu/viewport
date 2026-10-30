import type { Decision, Model } from "../schema.js";
import type { VerificationReport } from "../verify/index.js";

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function formatModelSummary(model: Model): string {
  const count = (kind: string) => model.nodes.filter((n) => n.kind === kind).length;
  const sync = (s: string) => model.nodes.filter((n) => n.kind === "component" && n.sync === s).length;
  return [
    `Model r${model.revision}: ${plural(count("system"), "system")}, ${plural(count("container"), "container")}, ` +
      `${plural(count("component"), "component")}, ${plural(count("external"), "external")}, ${plural(model.edges.length, "edge")}`,
    `Components as of the last write: ${sync("ok")} ok, ${sync("stale")} stale, ${sync("unverified")} unverified`,
  ].join("\n");
}

export function formatReport(report: VerificationReport, limit = 10): string {
  const lines = [
    `Verification (${report.scope}, ${plural(report.files, "file")}, ${report.durationMs} ms): ` +
      [
        plural(report.unclaimed.length, "unclaimed file"),
        plural(report.doubleClaimed.length, "double-claimed file"),
        plural(report.missingDependencies.length, "missing dependency", "missing dependencies"),
        plural(report.unsupportedEdges.length, "unsupported edge"),
        plural(report.staleComponents.length, "component", "components") + " changed since modeled",
      ].join(", "),
  ];
  const list = <T>(label: string, items: T[], show: (t: T) => string) => {
    for (const item of items.slice(0, limit)) lines.push(`  ${label}: ${show(item)}`);
    if (items.length > limit) lines.push(`  …and ${items.length - limit} more ${label} findings`);
  };
  list("unclaimed", report.unclaimed, (f) => f);
  list("double-claimed", report.doubleClaimed, (d) => `${d.file} (${d.components.join(", ")})`);
  list("missing", report.missingDependencies, (d) => {
    const e = d.evidence[0];
    return `${d.from} -> ${d.to}${e ? ` (${e.file}:${e.line}${d.evidence.length > 1 ? ` +${d.evidence.length - 1}` : ""})` : ""}`;
  });
  list("unsupported", report.unsupportedEdges, (k) => k);
  list("changed since modeled", report.staleComponents, (id) => id);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

export function formatLedger(ledger: Decision[]): string {
  const last = ledger.at(-1);
  return `Ledger: ${plural(ledger.length, "decision")}${last ? ` (latest ${last.id}: ${last.title})` : ""}`;
}
