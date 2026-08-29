import type { Metadata } from "next";
import Link from "next/link";
import { Download, Plus } from "lucide-react";
import { CasesTable } from "@/components/cases-table";
import { PageHeading } from "@/components/page-heading";
import { getSessionUser } from "@/lib/auth/session";
import { listMatters } from "@/lib/repository";

export const metadata: Metadata = { title: "세무 업무" };
export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const user = await getSessionUser();
  const matters = await listMatters(user);
  return (
    <>
      <PageHeading
        eyebrow="세무 업무 관리"
        title="세무 업무"
        description="세목별 진행 상태, 세무 리스크, 근거 충족률과 승인 절차를 함께 관리합니다."
        actions={
          <>
            <button className="button button-secondary" type="button">
              <Download size={15} /> 목록 내보내기
            </button>
            <Link className="button button-primary" href="/cases/new">
              <Plus size={15} /> 새 업무
            </Link>
          </>
        }
      />
      <CasesTable matters={matters} />
    </>
  );
}
