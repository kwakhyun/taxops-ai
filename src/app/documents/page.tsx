import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileArchive, ShieldCheck } from "lucide-react";
import { PageHeading } from "@/components/page-heading";
import { UploadPanel } from "@/components/upload-panel";
import { DocumentTable } from "@/components/document-table";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";
import { listDocuments, listMatters } from "@/lib/repository";

export const metadata: Metadata = { title: "자료 관리" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ matter?: string | string[] }> };

export default async function DocumentsPage({ searchParams }: Props) {
  const query = await searchParams;
  const requestedMatter =
    typeof query.matter === "string" ? query.matter : undefined;
  const user = await getSessionUser();
  const matters = await listMatters(user);
  const selectedMatter = requestedMatter
    ? matters.find((matter) => matter.id === requestedMatter)
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
        eyebrow="안전한 자료 처리"
        title="자료 관리"
        description={
          selectedMatter
            ? `${selectedMatter.client} 업무 자료의 보안 검사, 내용 추출, 검색 등록 상태를 확인합니다.`
            : "원본 파일의 보안 검사, 내용 추출, 검색 등록 상태와 보안 등급을 확인합니다."
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
              <span>검색 가능한 자료 구간</span>
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
              <span>검색 근거 승인율</span>
            </div>
          </div>
        </aside>
      </div>

      <nav className="filter-group" aria-label="자료를 연결할 세무 업무">
        <Link
          className={
            "filter-chip " + (!selectedMatter ? "filter-chip-active" : "")
          }
          href="/documents"
        >
          전체 자료
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
