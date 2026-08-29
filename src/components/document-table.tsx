"use client";

import { FileSpreadsheet, FileText, Filter, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DocumentEvidenceAction } from "@/components/document-evidence-action";
import { StatusPill } from "@/components/status-pill";
import type { DocumentRecord, Matter } from "@/lib/domain/types";
import { dataClassLabel } from "@/lib/ui/labels";

type StatusFilter = "ALL" | "INDEXED" | "PROCESSING" | "FAILED";

const statusFilters: Array<{ value: StatusFilter; label: string }> = [
  { value: "ALL", label: "전체" },
  { value: "INDEXED", label: "검색 준비 완료" },
  { value: "PROCESSING", label: "처리 중" },
  { value: "FAILED", label: "실패" },
];

function matchesStatus(document: DocumentRecord, filter: StatusFilter) {
  if (filter === "ALL") return true;
  if (filter === "PROCESSING") {
    return ["QUARANTINED", "SCANNING", "PARSING"].includes(document.status);
  }
  return document.status === filter;
}

export function DocumentTable({
  documents,
  matters,
  canReviewEvidence,
}: {
  documents: DocumentRecord[];
  matters: Matter[];
  canReviewEvidence: boolean;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const matterNames = useMemo(
    () => new Map(matters.map((matter) => [matter.id, matter])),
    [matters],
  );
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    return documents.filter((document) => {
      const matter = matterNames.get(document.matterId);
      const searchable =
        `${document.name} ${document.kind} ${matter?.client ?? ""} ${matter?.taxType ?? ""}`.toLocaleLowerCase(
          "ko-KR",
        );
      return (
        matchesStatus(document, status) &&
        (!normalized || searchable.includes(normalized))
      );
    });
  }, [documents, matterNames, query, status]);

  return (
    <section className="card document-library">
      <div className="cases-toolbar">
        <label className="field-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">자료 검색</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="자료명, 고객사 검색"
          />
        </label>
        <div className="filter-group" aria-label="자료 처리 상태 필터">
          <span className="filter-label">
            <Filter size={13} aria-hidden="true" /> 상태
          </span>
          {statusFilters.map((filter) => (
            <button
              className={`filter-chip ${status === filter.value ? "filter-chip-active" : ""}`}
              type="button"
              key={filter.value}
              aria-pressed={status === filter.value}
              onClick={() => setStatus(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className="result-count">자료 {filtered.length}건</span>
      </div>

      {filtered.length ? (
        <div className="table-wrap">
          <table className="data-table library-table">
            <thead>
              <tr>
                <th>자료</th>
                <th>세무 업무</th>
                <th>상태</th>
                <th>보안 등급</th>
                <th>검색 근거</th>
                <th>검색 단위</th>
                <th>원본 파일 해시</th>
                <th>최근 변경</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((document) => {
                const Icon =
                  document.name.endsWith(".xlsx") ||
                  document.name.endsWith(".csv")
                    ? FileSpreadsheet
                    : FileText;
                const matter = matterNames.get(document.matterId);
                return (
                  <tr key={document.id}>
                    <td>
                      <div className="case-identity">
                        <span className="file-icon">
                          <Icon size={17} aria-hidden="true" />
                        </span>
                        <span className="table-primary">
                          <strong>{document.name}</strong>
                          <span>
                            {document.kind} · {document.size}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>
                      {matter
                        ? `${matter.client} · ${matter.taxType}`
                        : "현재 세무 업무"}
                    </td>
                    <td>
                      <StatusPill status={document.status} />
                    </td>
                    <td>
                      <span className="classification-chip">
                        {dataClassLabel(document.piiClass)}
                      </span>
                    </td>
                    <td>
                      <div className="evidence-review-cell">
                        <StatusPill status={document.evidenceStatus} />
                        {canReviewEvidence &&
                        document.evidenceReviewable &&
                        document.status === "INDEXED" &&
                        document.evidenceStatus === "PENDING" ? (
                          <DocumentEvidenceAction documentId={document.id} />
                        ) : null}
                      </div>
                    </td>
                    <td>
                      {document.chunks
                        ? `${document.chunks.toLocaleString("ko-KR")}개`
                        : "—"}
                    </td>
                    <td>
                      <code className="checksum">{document.checksum}</code>
                    </td>
                    <td>{document.updatedAt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <span className="empty-state-icon">
            <Search size={21} aria-hidden="true" />
          </span>
          <h3>조건에 맞는 자료가 없습니다.</h3>
          <p>검색어나 처리 상태 필터를 변경해 주세요.</p>
        </div>
      )}
    </section>
  );
}
