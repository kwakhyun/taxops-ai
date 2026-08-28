import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileArchive, ShieldCheck } from "lucide-react";
import { PageHeading } from "@/components/page-heading";
import { UploadPanel } from "@/components/upload-panel";
import { DocumentTable } from "@/components/document-table";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";
import { findMatter, listDocuments, listMatters } from "@/lib/repository";

export const metadata: Metadata = { title: "문서 보관함" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ matter?: string | string[] }> };

export default async function DocumentsPage({ searchParams }: Props) {
  const query = await searchParams;
  const requestedMatter =
    typeof query.matter === "string" ? query.matter : undefined;
  const user = await getSessionUser();
  const matters = await listMatters(user);
  const selectedMatter = requestedMatter
    ? await findMatter(user, requestedMatter)
    : undefined;
  if (requestedMatter && !selectedMatter) notFound();
  const documents = await listDocuments(user, selectedMatter?.id);
  const uploadMatterId = selectedMatter?.id;
  const indexedChunks = documents.reduce(
    (total, document) => total + document.chunks,
    0,
  );
  const approvedDocuments = documents.filter(
    (document) =>
      document.status === "INDEXED" && document.evidenceStatus === "APPROVED",
  ).length;
  const canReviewEvidence = can(user, "workpaper:review");

  return (
    <>
      <PageHeading
        eyebrow="보안 문서 처리 흐름"
        title="문서 보관함"
        description={
          selectedMatter
            ? `${selectedMatter.client} 케이스의 검역, 파싱, 청킹, 검색 인덱싱 상태를 추적합니다.`
            : "원본 파일의 검역, 파싱, 청킹, 검색 인덱싱 상태와 데이터 분류를 추적합니다."
        }
      />

      <div className="documents-layout">
        <UploadPanel
          matterId={uploadMatterId}
          canIngestAuthority={can(user, "authority:ingest")}
        />
        <aside className="ingestion-summary">
          <div>
            <span className="ingestion-icon">
              <FileArchive size={18} />
            </span>
            <div>
              <strong>{indexedChunks.toLocaleString("ko-KR")}</strong>
              <span>검색 가능한 chunks</span>
            </div>
          </div>
          <div>
            <span className="ingestion-icon ingestion-icon-green">
              <ShieldCheck size={18} />
            </span>
            <div>
              <strong>
                {documents.length
                  ? `${Math.round((approvedDocuments / documents.length) * 100)}%`
                  : "—"}
              </strong>
              <span>AI 근거 승인 비율</span>
            </div>
          </div>
        </aside>
      </div>

      <nav className="filter-group" aria-label="업로드 대상 케이스">
        <Link
          className={
            "filter-chip " + (!selectedMatter ? "filter-chip-active" : "")
          }
          href="/documents"
        >
          전체 문서
        </Link>
        {matters.map((matter) => (
          <Link
            className={
              "filter-chip " +
              (selectedMatter?.id === matter.id ? "filter-chip-active" : "")
            }
            href={"/documents?matter=" + matter.id}
            key={matter.id}
          >
            {matter.client}
          </Link>
        ))}
      </nav>

      <DocumentTable
        documents={documents}
        matters={matters}
        canReviewEvidence={canReviewEvidence}
      />
    </>
  );
}
