"use client";

import { CheckCircle2, Download, Search, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { TableViewport } from "@/components/table-viewport";
import { usePagedQuery } from "@/components/use-paged-query";
import { Pagination } from "@/components/pagination";
import type { PageResult } from "@/lib/contracts/listing";
import type { AuditEvent } from "@/lib/domain/types";
import { auditActionLabel, auditOutcomeLabel } from "@/lib/ui/labels";
import { auditIpLabel, formatAuditTime } from "@/lib/ui/audit";

const filters = [
  { value: "ALL", label: "전체" },
  { value: "SUCCESS", label: "성공" },
  { value: "DENIED", label: "차단" },
  { value: "FAILED", label: "실패" },
] as const;

export function AuditTable({ initial }: { initial: PageResult<AuditEvent> }) {
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<AuditEvent["outcome"] | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const params = new URLSearchParams({ q: query, outcome, page: String(page) });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const { result, loading, error, reload } = usePagedQuery(
    "/api/v1/audit",
    params.toString(),
    initial,
    "q=&outcome=ALL&page=1",
  );
  const filtered = loading ? [] : result.items;
  async function download() {
    if (exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const response = await fetch(`/api/v1/audit?${params}&format=csv`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error?.message ?? "내보내기 실패");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "taxops-audit.csv";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "내보내기 실패");
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="card audit-table-card">
      <div className="cases-toolbar">
        <label className="field-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">감사 로그 검색</span>
          <input
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
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
              onClick={() => {
                setOutcome(filter.value);
                setPage(1);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className="result-count" role="status">
          {loading ? "조회 중" : `감사 기록 ${result.total}건`}
        </span>
        <button
          className="button button-secondary button-compact"
          type="button"
          onClick={download}
          disabled={loading || exporting || !result.total || Boolean(error)}
        >
          <Download size={15} aria-hidden="true" />{" "}
          {exporting ? "내보내는 중" : "검색 결과 내보내기"}
        </button>
      </div>
      <div className="listing-date-filters">
        <label>
          시작일
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => {
              setFrom(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          종료일
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => {
              setTo(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <span>한국 시간 기준 · 내보내기는 검색 결과 전체, 최대 10,000건</span>
      </div>
      {exportError ? <p role="alert">{exportError}</p> : null}
      {loading ? (
        <p className="listing-state" role="status">
          감사 기록을 조회하고 있습니다.
        </p>
      ) : error ? (
        <p className="listing-state" role="alert">
          {error}{" "}
          <button type="button" onClick={reload}>
            다시 시도
          </button>
        </p>
      ) : filtered.length ? (
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
                setFrom("");
                setTo("");
                setPage(1);
              }}
            >
              검색 초기화
            </button>
          </div>
        </div>
      )}
      <Pagination
        page={page}
        pageSize={result.pageSize}
        total={result.total}
        disabled={loading}
        onPageChange={setPage}
      />
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
