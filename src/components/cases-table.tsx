"use client";

import Link from "next/link";
import { ChevronRight, Filter, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusPill } from "@/components/status-pill";
import type { Matter, RiskLevel } from "@/lib/domain/types";

const riskFilters: Array<{ value: RiskLevel | "ALL"; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "HIGH", label: "높은 리스크" },
  { value: "MEDIUM", label: "보통" },
  { value: "LOW", label: "낮음" },
];

export function CasesTable({ matters }: { matters: Matter[] }) {
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<RiskLevel | "ALL">("ALL");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    return matters.filter((matter) => {
      const matchesRisk = risk === "ALL" || matter.risk === risk;
      const matchesQuery =
        !normalized ||
        `${matter.client} ${matter.taxType} ${matter.period}`
          .toLocaleLowerCase("ko-KR")
          .includes(normalized);
      return matchesRisk && matchesQuery;
    });
  }, [matters, query, risk]);

  return (
    <section className="card cases-card">
      <div className="cases-toolbar">
        <label className="field-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">케이스 검색</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="거래처, 세목, 기간 검색"
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
              onClick={() => setRisk(filter.value)}
              aria-pressed={risk === filter.value}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className="result-count">{filtered.length}개 케이스</span>
      </div>

      {filtered.length ? (
        <div className="table-wrap">
          <table className="data-table cases-table">
            <thead>
              <tr>
                <th>케이스</th>
                <th>담당 / 검토</th>
                <th>상태</th>
                <th>리스크</th>
                <th>근거 커버리지</th>
                <th>마감일</th>
                <th aria-label="열기" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((matter) => (
                <tr key={matter.id}>
                  <td>
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
                  <td>
                    <span className="owner-pair">
                      <span>{matter.owner}</span>
                      <ChevronRight size={11} />
                      <span>{matter.reviewer}</span>
                    </span>
                  </td>
                  <td>
                    <StatusPill status={matter.status} />
                  </td>
                  <td>
                    <StatusPill status={matter.risk} />
                  </td>
                  <td>
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
                  <td>
                    <span className="due-date">{matter.dueDate}</span>
                  </td>
                  <td>
                    <Link
                      className="row-open"
                      href={`/cases/${matter.id}`}
                      aria-label={`${matter.client} 케이스 열기`}
                    >
                      <ChevronRight size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <div>
            <span className="empty-state-icon">
              <Search size={21} />
            </span>
            <h3>조건에 맞는 케이스가 없습니다.</h3>
            <p>검색어나 리스크 필터를 변경해 주세요.</p>
          </div>
        </div>
      )}
    </section>
  );
}
