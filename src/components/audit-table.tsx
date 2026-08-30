"use client";

import { CheckCircle2, Download, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { TableViewport } from "@/components/table-viewport";
import type { AuditEvent } from "@/lib/domain/types";
import { auditActionLabel, auditOutcomeLabel } from "@/lib/ui/labels";
import {
  auditIpLabel,
  buildAuditCsv,
  filterAuditEvents,
  formatAuditTime,
} from "@/lib/ui/audit";

const filters = [
  { value: "ALL", label: "전체" },
  { value: "SUCCESS", label: "성공" },
  { value: "DENIED", label: "차단" },
  { value: "FAILED", label: "실패" },
] as const;

export function AuditTable({ events }: { events: AuditEvent[] }) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<AuditEvent["outcome"] | "ALL">("ALL");
  const filtered = useMemo(
    () => filterAuditEvents(events, query, outcome),
    [events, query, outcome],
  );
  function download() {
    const url = URL.createObjectURL(
      new Blob([buildAuditCsv(filtered)], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "taxops-audit.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <section className="card audit-table-card">
      <div className="cases-toolbar">
        <label className="field-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">감사 로그 검색</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="행위자, 작업, 대상, 추적 ID 검색"
          />
        </label>
        <div className="filter-group" aria-label="감사 결과 필터">
          {filters.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`filter-chip ${outcome === filter.value ? "filter-chip-active" : ""}`}
              aria-pressed={outcome === filter.value}
              onClick={() => setOutcome(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className="result-count" role="status">
          감사 기록 {filtered.length}건
        </span>
        <button
          className="button button-secondary button-compact"
          type="button"
          onClick={download}
          disabled={!filtered.length}
        >
          <Download size={15} aria-hidden="true" /> 검색 결과 내보내기
        </button>
      </div>
      {filtered.length ? (
        <TableViewport label="감사 기록 목록">
          <table className="data-table audit-table responsive-table">
            <thead>
              <tr>
                {[
                  "시각",
                  "행위자",
                  "작업",
                  "대상",
                  "결과",
                  "추적 ID",
                  "IP",
                  "해시",
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => (
                <tr key={event.id}>
                  <td data-label="시각">{formatAuditTime(event.occurredAt)}</td>
                  <td data-label="행위자">
                    <span className="audit-actor">
                      <span aria-hidden="true">{event.actor.slice(0, 1)}</span>
                      {event.actor}
                    </span>
                  </td>
                  <td data-label="작업">
                    <code className="action-code">
                      {auditActionLabel(event.action)}
                    </code>
                  </td>
                  <td data-label="대상">{event.target}</td>
                  <td data-label="결과">
                    <span
                      className={`audit-outcome audit-outcome-${event.outcome.toLocaleLowerCase()}`}
                    >
                      {event.outcome === "SUCCESS" ? (
                        <CheckCircle2 size={12} aria-hidden="true" />
                      ) : (
                        <ShieldCheck size={12} aria-hidden="true" />
                      )}
                      {auditOutcomeLabel(event.outcome)}
                    </span>
                  </td>
                  <td data-label="추적 ID">
                    <code className="trace-id">{event.traceId}</code>
                  </td>
                  <td data-label="IP">{auditIpLabel(event.ipMasked)}</td>
                  <td data-label="해시">
                    <code className="hash-code">
                      {event.prevHash} → {event.hash}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : (
        <div className="empty-state">
          <div>
            <h3>조건에 맞는 감사 기록이 없습니다.</h3>
            <p>검색어나 결과 필터를 변경해 주세요.</p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setQuery("");
                setOutcome("ALL");
              }}
            >
              검색 초기화
            </button>
          </div>
        </div>
      )}
      <div className="audit-footer">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>
          변경 및 삭제 작업은 데이터베이스 트리거로 차단됩니다. 감사 기록에는
          허용 목록과 개인정보 비식별 처리가 적용됩니다.
        </span>
      </div>
    </section>
  );
}
