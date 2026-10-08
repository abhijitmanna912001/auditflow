"use client";

import { useEffect, useState } from "react";
import { fetchFeedbackHistory } from "../lib/feedback";
import {
  actionLabel,
  caseDisplayName,
  findingLabel,
} from "../lib/display-labels";
import type { FeedbackRecord, StoredFeedbackDecision } from "../types/feedback";
import { Icon } from "./icons";

type HistoryStatus = "loading" | "loaded" | "unavailable";

const decisionLabel: Record<StoredFeedbackDecision, string> = {
  discarded: "Discarded",
  assigned: "Assigned",
  closed: "Closed",
  confirmed: "Earlier decision",
  overturned: "Earlier decision",
  evidence_requested: "Earlier decision",
};

function decisionText(record: FeedbackRecord) {
  const label = decisionLabel[record.decision] ?? "Earlier decision";
  if (record.decision === "assigned" && record.assignee) {
    return `${label} to ${record.assignee}`;
  }
  return label;
}

const statusBadge: Record<HistoryStatus, string> = {
  loaded: "ALL SAVED DECISIONS",
  loading: "LOADING…",
  unavailable: "THIS SESSION ONLY · NOT SAVED",
};

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

function countBy(records: FeedbackRecord[], decision: StoredFeedbackDecision) {
  return records.filter((record) => record.decision === decision).length;
}

interface FeedbackHistoryPanelProps {
  readonly sessionLog: FeedbackRecord[];
}

export function FeedbackHistoryPanel({ sessionLog }: FeedbackHistoryPanelProps) {
  const [backendHistory, setBackendHistory] = useState<FeedbackRecord[] | null>(null);
  const [status, setStatus] = useState<HistoryStatus>("loading");

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
          <p className="eyebrow">04 · REVIEW LOG</p>
          <h2 id="feedback-heading">Decision history</h2>
        </div>
        <span className="simulated-badge">{statusBadge[status]}</span>
      </div>

      <div className="metrics feedback-metrics" aria-label="Decision summary">
        <FeedbackMetric value={records.length} label="Decisions recorded" tone="dark" />
        <FeedbackMetric value={countBy(records, "discarded")} label="Discarded" tone="coral" />
        <FeedbackMetric value={countBy(records, "assigned")} label="Assigned" tone="amber" />
        <FeedbackMetric value={countBy(records, "closed")} label="Closed" tone="mint" />
      </div>

      {timeline.length === 0 ? (
        <p className="upload-note">
          <Icon name="note" size={15} /> No decisions recorded yet. Open a finding, write a note, then discard,
          assign or close it.
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
                  <th>AuditFlow result</th>
                  <th>Decision</th>
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
                      <strong>{caseDisplayName(record.case_id)}</strong>
                    </td>
                    <td>
                      <strong>{record.document}</strong>
                      <small>{findingLabel(record.finding)}</small>
                    </td>
                    <td>
                      <span className={`action ${record.agent_action}`}>{actionLabel(record.agent_action)}</span>
                    </td>
                    <td>
                      <span className={`feedback-decision ${record.decision}`}>{decisionText(record)}</span>
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
          <Icon name="check" size={15} /> Saved history isn&apos;t available right now. Showing this session&apos;s
          decisions only; they may not have been saved.
        </p>
      )}
    </section>
  );
}

interface FeedbackMetricProps {
  readonly value: number;
  readonly label: string;
  readonly tone: "dark" | "mint" | "amber" | "coral";
}

function FeedbackMetric({ value, label, tone }: FeedbackMetricProps) {
  return (
    <div className={`metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
