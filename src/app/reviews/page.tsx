import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeading } from "@/components/page-heading";
import { ReviewWorkspace } from "@/components/review-workspace";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";
import { listReviewRequests } from "@/lib/repository";

export const metadata: Metadata = { title: "검토 및 승인" };

export default async function ReviewsPage() {
  const user = await getSessionUser();
  if (!can(user, "workpaper:review")) notFound();
  const requests = await listReviewRequests(user);
  return (
    <>
      <PageHeading
        eyebrow="전문가 검토 절차"
        title="검토 및 승인"
        description="AI 초안의 근거와 계산을 확인하고 검토 대상 버전을 고정한 뒤 승인 결과를 기록합니다."
      />
      <ReviewWorkspace requests={requests} reviewerName={user.name} />
    </>
  );
}
