import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeading } from "@/components/page-heading";
import { ReviewWorkspace } from "@/components/review-workspace";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";
import { listReviewRequests } from "@/lib/repository";

export const metadata: Metadata = { title: "검토·승인" };

export default async function ReviewsPage() {
  const user = await getSessionUser();
  if (!can(user, "workpaper:review")) notFound();
  const requests = await listReviewRequests(user);
  return (
    <>
      <PageHeading
        eyebrow="전문가 검토 체계"
        title="검토·승인"
        description="AI 초안의 근거와 계산을 확인하고, 1회용 승인 토큰으로 전문가 결정을 기록합니다."
      />
      <ReviewWorkspace requests={requests} reviewerName={user.name} />
    </>
  );
}
