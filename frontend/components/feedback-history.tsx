"use client";

import { useEffect, useState } from "react";
import { fetchFeedbackHistory } from "../lib/feedback";
import type { FeedbackDecision, FeedbackRecord } from "../types/feedback";
import { Icon } from "./icons";

const decisionLabel: Record<FeedbackDecision, string> = {
  confirmed: "Confirmed",
  overturned: "Overturned",
  evidence_requested: "Evidence requested",
};

const actionLabel = (action: FeedbackRecord["agent_action"]) =>
  action === "auto_clear" ? "Auto-cleared" : "Human review";

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function countBy(records: FeedbackRecord[], decision: FeedbackDecision) {
  return records.filter((record) => record.decision === decision).length;
}

export function FeedbackHistoryPanel({ sessionLog }: { sessionLog: FeedbackRecord[] }) {
  const [backendHistory, setBackendHistory] = useState<FeedbackRecord[] | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    fetchFeedbackHistory().then((data) => {
      if (cancelled) return;
      if (data) {
        setBackendHistory(data);
        setStatus("loaded");
      } else {
        setStatus("unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLog.length]);

  const records = status === "loaded" && backendHistory ? backendHistory : sessionLog;
  const timeline = [...records].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return (
    <section className="control-card feedback-history" aria-labelledby="feedback-heading">
      <div className="control-heading">
        <div>
          <p className="eyebrow">04 · REVIEWER FEEDBACK</p>
          <h2 id="feedback-heading">Decision history</h2>
        </div>
        <span className="simulated-badge">
          {status === "loaded" ? "ALL-TIME · BACKEND" : status === "loading" ? "LOADING…" : "THIS SESSION ONLY"}
        </span>
      </div>

      <div className="metrics feedback-metrics" aria-label="Feedback summary">
        <FeedbackMetric value={records.length} label="Decisions logged" tone="dark" />
        <FeedbackMetric value={countBy(records, "confirmed")} label="Confirmed" tone="mint" />
        <FeedbackMetric value={countBy(records, "overturned")} label="Overturned" tone="coral" />
        <FeedbackMetric value={countBy(records, "evidence_requested")} label="Evidence requested" tone="amber" />
      </div>

      {timeline.length === 0 ? (
        <p className="upload-note">
          <Icon name="note" size={15} /> No reviewer decisions recorded yet. Confirm, overturn, or request evidence
          on a finding to start the log.
        </p>
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Case</th>
                  <th>Document</th>
                  <th>Agent action</th>
                  <th>Reviewer decision</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((record, index) => (
                  <tr key={`${record.case_id}-${record.document}-${record.timestamp}-${index}`}>
                    <td>
                      <small>{formatTime(record.timestamp)}</small>
                    </td>
                    <td>
                      <strong>{record.case_id}</strong>
                    </td>
                    <td>
                      <strong>{record.document}</strong>
                      <small>{record.finding}</small>
                    </td>
                    <td>
                      <span className={`action ${record.agent_action}`}>{actionLabel(record.agent_action)}</span>
                    </td>
                    <td>
                      <span className={`feedback-decision ${record.decision}`}>{decisionLabel[record.decision]}</span>
                    </td>
                    <td>
                      <small>{record.note || "—"}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {status === "unavailable" && (
        <p className="upload-note">
          <Icon name="check" size={15} /> Showing this session only — persistence API not reachable yet.
        </p>
      )}
    </section>
  );
}

function FeedbackMetric({ value, label, tone }: { value: number; label: string; tone: "dark" | "mint" | "amber" | "coral" }) {
  return (
    <div className={`metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
