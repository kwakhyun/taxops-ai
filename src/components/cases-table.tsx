"use client";

import Link from "next/link";
import { ChevronRight, Filter, Search } from "lucide-react";
import { useState } from "react";
import { StatusPill } from "@/components/status-pill";
import { TableViewport } from "@/components/table-viewport";
import { usePagedQuery } from "@/components/use-paged-query";
import { Pagination } from "@/components/pagination";
import type { PageResult } from "@/lib/contracts/listing";
import type { Matter, RiskLevel } from "@/lib/domain/types";

const riskFilters: Array<{ value: RiskLevel | "ALL"; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "HIGH", label: "높은 리스크" },
  { value: "MEDIUM", label: "보통" },
  { value: "LOW", label: "낮음" },
];

export function CasesTable({ initial }: { initial: PageResult<Matter> }) {
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<RiskLevel | "ALL">("ALL");

  const [page, setPage] = useState(1);
  const params = new URLSearchParams({
    q: query,
    risk,
    page: String(page),
  }).toString();
  const { result, loading, error, reload } = usePagedQuery(
    "/api/v1/cases",
    params,
    initial,
    "q=&risk=ALL&page=1",
  );
  const filtered = loading ? [] : result.items;

  return (
    <section className="card cases-card">
      <div className="cases-toolbar">
        <label className="field-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">세무 업무 검색</span>
          <input
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="고객사, 세목, 기간 검색"
          />
        </label>
        <div className="filter-group" aria-label="리스크 필터">
          <span className="filter-label">
            <Filter size={13} /> 리스크
          </span>
          {riskFilters.map((filter) => (
            <button
              key={filter.value}
              className={`filter-chip ${risk === filter.value ? "filter-chip-active" : ""}`}
              type="button"
              onClick={() => {
                setRisk(filter.value);
                setPage(1);
              }}
              aria-pressed={risk === filter.value}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className="result-count">
          {loading ? "조회 중" : `세무 업무 ${result.total}건`}
        </span>
      </div>

      {loading ? (
        <p className="listing-state" role="status">
          세무 업무를 조회하고 있습니다.
        </p>
      ) : error ? (
        <p className="listing-state" role="alert">
          {error}{" "}
          <button type="button" onClick={reload}>
            다시 시도
          </button>
        </p>
      ) : filtered.length ? (
        <TableViewport label="세무 업무 목록">
          <table className="data-table cases-table responsive-table">
            <thead>
              <tr>
                <th>세무 업무</th>
                <th>담당자 · 검토자</th>
                <th>상태</th>
                <th>리스크</th>
                <th>근거 사용 승인율</th>
                <th>마감일</th>
                <th>
                  <span className="sr-only">업무 열기</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((matter) => (
                <tr key={matter.id}>
                  <td className="record-primary" data-label="세무 업무">
                    <Link
                      className="case-identity"
                      href={`/cases/${matter.id}`}
                    >
                      <span className="case-logo">
                        {matter.client.slice(0, 1)}
                      </span>
                      <span className="table-primary">
                        <strong>{matter.client}</strong>
                        <span>
                          {matter.taxType} · {matter.period}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td data-label="담당자 · 검토자">
                    <span className="owner-pair">
                      <span>{matter.owner}</span>
                      <ChevronRight size={11} />
                      <span>{matter.reviewer}</span>
                    </span>
                  </td>
                  <td data-label="상태">
                    <StatusPill status={matter.status} />
                  </td>
                  <td data-label="리스크">
                    <StatusPill status={matter.risk} />
                  </td>
                  <td data-label="근거 사용 승인율">
                    <div className="coverage-cell">
                      <strong>{matter.evidenceCoverage}%</strong>
                      <div className="progress-track">
                        <div
                          className="progress-bar"
                          style={{ width: `${matter.evidenceCoverage}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td data-label="마감일">
                    <span className="due-date">{matter.dueDate}</span>
                  </td>
                  <td className="record-action" data-label="열기">
                    <Link
                      className="row-open"
                      href={`/cases/${matter.id}`}
                      aria-label={`${matter.client} 세무 업무 열기`}
                    >
                      <ChevronRight size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : (
        <div className="empty-state">
          <div>
            <span className="empty-state-icon">
              <Search size={21} />
            </span>
            <h3>조건에 맞는 세무 업무가 없습니다.</h3>
            <p>검색어나 리스크 필터를 변경해 주세요.</p>
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
    </section>
  );
}
